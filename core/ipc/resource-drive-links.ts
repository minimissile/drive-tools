import { z } from "zod";
import { id, now } from "../database";
import { AppError } from "../errors";
import { parseShare } from "../links";
import { assertResourceUnique } from "../resource-duplicates";
import { resourceTransferDirectory } from "../resource-records";
import {
  driveLinkCodeKey,
  readDriveSourceCode,
  readResourceDriveLinks,
} from "../resource-drive-links";
import { fileSchema } from "../../shared/schemas";
import type { HandlerMap, HandlerServices } from "./types";

const resourceTarget = z.object({ resourceId: z.string().min(1).max(100) });
const linkTarget = resourceTarget.extend({
  linkId: z.string().min(1).max(100),
});
const shareText = z.string().trim().min(1).max(8000);
const transferInput = resourceTarget.extend({
  text: shareText,
  replaceId: z.string().min(1).max(100).optional(),
  accountId: z.string().min(1).max(100),
  directory: z.string().max(500),
  selectedFiles: z.array(fileSchema).min(1).max(100),
});
const changed = () =>
  new AppError(
    "RESOURCE_DRIVE_LINK_CHANGED",
    "来源记录已变化，请重新读取分享。",
  );
function validCode(code: string) {
  if (code.length > 30 || /[\x00-\x20\x7f]/.test(code))
    throw new AppError(
      "INVALID_DRIVE_LINK_CODE",
      "提取码格式不正确，请核对分享文案。",
    );
  return code;
}

