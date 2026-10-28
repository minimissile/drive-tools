import { providerSpecs } from "../../shared/providers";
import { z } from "zod";
import { now } from "../database";
import { AppError, safeMessage } from "../errors";
import { parseShare } from "../links";
import { assertManifest } from "../providers/provider";
import type { ShareCheck } from "../../shared/types";

import type { HandlerServices, HandlerMap, IpcHandler } from "./types";

export function createSharingHandlers(
  services: Pick<
    HandlerServices,
    | "account"
    | "assertNoActiveJobs"
    | "assertOwnCopy"
    | "authenticated"
    | "changed"
    | "checkShare"
    | "db"
    | "notes"
    | "ports"
    | "repo"
    | "secrets"
  >,
) {
  const restoreOwnShare: IpcHandler = async (object, method) => {
    const { copyId, text, code } = z
      .object({
        copyId: z.string(),
        text: z.string().max(8000).default(""),
        code: z.string().max(30).optional(),
      })
      .parse(object);
    const copy = services.repo.getCopy(copyId),
      resource = services.repo.getResource(copy.resourceId),
      source = text ? parseShare(text, code) : null;
    if (
      !copy.folderId ||
      !copy.ownerUid ||
      !copy.verifiedAt ||
      !copy.files.length ||
      (source &&
        ((source.url === resource.sourceUrl &&
          resource.sourceKind !== "owned") ||
          source.provider !== resource.provider)) ||
      (method === "copy.recoverShare" && !source)
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "请先完成目标文件核验，并填写本人新建的分享链接。",
      );
    services.assertNoActiveJobs(copy.accountId);
    return services.authenticated(copy.accountId, async (a, p) => {
      if (a.uid !== copy.ownerUid)
        throw new AppError("ACCOUNT_UID_MISMATCH", "文件归属UID不匹配。");
      const actual = await p.list(a, copy.folderId!);
      // Only the explicitly confirmed manifest participates in this share.
      // Other files in a user's existing directory must never be added implicitly.
      const scoped = actual.filter((file) =>
        copy.files.some((expected) => expected.id === file.id),
      );
      assertManifest(copy.files, scoped);
      if (
        scoped.length !== copy.files.length ||
        !copy.files.every((f) => scoped.some((c) => c.id === f.id))
      )
        throw new AppError(
          "TARGET_CHANGED",
          "目标文件发生变化，请先核对网盘目录。",
        );
      let share;
      try {
        share =
          method === "copy.createShare"
            ? await p.findOwnShare(a, copy.files)
            : await p.recoverOwnShare(a, source!, copy.files);
        if (!share) {
          services.db.run(
            "UPDATE jobs SET checkpoint=? WHERE copy_id=? AND kind='transfer' AND stage<>?",
            "share_requested",
            copy.id,
            "completed",
          );
          share = await p.createShare(a, copy.files, resource.title);
        }
      } catch (error) {
        services.db.run(
          "UPDATE copies SET error=? WHERE id=?",
          safeMessage(error),
          copyId,
        );
        services.db.run(
          "UPDATE jobs SET stage=?,error=? WHERE copy_id=? AND kind='transfer' AND stage<>?",
          "needs_review",
          safeMessage(error),
          copyId,
          "completed",
        );
        services.changed();
        throw error;
      }
      const parsedShare = parseShare(share.url);
      if (
        parsedShare.provider !== resource.provider ||
        (parsedShare.url === resource.sourceUrl &&
          resource.sourceKind !== "owned") ||
        !(await p.verifyShare(a, share.id, copy.files, share.code))
      )
        throw new AppError(
          "OWNERSHIP_UNVERIFIED",
          "本人分享仍未通过文件与有效性核验。",
        );
      if (
        share.ownerUid !== a.uid ||
        (source && parsedShare.url !== source.url)
      )
        throw new AppError("OWNERSHIP_UNVERIFIED", "本人分享归属核验失败。");
      const changedVersion =
        copy.shareId !== share.id ||
        copy.shareUrl !== parsedShare.url ||
        (await services.secrets.get(`share:${copyId}`)) !== share.code;
      await services.secrets.set(`share:${copyId}`, share.code);
      services.db.transaction(() => {
        services.db.run(
          "UPDATE copies SET status=?,share_id=?,share_url=?,share_owner_uid=?,share_version=share_version+?,share_verified_at=?,error=NULL WHERE id=?",
          "ready",
          share.id,
          parsedShare.url,
          a.uid,
          Number(changedVersion),
          now(),
          copyId,
        );
        services.db.run(
          "UPDATE jobs SET stage=?,checkpoint=?,error=NULL,updated_at=? WHERE copy_id=? AND kind='transfer' AND stage<>?",
          "completed",
          "complete",
          now(),
          copyId,
          "completed",
        );
        services.notes.enqueue(copyId);
      });
      await services.notes.flush();
      services.changed();
      return services.repo.getCopy(copyId);
    });
  };
  return {
    "share.parse": async (object) => {
      const { text, code } = z
        .object({
          text: z.string().max(8000),
          code: z.string().max(30).optional(),
        })
        .parse(object);
      return parseShare(text, code);
    },
    "share.open": async (object) => {
      const input = z
        .object({
          accountId: z.string(),
          sourceText: z.string().max(8000),
          code: z.string().max(30).optional(),
          resourceId: z.string().optional(),
        })
        .parse(object);
      const source = parseShare(input.sourceText, input.code);
      const account = services.account(input.accountId);
      if (account.provider !== source.provider)
        throw new AppError(
          "CROSS_PROVIDER_UNSUPPORTED",
          "请使用与分享相同网盘的本人账号。",
        );
      if (
        !source.code &&
        input.resourceId &&
        services.repo.getResource(input.resourceId).sourceUrl === source.url
      )
        source.code =
          (await services.secrets.get(`source:${input.resourceId}`)) ?? "";
      services.assertNoActiveJobs(account.id);
      const url = new URL(source.url);
      if (source.code)
        url.searchParams.set(
          source.provider === "guangya" ? "code" : "pwd",
          source.code,
        );
      await services.ports.openAccountPage(account, url.href);
      return true;
    },
    "share.inspect": async (object) => {
      const input = z
          .object({
            accountId: z.string(),
            sourceText: z.string().max(8000),
            code: z.string().max(30).optional(),
            resourceId: z.string().optional(),
            parentId: z.string().max(1000).default("0"),
            page: z.number().int().min(1).max(100).default(1),
            cursor: z.string().max(8000).optional(),
          })
          .parse(object),
        source = parseShare(input.sourceText, input.code);
      if (
        !source.code &&
        input.resourceId &&
        services.repo.getResource(input.resourceId).sourceUrl === source.url
      )
        source.code =
          (await services.secrets.get(`source:${input.resourceId}`)) ?? "";
      return services.authenticated(input.accountId, async (a, p) => {
        if (a.provider !== source.provider)
          throw new AppError(
            "CROSS_PROVIDER_UNSUPPORTED",
            "首版仅支持同网盘转存。",
          );
        return p.inspect(a, source, input.parentId, input.page, input.cursor);
      });
    },
    "directory.list": async (object) => {
      const { accountId, parentId } = z
        .object({ accountId: z.string(), parentId: z.string().max(1000) })
        .parse(object);
      return services.authenticated(accountId, async (a, p) =>
        (await p.list(a, parentId)).filter((f) => f.isDirectory),
      );
    },
    "copy.link": async (object) => {
      const { copyId } = z.object({ copyId: z.string() }).parse(object);
      const copy = services.repo.getCopy(copyId),
        account = services.assertOwnCopy(copy);
      await services.authenticated(account.id, async (a, p) => {
        if (!(await p.verifyShare(a, copy.shareId!, copy.files)))
          throw new AppError("SHARE_INVALID", "本人分享未能通过有效性检查。");
      });
      const code = await services.secrets.get(`share:${copy.id}`);
      return { text: `${copy.shareUrl}${code ? `\n提取码：${code}` : ""}` };
    },
    "copies.check": async (object) => {
      const { copyIds } = z
        .object({ copyIds: z.array(z.string()).min(1).max(25) })
        .parse(object);
      const results: ShareCheck[] = [];
      for (const copyId of new Set(copyIds))
        results.push(await services.checkShare(copyId));
      return results;
    },
    "copy.open": async (object) => {
      const { id: copyId } = z.object({ id: z.string() }).parse(object);
      const copy = services.repo.getCopy(copyId),
        resource = services.repo.getResource(copy.resourceId);
      services.assertNoActiveJobs(copy.accountId);
      let target = providerSpecs[resource.provider].home as string;
      if (copy.shareUrl) {
        const source = parseShare(
          copy.shareUrl,
          (await services.secrets.get(`share:${copy.id}`)) ?? "",
        );
        if (source.provider !== resource.provider)
          throw new AppError("INVALID_LINK", "本人分享与资源网盘不一致。");
        const url = new URL(source.url);
        if (source.code)
          url.searchParams.set(
            source.provider === "guangya" ? "code" : "pwd",
            source.code,
          );
        target = url.href;
      }
      await services.ports.openAccountPage(
        services.account(copy.accountId),
        target,
      );
      return true;
    },
    "copy.createShare": restoreOwnShare,
    "copy.recoverShare": restoreOwnShare,
  } satisfies HandlerMap;
}
