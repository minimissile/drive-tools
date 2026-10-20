import { app, shell } from "electron";
import electronUpdater from "electron-updater";
import { CancellationToken } from "builder-util-runtime";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { UpdateManager, type UpdateDriver } from "../core/updates";
import { AppError } from "../core/errors";
import type { AppService } from "../core/service";
import type { UpdateState } from "../shared/updates";

export function createUpdater(
  service: AppService,
  changed: (state: UpdateState) => void,
  prepareInstall: (version: string) => Promise<boolean>,
  installFailed: () => void,
) {
  const config = JSON.parse(
    readFileSync(join(import.meta.dirname, "update-config.json"), "utf8"),
  ) as { repository: string | null; signed: boolean };
  const logFolder = join(app.getPath("userData"), "logs");
  const logPath = join(logFolder, "updater.log");
  const log = (event: string, detail: string) => {
    try {
      mkdirSync(logFolder, { recursive: true, mode: 0o700 });
      if (existsSync(logPath) && statSync(logPath).size > 512 * 1024)
        renameSync(logPath, `${logPath}.1`);
      appendFileSync(
        logPath,
        `${new Date().toISOString()} ${event} ${detail}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* Diagnostics must never prevent startup or updates. */
    }
  };
  const disabledReason = !app.isPackaged
    ? "开发模式不检查或安装更新，请使用已安装的发行版本。"
    : !config.repository
      ? "尚未配置官方更新仓库。"
      : !["darwin", "win32"].includes(process.platform)
        ? "当前系统暂不支持应用内更新。"
        : null;
  let driver: UpdateDriver | null = null;
  if (!disabledReason) {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableWebInstaller = true;
    // Upstream diagnostics may contain signed download URLs. Log only the
    // controller's bounded status codes and version strings instead.
    autoUpdater.logger = { info() {}, warn() {}, error() {}, debug() {} };
    let token: CancellationToken | null = null;
    driver = {
      async check() {
        const result = await autoUpdater.checkForUpdates();
        if (!result)
          throw new AppError(
            "UPDATE_CHECK_UNAVAILABLE",
            "更新检查未能启动，请重新打开应用后重试。",
          );
        return result.isUpdateAvailable ? result.updateInfo : null;
      },
      async download() {
        token = new CancellationToken();
        let timedOut = false;
        let idleTimer: ReturnType<typeof setTimeout>;
        const touch = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            timedOut = true;
            token?.cancel();
          }, 120000);
          idleTimer.unref();
        };
        autoUpdater.on("download-progress", touch);
        touch();
        try {
          await autoUpdater.downloadUpdate(token);
        } catch (error) {
          if (timedOut) throw new Error("ETIMEDOUT");
          throw error;
        } finally {
          clearTimeout(idleTimer!);
          autoUpdater.removeListener("download-progress", touch);
          token = null;
        }
      },
      cancel() {
        token?.cancel();
      },
      install() {
        autoUpdater.quitAndInstall(false, true);
      },
      listen(progress, error) {
        autoUpdater.on("download-progress", progress);
        // Keep an error listener installed for the lifetime of the updater.
        autoUpdater.on("error", error);
        return () => {
          autoUpdater.removeListener("download-progress", progress);
        };
      },
    };
  }
  log("started", `${app.getVersion()} ${process.platform} ${process.arch}`);
  return new UpdateManager({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    repository: config.repository,
    canInstall: config.signed && !disabledReason,
    disabledReason,
    driver,
    preferences: service.db.setting("updater.preferences", {}),
    savePreferences: (value) =>
      service.db.setSetting("updater.preferences", value),
    changed,
    log,
    prepareInstall,
    installFailed,
    openRelease: (url) => shell.openExternal(url),
    async openLogs() {
      mkdirSync(logFolder, { recursive: true, mode: 0o700 });
      const error = await shell.openPath(logFolder);
      if (error)
        throw new AppError("UPDATE_LOGS_UNAVAILABLE", "无法打开更新日志目录。");
    },
  });
}
