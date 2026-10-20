import { z } from "zod";
import { now } from "../database";
import { AppError } from "../errors";
import { csv } from "../csv";

import type { HandlerServices, HandlerMap, IpcHandler } from "./types";

export function createOperationsHandlers(
  services: Pick<
    HandlerServices,
    | "account"
    | "authenticated"
    | "changed"
    | "db"
    | "invoke"
    | "operations"
    | "ports"
    | "queue"
    | "repo"
  >,
) {
  const controlJobs: IpcHandler = async (object, method) => {
    const { id } = z.object({ id: z.string() }).parse(object),
      ids =
        method === "split.cancel"
          ? services.operations.splitJobs(id)
          : services.operations.batchJobs(id);
    for (const jobId of ids) {
      const job = services.repo.getJob(jobId);
      if (
        method === "batch.retry" &&
        ["failed", "waiting_login", "needs_review", "cancelled"].includes(
          job.stage,
        )
      )
        await services.invoke("job.retry", { id: jobId });
      else if (
        method !== "batch.retry" &&
        !["completed", "cancelled"].includes(job.stage)
      )
        await services.invoke("job.cancel", { id: jobId });
    }
    return true;
  };
  const exportSplitLinks: IpcHandler = async (object, method) => {
    const i = z
        .object({
          id: z.string(),
          itemIds: z.array(z.string()).min(1).max(100),
          includeCodes: z.boolean().default(false),
        })
        .parse(object),
      run = services.operations.split(i.id);
    if (i.itemIds.some((id) => !run.items.some((item) => item.id === id)))
      throw new AppError("INVALID_SELECTION", "拆分项不属于该预览。");
    const rows: (string | number)[][] = [
      ["路径", "标题", "本人网盘链接", "提取码"],
    ];
    for (const itemId of new Set(i.itemIds)) {
      const link = (await services.invoke("split.link", {
        itemId,
        includeCode: i.includeCodes,
      })) as { path: string; title: string; url: string; code: string };
      rows.push([link.path, link.title, link.url, link.code]);
    }
    if (method === "split.package")
      return {
        text: rows
          .slice(1)
          .map(
            (row) =>
              `${row[0]}\n${row[2]}${row[3] ? `\n提取码：${row[3]}` : ""}`,
          )
          .join("\n\n"),
      };
    return services.ports.saveFile(
      "本人拆分链接.csv",
      Buffer.from(csv(rows), "utf8"),
    );
  };
  return {
    "batch.candidates": async (object) => {
      const i = z
        .object({
          query: z.string().max(200).default(""),
          accountId: z.string().default("all"),
          page: z.number().int().min(1).max(100000).default(1),
        })
        .parse(object);
      return services.operations.candidates(i.query, i.accountId, i.page);
    },
    "batch.list": async () => {
      return services.operations.batches();
    },
    "batch.get": async (object) => {
      return services.operations.batch(
        z.object({ id: z.string() }).parse(object).id,
      );
    },
    "batch.preview": async (object) => {
      const { copyIds } = z
        .object({ copyIds: z.array(z.string()).min(1).max(100) })
        .parse(object);
      const result = services.operations.createBatch(copyIds);
      void services.queue.pump();
      return result;
    },
    "batch.selection": async (object) => {
      const i = z
        .object({ itemId: z.string(), fileIds: z.array(z.string()).max(100) })
        .parse(object);
      return services.operations.selectBatchItem(i.itemId, i.fileIds);
    },
    "batch.start": async (object) => {
      const i = z
        .object({
          id: z.string(),
          itemIds: z.array(z.string()).min(1).max(100),
          rightsConfirmed: z.literal(true),
        })
        .parse(object);
      const batch = services.operations.batch(i.id);
      for (const accountId of new Set(
        batch.items
          .filter((item) => i.itemIds.includes(item.id))
          .map((item) => item.accountId),
      ))
        await services.ports.closeAccountWindow(accountId);
      const result = services.operations.startBatch(i.id, i.itemIds);
      void services.queue.pump();
      return result;
    },
    "batch.cancel": controlJobs,
    "batch.retry": controlJobs,
    "split.cancel": controlJobs,
    "split.list": async (object) => {
      return services.operations.splits(
        z.object({ copyId: z.string() }).parse(object).copyId,
      );
    },
    "split.item": async (object) => {
      return services.operations.splitItem(
        z.object({ id: z.string() }).parse(object).id,
      );
    },
    "split.get": async (object) => {
      return services.operations.split(
        z.object({ id: z.string() }).parse(object).id,
      );
    },
    "split.preview": async (object) => {
      const i = z
        .object({
          copyId: z.string(),
          depth: z.number().int().min(1).max(3),
          mode: z.enum(["level", "all"]).default("level"),
        })
        .parse(object);
      const result = services.operations.createSplit(i.copyId, i.depth, i.mode);
      void services.queue.pump();
      return result;
    },
    "split.start": async (object) => {
      const i = z
          .object({
            id: z.string(),
            itemIds: z.array(z.string()).min(1).max(100),
            rightsConfirmed: z.literal(true),
          })
          .parse(object),
        run = services.operations.split(i.id);
      await services.ports.closeAccountWindow(
        services.repo.getCopy(run.copyId).accountId,
      );
      const result = services.operations.startSplit(i.id, i.itemIds);
      void services.queue.pump();
      return result;
    },
    "split.link": async (object) => {
      const i = z
          .object({
            itemId: z.string(),
            includeCode: z.boolean().default(true),
          })
          .parse(object),
        item = services.operations.splitItem(i.itemId);
      return services.authenticated(
        services.repo.getCopy(item.copyId).accountId,
        () => services.operations.splitLink(item.id, i.includeCode),
      );
    },
    "split.recover": async (object) => {
      const i = z
          .object({
            itemId: z.string(),
            text: z.string().min(1).max(8000),
            code: z.string().max(30).optional(),
          })
          .parse(object),
        item = services.operations.splitItem(i.itemId);
      if (
        item.jobId &&
        ["queued", "preflight", "verifying", "sharing", "archiving"].includes(
          services.repo.getJob(item.jobId).stage,
        )
      )
        throw new AppError(
          "JOB_RUNNING",
          "该拆分项仍在执行，请先停止本地等待。",
        );
      return services.authenticated(
        services.repo.getCopy(item.copyId).accountId,
        () => services.operations.recoverSplit(item.id, i.text, i.code),
      );
    },
    "split.package": exportSplitLinks,
    "split.export": exportSplitLinks,
    "job.retry": async (object) => {
      const { id: jobId } = z.object({ id: z.string() }).parse(object);
      const job = services.repo.getJob(jobId);
      if (
        !["waiting_login", "needs_review", "failed", "cancelled"].includes(
          job.stage,
        )
      )
        throw new AppError("JOB_RUNNING", "任务仍在运行或已完成。");
      services.account(job.accountId);
      await services.ports.closeAccountWindow(job.accountId);
      services.db.run(
        "UPDATE jobs SET stage=?,error=NULL,attempts=attempts+1,updated_at=? WHERE id=?",
        "queued",
        now(),
        jobId,
      );
      services.changed();
      void services.queue.pump();
      return true;
    },
    "job.cancel": async (object) => {
      const { id: jobId } = z.object({ id: z.string() }).parse(object);
      const job = services.repo.getJob(jobId);
      if (job.stage === "completed")
        throw new AppError("JOB_COMPLETED", "任务已完成，不需要取消。");
      services.db.run(
        "UPDATE jobs SET stage=?,error=?,updated_at=? WHERE id=?",
        "cancelled",
        "本地等待已停止，未撤销网盘已执行的操作。",
        now(),
        jobId,
      );
      if (job.kind === "transfer")
        services.db.run(
          "UPDATE copies SET status=?,error=? WHERE id=?",
          ["new", "folder_ready"].includes(job.checkpoint)
            ? "draft"
            : "needs_review",
          "请核对远端结果；不会自动删除文件。",
          job.copyId,
        );
      else services.operations.cancelled(job);
      services.changed();
      return true;
    },
  } satisfies HandlerMap;
}
