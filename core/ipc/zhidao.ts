import { z } from "zod";
import { id, now } from "../database";
import { AppError } from "../errors";
import { parseShare } from "../links";
import { normalizedDirectory } from "../providers/provider";
import { operationKinds, runStartInput } from "../../shared/zhidao";
import { keywordRows } from "../table-files";
import type { HandlerServices, HandlerMap } from "./types";

const identifier = z.string().min(1).max(100),
  objectId = z.object({ id: identifier });
const paging = z.number().int().min(1).max(100000).default(1);
export function createZhidaoHandlers(
  s: Pick<
    HandlerServices,
    | "driveFiles"
    | "zhidao"
    | "ports"
    | "repo"
    | "db"
    | "changed"
    | "authenticated"
    | "assertNoActiveJobs"
    | "saveResource"
    | "operations"
    | "queue"
    | "secrets"
  >,
) {
  return {
    "zhidao.summary": () => s.zhidao.summary(),
    "zhidao.settings": () => s.zhidao.settings(),
    "zhidao.settings.save": (input) =>
      s.zhidao.saveSettings(
        z.object({ pansouUrl: z.string().trim().max(300) }).parse(input)
          .pansouUrl,
      ),
    "zhidao.accounts": () => s.zhidao.store.accounts(),
    "zhidao.account.add": async (input) => {
      const v = z
        .object({
          alias: z.string().trim().min(1).max(60),
          cookie: z.string().trim().max(20000).optional(),
        })
        .parse(input);
      return s.zhidao.addAccount(v.alias, v.cookie);
    },
    "zhidao.account.update": (input) => {
      const v = z
        .object({ id: identifier, alias: z.string().trim().min(1).max(60) })
        .parse(input);
      s.zhidao.assertAccountIdle(v.id);
      return s.zhidao.store.saveAccount({
        ...s.zhidao.store.account(v.id),
        alias: v.alias,
      });
    },
    "zhidao.account.login": (input) => s.zhidao.login(objectId.parse(input).id),
    "zhidao.account.check": (input) => s.zhidao.check(objectId.parse(input).id),
    "zhidao.account.remove": (input) =>
      s.zhidao.removeAccount(
        z.object({ id: identifier, confirmed: z.literal(true) }).parse(input)
          .id,
      ),
    "zhidao.runs": (input) => {
      const v = z
        .object({ kind: z.enum(operationKinds).optional(), page: paging })
        .parse(input);
      return s.zhidao.store.list(v.kind, v.page);
    },
    "zhidao.run": (input) => {
      const v = z.object({ id: identifier, page: paging }).parse(input);
      return s.zhidao.store.detail(v.id, v.page);
    },
    "zhidao.start": (input) => s.zhidao.start(runStartInput.parse(input)),
    "zhidao.pause": (input) => s.zhidao.pause(objectId.parse(input).id),
    "zhidao.resume": (input) =>
      s.zhidao.resume(
        z.object({ id: identifier, authorized: z.literal(true) }).parse(input)
          .id,
      ),
    "zhidao.item.save": (input) => s.zhidao.saveItem(input),
    "zhidao.item.remove": (input) =>
      s.zhidao.removeItems(
        z.object({ ids: z.array(identifier).min(1).max(100) }).parse(input).ids,
      ),
    "zhidao.resolve": (input) => {
      const v = z
        .object({
          id: identifier,
          outcome: z.enum(["submitted", "retry"]),
          remoteId: z.string().trim().max(100).optional(),
          confirmed: z.literal(true),
        })
        .parse(input);
      return s.zhidao.resolve(v.id, v.outcome, v.remoteId);
    },
    "zhidao.export": (input) => {
      const v = z
        .object({ id: identifier, format: z.enum(["txt", "csv", "xlsx"]) })
        .parse(input);
      return s.zhidao.export(v.id, v.format);
    },
    "zhidao.import": async (input) => {
      const v = z
        .object({ kind: z.enum(["keywords", "resources"]) })
        .parse(input);
      if (!s.ports.readTable)
        throw new AppError("IMPORT_UNAVAILABLE", "请在桌面开发窗口导入文件。");
      const file = await s.ports.readTable(v.kind);
      if (file && v.kind === "keywords")
        file.rows = keywordRows(file.rows).map((v) => [v]);
      return file;
    },
    "zhidao.import.resources": (input) => {
      const v = z
        .object({
          rows: z.array(z.array(z.string().max(32767)).max(30)).max(501),
          authorized: z.literal(true),
        })
        .parse(input);
      return s.zhidao.importResources(v.rows);
    },
    "zhidao.mine.pool": (input) => {
      const v = z
        .object({
          id: identifier,
          itemIds: z.array(identifier).min(1).max(500),
          name: z.string().trim().min(1).max(100),
        })
        .parse(input);
      return s.zhidao.savePool(v.id, v.itemIds, v.name);
    },
    "zhidao.mine.words": (input) => {
      const v = z
        .object({
          id: identifier,
          itemIds: z.array(identifier).min(1).max(100),
        })
        .parse(input);
      const items = v.itemIds.map((id) => s.zhidao.store.item(id));
      if (
        s.zhidao.store.run(v.id).kind !== "mine" ||
        items.some((i) => i.runId !== v.id)
      )
        throw new AppError("INVALID_SELECTION", "请选择同一挖词任务的名称。");
      return items.map((i) => i.name);
    },
    "zhidao.targets": (input) => {
      const v = z
        .object({ query: z.string().trim().max(200).default(""), page: paging })
        .parse(input);
      return s.zhidao.targets(v.query, v.page);
    },
    "zhidao.templates": (input) =>
      s.zhidao.templatesPage(z.object({ page: paging }).parse(input).page),
    "zhidao.collect.transfer": async (input) => {
      const v = z
        .object({
          itemIds: z.array(identifier).min(1).max(100),
          accountId: identifier,
          directory: z.string().min(1).max(400),
          rightsConfirmed: z.literal(true),
        })
        .parse(input);
      s.assertNoActiveJobs(v.accountId);
      const items = [...new Set(v.itemIds)].map((id) =>
        s.zhidao.store.item(id),
      );
      if (
        items.some(
          (item) =>
            s.zhidao.store.run(item.runId).kind !== "collect" || !item.link,
        )
      )
        throw new AppError("INVALID_SELECTION", "请选择采集到的资源链接。");
      const selected: {
        item: (typeof items)[number];
        name: string;
        link: string;
        code: string;
        backup: boolean;
      }[] = [];
      await s.authenticated(v.accountId, async (account, provider) => {
        if (account.provider !== "baidu")
          throw new AppError(
            "BAIDU_REQUIRED",
            "采集到的百度网盘链接需要本人百度网盘账号。",
          );
        for (const item of items) {
          if (item.copyId) {
            selected.push({
              item,
              name: item.name,
              link: item.link,
              code: item.code,
              backup: false,
            });
            continue;
          }
          let picked = false;
          const failures: string[] = [];
          for (const candidate of [
            { name: item.name, link: item.link, code: item.code },
            ...item.backups,
          ]) {
            try {
              const source = parseShare(candidate.link, candidate.code);
              const inspection = await provider.inspect(account, source);
              if (!inspection.files.length)
                throw new AppError("EMPTY_SHARE", "分享没有可转存内容");
              selected.push({
                item,
                ...candidate,
                backup: candidate.link !== item.link,
              });
              picked = true;
              break;
            } catch (error) {
              if (
                error instanceof AppError &&
                [
                  "AUTH_EXPIRED",
                  "USER_ACTION_REQUIRED",
                  "QUOTA_EXCEEDED",
                ].includes(error.code)
              )
                throw error;
              failures.push(
                error instanceof Error ? error.message : "检查失败",
              );
            }
          }
          if (!picked)
            throw new AppError(
              "NO_VALID_SOURCE",
              `「${item.name}」主链接及备选检查失败：${failures.join("；")}`,
            );
        }
      });
      const copyIds: string[] = [];
      for (const choice of selected) {
        const old = choice.item.copyId
          ? s.repo.getCopy(choice.item.copyId)
          : null;
        if (old) {
          if (old.accountId !== v.accountId)
            throw new AppError(
              "TARGET_CHANGED",
              "此结果已交给其他账号，请从资源库处理已有副本。",
            );
          copyIds.push(old.id);
          continue;
        }
        const saved = await s.saveResource({
          title: choice.name,
          sourceText: choice.link,
          extractionCode: choice.code,
          category: "采集资源",
          tags: [],
          summary: choice.item.evidence || "",
          accountId: v.accountId,
          directory: normalizedDirectory(v.directory),
          rightsConfirmed: true,
          enqueue: false,
        });
        copyIds.push(saved.copyId);
        s.zhidao.store.put(choice.item.runId, choice.item.key, {
          copyId: saved.copyId,
          message: choice.backup
            ? "主链接不可用，已切换验活通过的备选并交给批量预检"
            : "已交给批量预检，请选择文件后开始转存",
        });
      }
      const batch = s.operations.createBatch(copyIds);
      void s.queue.pump();
      s.changed();
      return { copyIds, batchId: batch.id };
    },
    "zhidao.open": async (input) => {
      const { url } = z.object({ url: z.url().max(3000) }).parse(input);
      const u = new URL(url);
      if (u.protocol !== "https:" || u.username || u.password || u.port)
        throw new AppError("INVALID_URL", "只能打开有效 HTTPS 来源链接。");
      await s.ports.openExternal(u.href);
      return true;
    },
    "drive.files": (input) => {
      const v = z
        .object({ accountId: identifier, path: z.string().max(500) })
        .parse(input);
      return s.driveFiles.list(v.accountId, v.path);
    },
    "drive.manage": (input) => {
      const v = z
        .object({
          accountId: identifier,
          action: z.enum(["mkdir", "rename", "delete"]),
          path: z.string().min(1).max(500),
          name: z.string().trim().max(200).optional(),
          fileId: identifier.optional(),
          confirmed: z.literal(true),
        })
        .parse(input);
      return s.driveFiles.manage(v);
    },
    "drive.files.share": (input) => {
      const v = z
        .object({
          accountId: identifier,
          path: z.string().max(500),
          fileIds: z.array(identifier).min(1).max(100),
          rightsConfirmed: z.literal(true),
        })
        .parse(input);
      return s.driveFiles.share(v.accountId, v.path, v.fileIds);
    },
    "drive.share.reset": (input) => {
      const v = z
        .object({
          accountId: identifier,
          fileIds: z.array(identifier).min(1).max(100),
          confirmed: z.literal(true),
        })
        .parse(input);
      return s.driveFiles.reset(v.accountId, v.fileIds);
    },
  } satisfies HandlerMap;
}
