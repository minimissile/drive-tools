import { AppError } from "../../errors";
import { id } from "../../database";
import {
  publishInput,
  type OperationItem,
  type OperationRun,
} from "../../../shared/zhidao";
import { zhidaoTaskNameLimit } from "../../../shared/zhidao-publishing";
import {
  assertPublishingRights,
  publicationWorkbook,
  uploadReceipt,
} from "../publishing";
import { wait, type WorkerContext } from "./context";

export async function runPublish(
  ctx: WorkerContext,
  run: OperationRun,
  signal: AbortSignal,
) {
  // Runs created before batch uploads keep their original per-item checkpoints.
  const batch = run.config.uploadMode === "batch-v1";
  const input = publishInput.parse({
    ...run.config,
    ...(!batch
      ? { taskName: String(run.config.taskName).slice(0, zhidaoTaskNameLimit) }
      : {}),
  });
  const previous = ctx.store.items(run.id);
  if (previous.some((item) => item.status === "uncertain"))
    throw new AppError(
      "PUBLISH_RESULT_UNCERTAIN",
      "上传结果未知，请先核对原平台任务；整批结果核对完成前不会再次上传。",
    );
  const pendingIds = input.itemIds.filter(
    (sourceId) =>
      !previous.some(
        (item) => item.key === sourceId && item.status === "submitted",
      ),
  );
  if (!pendingIds.length) return;
  const identity = await ctx.identity(input.accountId);
  signal.throwIfAborted();
  const rights = await ctx.client.publishingRights(input.accountId);
  if (rights.uid && rights.uid !== identity.uid)
    throw new AppError(
      "ACCOUNT_UID_MISMATCH",
      "答主工作台身份与任务账号不一致，请重新登录检查。",
    );
  assertPublishingRights(rights, pendingIds.length);
  signal.throwIfAborted();
  ctx.validatePublication(pendingIds);
  ctx.assertNoDuplicatePublication(pendingIds, input.accountId);
  const groups = batch
    ? [pendingIds]
    : pendingIds.map((sourceId) => [sourceId]);
  for (const ids of groups) {
    signal.throwIfAborted();
    for (const sourceId of ids) {
      const source = ctx.store.item(sourceId);
      if (source.copyId) await ctx.verifyCopy?.(source.copyId);
      signal.throwIfAborted();
    }
    ctx.validatePublication(ids);
    ctx.assertNoDuplicatePublication(ids, input.accountId);
    const sources = ids.map((sourceId) => ctx.store.item(sourceId));
    // Build before marking anything as sent; local workbook errors cannot be uncertain submissions.
    const bytes = publicationWorkbook(sources);
    const batchId = id("upload");
    let items: OperationItem[] = [];
    ctx.repo.db.transaction(() => {
      items = sources.map((source) => {
        const existing = previous.find((item) => item.key === source.id);
        return ctx.store.put(run.id, source.id, {
          ...source,
          id: existing?.id ?? id("item"),
          runId: run.id,
          key: source.id,
          status: "pending",
          taskId: "",
          uploadBatchId: batchId,
          uploadBatchSize: sources.length,
          message: "",
        });
      });
    });
    const completed = ctx.store
      .items(run.id)
      .filter((item) => item.status === "submitted").length;
    ctx.progress(
      run,
      `正在上传${sources.length}条问答${batch ? "（合并为一份 Excel）" : ""}…`,
      completed,
    );
    const index = input.itemIds.indexOf(ids[0]) + 1;
    const suffix = `-${index}`;
    const taskName = batch
      ? input.taskName
      : input.taskName.slice(0, zhidaoTaskNameLimit - suffix.length) + suffix;
    ctx.repo.db.transaction(() =>
      items.forEach((item) => ctx.store.submitting(item)),
    );
    try {
      // Do not abort or retry a sent POST: retain a late receipt even after Stop.
      const response = await ctx.client.upload(
        input.accountId,
        taskName,
        bytes,
      );
      if (ctx.closed) return;
      const receipt = uploadReceipt(response);
      const status = receipt.taskId
        ? "submitted"
        : receipt.rejected
          ? "failed"
          : "uncertain";
      ctx.repo.db.transaction(() => {
        for (const item of items)
          ctx.store.put(run.id, item.key, {
            status,
            taskId: receipt.taskId,
            message: receipt.taskId
              ? `上传任务已创建（本批${items.length}条）；平台审核结果尚未确认`
              : receipt.rejected
                ? receipt.message
                : "上传结果未知，请在同一账号的答主工作台核对整批任务，避免重复上传",
          });
      });
      if (status !== "submitted")
        throw new AppError(
          status === "uncertain"
            ? "PUBLISH_RESULT_UNCERTAIN"
            : "UPLOAD_REJECTED",
          status === "uncertain"
            ? "平台未返回可确认的上传任务ID，请先核对整批上传结果。"
            : receipt.message,
        );
      ctx.progress(
        run,
        `已提交${completed + items.length}/${run.total}条，等待平台审核。`,
        completed + items.length,
      );
    } catch (error) {
      if (ctx.closed) return;
      ctx.repo.db.transaction(() => {
        for (const item of items) {
          if (
            ctx.repo.db.get<{ status: string }>(
              "SELECT status FROM operation_items WHERE id=?",
              item.id,
            )?.status === "submitting"
          )
            ctx.store.put(run.id, item.key, {
              status: "uncertain",
              message:
                "上传响应未确认，请在同一账号的答主工作台核对整批任务，避免重复上传",
            });
        }
      });
      if (items.some((item) => ctx.store.item(item.id).status === "uncertain"))
        throw new AppError(
          "PUBLISH_RESULT_UNCERTAIN",
          "上传响应未确认，已保留整批待核对记录；请核对平台结果后继续，避免重复上传。",
        );
      throw error;
    }
    if (!batch) await wait(ctx.pace, signal);
  }
}
