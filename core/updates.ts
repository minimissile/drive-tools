import { gt, prerelease, valid } from "semver";
import { z } from "zod";
import { AppError } from "./errors";
import type {
  UpdatePreferences,
  UpdateProgress,
  UpdateRelease,
  UpdateState,
} from "../shared/updates";

export interface UpdateCandidate {
  version: string;
  releaseNotes?: string | { version: string; note: string | null }[] | null;
  releaseDate?: string;
}
export interface UpdateDriver {
  check(): Promise<UpdateCandidate | null>;
  download(): Promise<void>;
  cancel(): void;
  install(): void;
  listen(
    progress: (value: UpdateProgress) => void,
    error: (error: unknown) => void,
  ): () => void;
}
interface UpdatePorts {
  version: string;
  platform: string;
  arch: string;
  repository: string | null;
  disabledReason: string | null;
  canInstall: boolean;
  driver: UpdateDriver | null;
  preferences: unknown;
  savePreferences(value: UpdatePreferences): void;
  changed(value: UpdateState): void;
  log(event: string, detail: string): void;
  prepareInstall(version: string): Promise<boolean>;
  installFailed(): void;
  openRelease(url: string): Promise<void>;
  openLogs(): Promise<void>;
  now?: () => number;
}
const preferenceSchema = z.object({
  autoCheck: z.boolean().default(true),
  skippedVersion: z.string().max(100).nullable().default(null),
  lastCheckedAt: z.iso.datetime().nullable().default(null),
});
const interval = 6 * 60 * 60 * 1000;
const safeNumber = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);

export function updateError(
  error: unknown,
  retry: "check" | "download" | "install",
): NonNullable<UpdateState["error"]> {
  const detail =
    error instanceof Error
      ? `${error.message} ${(error as NodeJS.ErrnoException).code ?? ""}`
      : "";
  // Never expose upstream URLs, local paths, response bodies or credentials.
  if (/sha512|checksum|signature|code.?sign|ERR_UPDATER_INVALID/i.test(detail))
    return {
      code: "UPDATE_VERIFICATION_FAILED",
      message:
        "更新包完整性或签名验证失败，已阻止安装。请重试或从官方发布页下载。",
      retry: "check",
    };
  if (/ENOSPC|disk space/i.test(detail))
    return {
      code: "UPDATE_DISK_FULL",
      message: "磁盘空间不足，请清理空间后重试。",
      retry,
    };
  if (/EACCES|EPERM|read.only|permission|applications folder/i.test(detail))
    return {
      code: "UPDATE_PERMISSION_DENIED",
      message: "应用或缓存目录不可写。请将盘序安装到本机可写目录后重试。",
      retry,
    };
  if (
    /404|latest.*not found|no published versions|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_NO_PUBLISHED_VERSIONS|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(
      detail,
    )
  )
    return {
      code: "UPDATE_NOT_PUBLISHED",
      message:
        "更新源尚无适用的正式版本，或发布文件不完整。可稍后重试或查看发布页。",
      retry: "check",
    };
  if (
    /timeout|ETIMEDOUT|ENOTFOUND|ECONN|network|net::|http|429|403|502|503/i.test(
      detail,
    )
  )
    return {
      code: "UPDATE_NETWORK_FAILED",
      message:
        "无法连接更新源，请检查网络后重试。GitHub 不可达时可从可访问的网络打开官方发布页。",
      retry,
    };
  if (error instanceof AppError && error.code.startsWith("UPDATE_"))
    return { code: error.code, message: error.message, retry };
  return {
    code: "UPDATE_FAILED",
    message: "更新操作未完成，请重试或从官方发布页下载安装。",
    retry,
  };
}

