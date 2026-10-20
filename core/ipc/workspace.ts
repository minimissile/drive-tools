import { z } from "zod";
import { id } from "../database";
import { inspectBackup, stageRestore } from "../backups";
import { AppError } from "../errors";
import type { BackupPreview } from "../../shared/types";
import { platformSpecs } from "../../shared/platforms";

import type { HandlerServices, HandlerMap } from "./types";

export function createWorkspaceHandlers(
  services: Pick<
    HandlerServices,
    | "backup"
    | "dataPath"
    | "db"
    | "hasRunningJobs"
    | "ports"
    | "setSwitchingWorkspace"
    | "snapshot"
  >,
) {
  let backupPreview: (BackupPreview & { hash: string }) | null = null;

  return {
    snapshot: async (object) => {
      return services.snapshot(
        z.object({ resourceId: z.string().max(100).optional() }).parse(object)
          .resourceId,
      );
    },
    "system.copyText": async (object) => {
      const { text } = z.object({ text: z.string().max(100000) }).parse(object);
      await services.ports.copyText(text);
      return true;
    },
    "system.dataFolder": async () => {
      await services.ports.openPath(services.dataPath);
      return true;
    },
    "system.backup": async () => {
      return services.backup();
    },
    "system.backupPreview": async () => {
      const folder = await services.ports.chooseDirectory("restore");
      if (!folder) return null;
      const checked = await inspectBackup(folder);
      const preview: BackupPreview = {
        token: id("restore"),
        folder,
        createdAt: checked.createdAt,
        resources: checked.resources,
        accounts: checked.accounts,
        drafts: checked.drafts,
        covers: checked.covers.length,
      };
      backupPreview = { ...preview, hash: checked.databaseSha256 };
      return preview;
    },
    "system.restore": async (object) => {
      const { token } = z
        .object({ token: z.string(), confirmed: z.literal(true) })
        .parse(object);
      if (!backupPreview || backupPreview.token !== token)
        throw new AppError(
          "RESTORE_PREVIEW_REQUIRED",
          "请先选择备份并完成预检。",
        );
      if (services.hasRunningJobs())
        throw new AppError(
          "JOBS_RUNNING",
          "请先停止当前任务并核对远端结果，再恢复工作空间。",
        );
      const preview = backupPreview;
      backupPreview = null;
      services.setSwitchingWorkspace(true);
      try {
        const restored = await stageRestore(
          preview.folder,
          services.dataPath,
          preview.hash,
        );
        await services.ports.activateDataPath(restored.dataPath);
        return restored;
      } catch (error) {
        services.setSwitchingWorkspace(false);
        throw error;
      }
    },
    "system.previousWorkspace": async () => {
      const previous = services.db.setting<string>(
        "restorePreviousDataPath",
        "",
      );
      if (!previous)
        throw new AppError("NOT_FOUND", "当前没有恢复前的工作空间。");
      if (services.hasRunningJobs())
        throw new AppError("JOBS_RUNNING", "请先停止任务后再切换工作空间。");
      services.setSwitchingWorkspace(true);
      try {
        await services.ports.activateDataPath(previous);
      } catch (error) {
        services.setSwitchingWorkspace(false);
        throw error;
      }
      return true;
    },
    "system.external": async (object) => {
      const { url } = z.object({ url: z.url().max(2000) }).parse(object);
      const u = new URL(url);
      const allowed = [
        "www.5118.com",
        "account.5118.com",
        "openrouter.ai",
        "doc.bitbrowser.cn",
        "www.bitbrowser.cn",
        ...platformSpecs.flatMap((p) => [new URL(p.ruleUrl).hostname]),
      ];
      if (
        u.protocol !== "https:" ||
        !allowed.includes(u.hostname) ||
        u.username ||
        u.password
      )
        throw new AppError(
          "EXTERNAL_URL_BLOCKED",
          "此外部地址未在应用允许列表内。",
        );
      await services.ports.openExternal(url);
      return true;
    },
  } satisfies HandlerMap;
}
