import { ExternalLink, Pause, Play, RefreshCw } from "lucide-react";
import type { DistributionPlatformSummary } from "../../shared/distribution";
import { ipc } from "../api/client";
import { Button, Notice, Panel, Status } from "../ui/primitives";
import type { DistributionModel } from "./useDistribution";

const runNames = {
  idle: "尚未准备",
  scanning: "正在准备",
  ready: "准备就绪",
  running: "分发中",
  waiting_verification: "等待打码",
  pausing: "正在暂停",
  paused: "已暂停",
  blocked: "需要处理",
  completed: "本轮已结束",
};
export function PlatformProgress({
  item,
  model,
  onReview,
}: {
  item: DistributionPlatformSummary;
  model: DistributionModel;
  onReview(): void;
}) {
  const waiting = item.run.state === "waiting_verification";
  const websiteVerification = item.platform.manualVerification !== true;
  const running = [
    "scanning",
    "running",
    "pausing",
    "waiting_verification",
  ].includes(item.run.state);
  const unverified = item.platform.format === "unverified";
  const needsPreparation = item.readiness?.status !== "ready";
  const canStart =
    !needsPreparation && item.pending > 0 && !item.uncertain && !running;
  const needsAttention =
    item.uncertain > 0 ||
    item.failed > 0 ||
    item.blocked > 0 ||
    unverified ||
    item.run.state === "blocked" ||
    (item.readiness && needsPreparation);
  const message = waiting
    ? websiteVerification
      ? "请在官网窗口完成安全验证，官网随后会继续提交。"
      : "请在验证码窗口输入验证码，再点击“提交本批”。"
    : item.uncertain
      ? `有 ${item.uncertain} 条提交结果待核对，核对后才能继续分发。`
      : unverified
        ? "该平台投稿要求待登录确认，暂时无法自动分发。"
        : needsPreparation && item.readiness
          ? item.readiness.message
          : running || item.run.state === "blocked"
            ? item.run.message
            : item.readiness && !item.pending
              ? item.failed
                ? "部分链接分发失败，可重试失败项。"
                : item.blocked
                  ? "部分分享尚未就绪，请在资源库补全后更新链接。"
                  : item.total
                    ? "当前没有待分发的链接，新增分享后可更新链接。"
                    : "还没有可分发的本人分享，请先在资源库添加分享链接。"
              : item.run.state === "paused"
                ? "已暂停，继续后从上次进度开始。"
                : item.run.state === "completed"
                  ? "本轮分发已结束，收录结果以平台为准。"
                  : item.readiness
                    ? "链接已准备好，可以开始分发。"
                    : "先准备资源库中的分享链接，再开始分发。";
  const percent = item.total
    ? Math.round((item.delivered / item.total) * 100)
    : 0;
  return (
    <Panel className="distribution-progress-panel">
      <div className="distribution-progress-heading">
        <div className="row">
          <h1>{item.platform.name}</h1>
          <Status
            kind={
              needsAttention || waiting
                ? "warning"
                : item.run.state === "completed"
                  ? "good"
                  : "normal"
            }
          >
            {waiting && websiteVerification
              ? "等待验证"
              : runNames[item.run.state]}
          </Status>
        </div>
        <div className="row">
          {item.platform.loginUrl ? (
            <Button
              quiet
              size="compact"
              disabled={model.busy}
              onClick={() => void model.open("login")}
            >
              登录平台
            </Button>
          ) : null}
          <Button
            quiet
            size="compact"
            disabled={model.busy}
            onClick={() => void model.open()}
          >
            <ExternalLink size={14} />
            前往官网
          </Button>
        </div>
      </div>
      <p className="muted">
        分发资源库中已保存的本人分享，已提交的链接自动跳过。
      </p>
      <div className="distribution-progress-caption">
        <strong>
          已提交 {item.delivered.toLocaleString()} /{" "}
          {item.total.toLocaleString()} 条
        </strong>
        <span>{percent}%</span>
      </div>
      <progress
        className="distribution-progress"
        max={Math.max(1, item.total)}
        value={item.delivered}
        aria-label={`${item.platform.name}分发提交进度`}
      />
      <dl className="distribution-counts">
        <div>
          <dt>待分发</dt>
          <dd>{item.pending}</dd>
        </div>
        <div>
          <dt>等待收录</dt>
          <dd>{item.submitted + item.processing + item.reviewing}</dd>
        </div>
        <div>
          <dt>已收录</dt>
          <dd>{item.published}</dd>
        </div>
        <div>
          <dt>需处理</dt>
          <dd>{item.failed + item.blocked + item.uncertain}</dd>
        </div>
      </dl>
      {needsAttention || waiting ? (
        <Notice warning>
          <span role="status">{message}</span>
          {item.uncertain > 0 ? (
            <Button size="compact" onClick={onReview}>
              查看待核对记录
            </Button>
          ) : null}
        </Notice>
      ) : (
        <div className="distribution-run-message" role="status">
          {message}
        </div>
      )}
      <div className="row distribution-actions">
        {running ? (
          <>
            {waiting ? (
              <>
                {!websiteVerification ? (
                  <Button
                    primary
                    disabled={model.busy}
                    onClick={() =>
                      void model.run(() =>
                        ipc("distribution.continue", {
                          platformId: item.platform.id,
                        }),
                      )
                    }
                  >
                    <Play size={14} />
                    提交本批
                  </Button>
                ) : null}
                <Button disabled={model.busy} onClick={() => void model.open()}>
                  打开验证码窗口
                </Button>
              </>
            ) : null}
            <Button
              disabled={model.busy || item.run.state === "pausing"}
              onClick={() =>
                void model.run(() =>
                  ipc("distribution.pause", { platformId: item.platform.id }),
                )
              }
            >
              <Pause size={14} />
              暂停分发
            </Button>
          </>
        ) : (
          <>
            <Button
              primary={!!needsPreparation && !unverified && !item.uncertain}
              disabled={model.busy}
              onClick={() =>
                void model.run(
                  () =>
                    ipc("distribution.prepare", {
                      platformId: item.platform.id,
                    }),
                  "正在准备分享链接。",
                )
              }
            >
              <RefreshCw size={14} />
              {item.readiness ? "更新链接" : "准备链接"}
            </Button>
            <Button
              primary={!needsPreparation}
              disabled={model.busy || !canStart}
              onClick={() =>
                void model.run(
                  () =>
                    ipc("distribution.start", { platformId: item.platform.id }),
                  "已开始分发。",
                )
              }
            >
              <Play size={14} />
              {item.run.state === "paused" ? "继续分发" : "自动分发"}
            </Button>
            {item.failed > 0 ? (
              <Button
                quiet
                disabled={model.busy}
                onClick={() =>
                  void model.run(
                    () =>
                      ipc("distribution.retry", {
                        platformId: item.platform.id,
                      }),
                    (result) => `已将 ${result.updated} 条失败记录加入待分发。`,
                  )
                }
              >
                重试失败项
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}