export class UpdateManager {
  private state: UpdateState;
  private checking: Promise<void> | null = null;
  private downloading: Promise<void> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private now: () => number;
  constructor(private ports: UpdatePorts) {
    this.now = ports.now ?? Date.now;
    const prefs = preferenceSchema.safeParse(ports.preferences);
    this.state = {
      ...(prefs.success ? prefs.data : preferenceSchema.parse({})),
      revision: 0,
      phase: ports.disabledReason ? "disabled" : "idle",
      currentVersion: ports.version,
      platform: ports.platform,
      arch: ports.arch,
      repository: ports.repository,
      canInstall: ports.canInstall,
      reason:
        ports.disabledReason ??
        (!ports.canInstall
          ? "此构建未启用签名更新安装，请从发布页下载安装包。"
          : null),
      release: null,
      progress: null,
      cancelRequested: false,
      error: null,
    };
    this.unsubscribe = ports.driver?.listen(
      (progress) => {
        if (this.state.phase !== "downloading" || this.disposed) return;
        this.patch({
          progress: {
            percent: Math.min(100, safeNumber(progress.percent)),
            total: safeNumber(progress.total),
            transferred: safeNumber(progress.transferred),
            bytesPerSecond: safeNumber(progress.bytesPerSecond),
          },
        });
      },
      (error) => {
        // check/download errors are handled by their promises. Installation errors
        // can arrive later from Squirrel.Mac or the Windows installer.
        if (this.state.phase === "installing" && !this.disposed)
          this.failInstall(error);
      },
    );
  }
  getState(): UpdateState {
    return structuredClone(this.state);
  }
  private patch(value: Partial<UpdateState>) {
    if (this.disposed) return;
    const previous = this.state.phase;
    this.state = { ...this.state, ...value, revision: this.state.revision + 1 };
    if (previous !== this.state.phase)
      this.ports.log(
        this.state.phase,
        this.state.error?.code ?? this.state.release?.version ?? "",
      );
    this.ports.changed(this.getState());
  }
  private persist(value: Partial<UpdatePreferences>) {
    const next = {
      autoCheck: this.state.autoCheck,
      skippedVersion: this.state.skippedVersion,
      lastCheckedAt: this.state.lastCheckedAt,
      ...value,
    };
    this.ports.savePreferences(next);
    this.patch(next);
  }
  start() {
    if (this.timer || this.state.phase === "disabled") return;
    this.startupTimer = setTimeout(() => this.launchCheck(false), 15000);
    this.startupTimer.unref();
    this.timer = setInterval(() => this.launchCheck(false), interval);
    this.timer.unref();
  }
  private launchCheck(manual = true) {
    void this.check(manual).catch((error) =>
      this.patch({ phase: "error", error: updateError(error, "check") }),
    );
  }
  async check(manual = true): Promise<void> {
    if (!this.ports.driver || this.state.phase === "disabled" || this.disposed)
      return;
    if (this.checking) return this.checking;
    if (
      this.downloading ||
      ["downloaded", "installing"].includes(this.state.phase)
    )
      return;
    if (
      !manual &&
      (!this.state.autoCheck ||
        (this.state.lastCheckedAt &&
          this.now() - Date.parse(this.state.lastCheckedAt) < interval))
    )
      return;
    this.persist({ lastCheckedAt: new Date(this.now()).toISOString() });
    this.patch({
      phase: "checking",
      error: null,
      progress: null,
      release: null,
    });
    this.checking = this.performCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  private async performCheck() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("ETIMEDOUT")), 45000);
        timer.unref();
      });
      const info = await Promise.race([this.ports.driver!.check(), deadline]);
      if (!info) {
        this.patch({ phase: "current" });
        return;
      }
      if (
        valid(info.version) !== info.version ||
        prerelease(info.version) ||
        info.version.includes("+") ||
        !gt(info.version, this.ports.version)
      )
        throw new AppError(
          "UPDATE_VERSION_REJECTED",
          "更新源返回了非正式版本或非递增版本，已阻止更新。",
        );
      const notes =
        typeof info.releaseNotes === "string"
          ? info.releaseNotes
          : (info.releaseNotes ?? [])
              .map((n) => `${n.version}\n${n.note ?? ""}`)
              .join("\n\n");
      const release: UpdateRelease = {
        version: info.version,
        notes: notes.slice(0, 12000),
        date:
          info.releaseDate && Number.isFinite(Date.parse(info.releaseDate))
            ? new Date(info.releaseDate).toISOString()
            : null,
      };
      this.patch({ phase: "available", release });
    } catch (error) {
      this.patch({ phase: "error", error: updateError(error, "check") });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async download(): Promise<void> {
    if (this.downloading) return this.downloading;
    this.assertDownloadReady();
    this.patch({
      phase: "downloading",
      error: null,
      progress: null,
      cancelRequested: false,
    });
    this.downloading = this.performDownload().finally(() => {
      this.downloading = null;
    });
    return this.downloading;
  }
  private assertDownloadReady() {
    if (
      this.disposed ||
      !this.ports.driver ||
      !this.state.canInstall ||
      !this.state.release ||
      !(
        this.state.phase === "available" ||
        (this.state.phase === "error" && this.state.error?.retry === "download")
      )
    )
      throw new AppError(
        "UPDATE_NOT_READY",
        "请先检查新版本，并使用支持签名安装的正式构建。",
      );
  }
  private async performDownload() {
    try {
      await this.ports.driver!.download();
      this.patch({
        phase: "downloaded",
        progress: null,
        cancelRequested: false,
      });
    } catch (error) {
      if (this.state.cancelRequested)
        this.patch({
          phase: "available",
          progress: null,
          cancelRequested: false,
          error: null,
        });
      else
        this.patch({
          phase: "error",
          progress: null,
          error: updateError(error, "download"),
        });
    }
  }
  cancel() {
    if (this.state.phase !== "downloading" || this.state.cancelRequested)
      return;
    this.patch({ cancelRequested: true });
    this.ports.driver!.cancel();
  }
  private failInstall(error: unknown) {
    this.ports.installFailed();
    this.patch({ phase: "error", error: updateError(error, "install") });
  }
  async install() {
    if (
      !this.state.canInstall ||
      !this.state.release ||
      !(
        this.state.phase === "downloaded" ||
        (this.state.phase === "error" && this.state.error?.retry === "install")
      )
    )
      throw new AppError("UPDATE_NOT_READY", "更新包尚未完成下载与校验。");
    this.patch({ phase: "installing", error: null });
    try {
      if (!(await this.ports.prepareInstall(this.state.release.version))) {
        this.patch({ phase: "downloaded" });
        return;
      }
      this.ports.driver!.install();
    } catch (error) {
      this.failInstall(error);
    }
  }
  async invoke(method: string, raw?: unknown): Promise<UpdateState> {
    if (method === "updater.configure") {
      if (this.state.phase === "installing")
        throw new AppError("UPDATE_INSTALLING", "正在准备重启，请稍候。");
      const value = z.object({ autoCheck: z.boolean() }).strict().parse(raw);
      this.persist(value);
      return this.getState();
    }
    z.undefined().parse(raw);
    switch (method) {
      case "updater.state":
        break;
      case "updater.check":
        this.launchCheck();
        break;
      case "updater.download":
        if (!this.downloading) this.assertDownloadReady();
        void this.download().catch((error) =>
          this.patch({ phase: "error", error: updateError(error, "check") }),
        );
        break;
      case "updater.cancel":
        this.cancel();
        break;
      case "updater.install":
        await this.install();
        break;
      case "updater.skip":
        if (this.state.phase !== "available" || !this.state.release)
          throw new AppError("UPDATE_NOT_READY", "当前没有可跳过的版本。");
        this.persist({ skippedVersion: this.state.release.version });
        break;
      case "updater.openRelease":
        if (!this.state.repository)
          throw new AppError("UPDATE_NOT_CONFIGURED", "尚未配置官方发布仓库。");
        await this.ports.openRelease(
          `https://github.com/${this.state.repository}/releases${this.state.release ? `/tag/v${encodeURIComponent(this.state.release.version)}` : ""}`,
        );
        break;
      case "updater.openLogs":
        await this.ports.openLogs();
        break;
      default:
        throw new AppError("UNKNOWN_METHOD", "不支持的更新操作。");
    }
    return this.getState();
  }
  dispose() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.disposed = true;
    if (this.downloading) this.ports.driver?.cancel();
    this.unsubscribe?.();
  }
}