export function createResourceDriveLinkHandlers(
  services: Pick<
    HandlerServices,
    | "db"
    | "repo"
    | "secrets"
    | "resourceDeletion"
    | "queue"
    | "ports"
    | "changed"
  >,
) {
  const { db, repo, secrets, resourceDeletion } = services;
  const list = (resourceId: string) => readResourceDriveLinks(db, resourceId);
  const find = (resourceId: string, linkId: string) =>
    list(resourceId).find((link) => link.id === linkId);

  return {
    "resource.driveLinks": (input) => {
      const { resourceId } = resourceTarget.parse(input);
      repo.getResource(resourceId);
      return list(resourceId);
    },
    "resource.transferDriveLink": async (input) => {
      const {
        resourceId,
        text,
        replaceId,
        accountId,
        directory,
        selectedFiles,
      } = transferInput.parse(input);
      resourceDeletion.assertMutable(resourceId);
      const resource = repo.getResource(resourceId);
      const account = repo.getAccount(accountId);
      const share = parseShare(text);
      if (share.provider === resource.provider)
        throw new AppError(
          "SAME_DRIVE_LINK",
          "补充转存请选择主资源之外的网盘。",
        );
      if (share.provider !== account.provider)
        throw new AppError(
          "CROSS_PROVIDER_UNSUPPORTED",
          "请选择与外部分享相同网盘的账号。",
        );
      if (!account.enabled || !account.uid)
        throw new AppError("AUTH_EXPIRED", "请先连接并启用同网盘的本人账号。");
      const previous = list(resourceId).find(
        (link) => link.provider === share.provider,
      );
      if (previous?.copyId)
        throw new AppError(
          "RESOURCE_DRIVE_TRANSFER_EXISTS",
          "该网盘已有副本或转存任务，请查看原任务。",
        );
      if (previous?.id !== replaceId)
        throw new AppError(
          "RESOURCE_DRIVE_LINK_EXISTS",
          "该网盘已有待转存来源，请从已有记录继续。",
        );
      const code = validCode(
        share.code ||
          (previous && previous.url === share.url
            ? await readDriveSourceCode(secrets, {
                codeKey: driveLinkCodeKey(previous.id),
                needsCode: previous.needsCode,
              })
            : ""),
      );
      const linkId = id("drive-link"),
        copyId = id("copy"),
        jobId = id("job");
      const time = now();
      const target = resourceTransferDirectory(
        directory || account.defaultDirectory,
        resource.title,
        resource.id,
      );
      const uniqueness = {
        resourceId,
        sourceUrl: share.url,
        title: resource.title,
        provider: share.provider,
        accountId,
      };
      if (code) await secrets.set(driveLinkCodeKey(linkId), code);
      try {
        db.transaction(() => {
          resourceDeletion.assertMutable(resourceId);
          assertResourceUnique(db, uniqueness);
          const currentAccount = repo.getAccount(accountId);
          if (!currentAccount.enabled || currentAccount.uid !== account.uid)
            throw new AppError(
              "ACCOUNT_UID_MISMATCH",
              "目标账号状态已变化，请重新选择。",
            );
          const currentLink = list(resourceId).find(
            (link) => link.provider === share.provider,
          );
          if (currentLink?.id !== previous?.id || currentLink?.copyId)
            throw changed();
          if (previous) {
            db.run("DELETE FROM resource_drive_links WHERE id=?", previous.id);
            secrets.remove(driveLinkCodeKey(previous.id));
          }
          db.run(
            "INSERT INTO resource_drive_links(id,resource_id,provider,url,needs_code) VALUES(?,?,?,?,?)",
            linkId,
            resourceId,
            share.provider,
            share.url,
            code ? 1 : 0,
          );
          db.run(
            "INSERT INTO copies(id,resource_id,account_id,directory,selected_files,status,created_at,updated_at,source_link_id) VALUES(?,?,?,?,?,'queued',?,?,?)",
            copyId,
            resourceId,
            accountId,
            target,
            JSON.stringify(selectedFiles),
            time,
            time,
            linkId,
          );
          db.run(
            "INSERT INTO jobs(id,copy_id,stage,created_at,updated_at) VALUES(?,?,'queued',?,?)",
            jobId,
            copyId,
            time,
            time,
          );
        });
      } catch (error) {
        secrets.remove(driveLinkCodeKey(linkId));
        throw error;
      }
      services.changed();
      await services.ports.closeAccountWindow(accountId).catch(() => {});
      void services.queue.pump();
      return { copyId, jobId };
    },
    "resource.updateDriveSourceCode": async (input) => {
      const { resourceId, linkId, text } = linkTarget
        .extend({ text: shareText })
        .parse(input);
      resourceDeletion.assertMutable(resourceId);
      const link = find(resourceId, linkId);
      if (
        !link?.copyId ||
        !["failed", "needs_review", "waiting_login", "cancelled"].includes(
          link.status ?? "",
        )
      )
        throw changed();
      const parsed = parseShare(text);
      const code = validCode(parsed.code);
      if (parsed.url !== link.url || !code)
        throw new AppError(
          "INVALID_DRIVE_LINK_CODE",
          "请粘贴原来源同一链接和正确的提取码。",
        );
      // For an already-linked source the URL and record ID are immutable.
      await secrets.set(driveLinkCodeKey(linkId), code);
      if (!find(resourceId, linkId)) {
        secrets.remove(driveLinkCodeKey(linkId));
        throw changed();
      }
      db.run("UPDATE resource_drive_links SET needs_code=1 WHERE id=?", linkId);
      services.changed();
      return list(resourceId);
    },
    "resource.removeDriveLink": (input) => {
      const { resourceId, linkId } = linkTarget.parse(input);
      resourceDeletion.assertMutable(resourceId);
      db.transaction(() => {
        const link = find(resourceId, linkId);
        if (!link) throw changed();
        if (link.copyId)
          throw new AppError(
            "RESOURCE_DRIVE_TRANSFER_EXISTS",
            "此来源已用于转存任务，请在转存任务中管理。",
          );
        db.run(
          "DELETE FROM resource_drive_links WHERE id=? AND resource_id=?",
          linkId,
          resourceId,
        );
        secrets.remove(driveLinkCodeKey(linkId));
      });
      services.changed();
      return list(resourceId);
    },
  } satisfies HandlerMap;
}
