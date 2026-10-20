import {
  Download,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "./state";
import { Button, LoadingState, Notice, Panel, Status } from "./ui/primitives";
import { formatTime } from "./lib/format";
import type { UpdatePhase } from "../shared/updates";
import "./updates.css";
import { useUpdateRead, useUpdates } from "./updates-state";
import { QueryError } from "./ui/QueryError";

const phaseLabels: Record<UpdatePhase, string> = {
  disabled: "暂不可用",
  idle: "等待检查",
  checking: "正在检查",
  current: "已是最新版本",
  available: "发现新版本",
  downloading: "正在下载",
  downloaded: "等待安装",
  installing: "准备重启",
  error: "更新未完成",
};
const megabytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;
export function UpdatePanel() {
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity();
  const update = useUpdates();
  const read = useUpdateRead();
  if (!update)
    return (
      <Panel title="版本与更新">
        {read.error ? (
          <QueryError
            error={read.error}
            loading={read.loading}
            onRetry={read.reload}
            title="版本状态暂未读取成功"
            compact={false}
          />
        ) : (
          <LoadingState label="正在读取版本状态…" compact />
        )}
      </Panel>
    );
  const pending = ["checking", "downloading", "installing"].includes(
    update.phase,
  );
  const downloadReady =
    update.phase === "available" ||
    (update.phase === "error" && update.error?.retry === "download");
  const installReady =
    update.phase === "downloaded" ||
    (update.phase === "error" && update.error?.retry === "install");
  return (
    <Panel
      title="版本与更新"
      extra={
        <Status
          kind={
            update.phase === "error"
              ? "warning"
              : update.phase === "current" || update.phase === "downloaded"
                ? "good"
                : "normal"
          }
        >
          {phaseLabels[update.phase]}
        </Status>
      }
    >
      <div className="update-summary">
        <div>
          <strong>盘序 {update.currentVersion || data?.appVersion}</strong>
          <small>
            {update.platform === "darwin"
              ? "macOS"
              : update.platform === "win32"
                ? "Windows"
                : update.platform}{" "}
            · {update.arch} · 正式版通道
          </small>
        </div>
        <Button
          disabled={
            pending ||
            update.phase === "disabled" ||
            update.phase === "downloaded" ||
            busy > 0
          }
          onClick={() => void command("updater.check")}
        >
          <RefreshCw
            size={14}
            className={update.phase === "checking" ? "update-spin" : undefined}
          />
          {update.phase === "checking" ? "正在检查…" : "检查更新"}
        </Button>
      </div>
      <div className="update-options">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={update.autoCheck}
            disabled={
              update.phase === "disabled" ||
              update.phase === "installing" ||
              busy > 0
            }
            onChange={(e) =>
              void command("updater.configure", { autoCheck: e.target.checked })
            }
          />
          自动检查新版本
        </label>
        <small>
          {update.lastCheckedAt
            ? `上次检查 ${formatTime(update.lastCheckedAt)}`
            : "尚未检查"}{" "}
          · 下载和安装由你确认
        </small>
      </div>
      {update.reason ? <Notice>{update.reason}</Notice> : null}
      {update.error ? (
        <div role="alert">
          <Notice warning>
            {update.error.message}
            <small className="update-error-code">{update.error.code}</small>
          </Notice>
        </div>
      ) : null}
      {update.release ? (
        <div className="update-release">
          <div className="update-release-heading">
            <h3>新版本 {update.release.version}</h3>
            {update.release.date ? (
              <small>{formatTime(update.release.date)}</small>
            ) : null}
          </div>
          {update.release.notes ? (
            <pre className="update-notes">{update.release.notes}</pre>
          ) : (
            <p>此版本未提供更新说明，可前往官方发布页查看。</p>
          )}
          {update.phase === "downloading" ? (
            <div className="update-progress" aria-live="polite">
              <label htmlFor="update-download">
                {update.progress
                  ? `已下载 ${update.progress.percent.toFixed(0)}%`
                  : "正在准备下载…"}
              </label>
              <progress
                id="update-download"
                aria-label="更新下载进度"
                max={100}
                value={update.progress?.percent}
              />
              {update.progress ? (
                <small>
                  {megabytes(update.progress.transferred)} /{" "}
                  {megabytes(update.progress.total)} ·{" "}
                  {megabytes(update.progress.bytesPerSecond)}/s
                </small>
              ) : null}
            </div>
          ) : null}
          {update.phase === "downloaded" ? (
            <Notice>
              更新包已下载并通过完整性校验。安装时会验证系统签名；请保存编辑内容后重启。
            </Notice>
          ) : null}
          {update.phase === "installing" ? (
            <Notice>
              正在准备安装。请在系统对话框中确认重启，原工作空间会保留。
            </Notice>
          ) : null}
          <div className="row">
            {downloadReady && update.canInstall ? (
              <Button
                primary
                disabled={busy > 0}
                onClick={() => void command("updater.download")}
              >
                <Download size={14} />
                {update.error ? "重试下载" : "下载更新"}
              </Button>
            ) : null}
            {downloadReady ? (
              <Button
                disabled={
                  busy > 0 ||
                  update.skippedVersion === update.release.version ||
                  update.phase !== "available"
                }
                onClick={() => void command("updater.skip")}
              >
                {update.skippedVersion === update.release.version
                  ? "已跳过此版本提醒"
                  : "跳过此版本提醒"}
              </Button>
            ) : null}
            {update.phase === "downloading" ? (
              <Button
                disabled={update.cancelRequested || busy > 0}
                onClick={() => void command("updater.cancel")}
              >
                <X size={14} />
                {update.cancelRequested ? "正在取消…" : "取消下载"}
              </Button>
            ) : null}
            {installReady ? (
              <Button
                primary
                disabled={busy > 0}
                onClick={() => void command("updater.install")}
              >
                <RotateCw size={14} />
                重启并安装
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="update-footer">
        <small>
          {update.repository
            ? "更新包由 GitHub Releases 托管"
            : "等待配置官方发布仓库"}
          。更新仅查询版本信息。
        </small>
        <div className="row">
          <Button
            quiet
            disabled={!update.repository || busy > 0}
            onClick={() => void command("updater.openRelease")}
          >
            <ExternalLink size={13} />
            官方发布页
          </Button>
          <Button
            quiet
            disabled={busy > 0}
            onClick={() => void command("updater.openLogs")}
          >
            <FolderOpen size={13} />
            更新日志目录
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export function UpdateBanner() {
  const { navigate, page } = useAppNavigation();
  const update = useUpdates();
  if (
    !update?.release ||
    page === "settings" ||
    !["available", "downloading", "downloaded"].includes(update.phase) ||
    (update.phase === "available" &&
      update.skippedVersion === update.release.version)
  )
    return null;
  return (
    <div className="update-banner" role="status">
      <span>
        {update.phase === "downloaded"
          ? `盘序 ${update.release.version} 已下载，等待重启安装`
          : update.phase === "downloading"
            ? `正在下载盘序 ${update.release.version}${update.progress ? ` · ${update.progress.percent.toFixed(0)}%` : ""}`
            : `盘序 ${update.release.version} 已发布`}
      </span>
      <Button quiet onClick={() => navigate("settings")}>
        查看更新
      </Button>
    </div>
  );
}
