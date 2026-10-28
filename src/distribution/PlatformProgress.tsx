import { useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import type { DistributionPlatformSummary } from "../../shared/distribution";
import { ipc } from "../api/client";
import { CheckboxField } from "../ui/CheckboxField";
import { Button, Notice, Panel, Status } from "../ui/primitives";
import type { DistributionModel } from "./useDistribution";

const runNames = {
  idle: "尚未准备",
  scanning: "准备全库链接中",
  ready: "已准备好",
  running: "自动分发中",
  pausing: "正在暂停",
  paused: "已暂停",
  blocked: "需要处理",
  completed: "本轮已结束",
};
export function PlatformProgress({
  item,
  model,
}: {
  item: DistributionPlatformSummary;
  model: DistributionModel;
}) {
  const [rights, setRights] = useState(false);
  const running = ["scanning", "running", "pausing"].includes(item.run.state);
  const accepted = item.delivered;
  const percent = item.total ? Math.round((accepted / item.total) * 100) : 0;
  const canStart =
    item.readiness?.status === "ready" &&
    item.pending > 0 &&
    !item.uncertain &&
    !running;
  return (
    <Panel className="distribution-progress-panel">
      <div className="row spread">
        <h2>{item.platform.name} · 全库分发</h2>
        <Status
          kind={
            item.run.state === "blocked" ||
            (item.run.state === "completed" &&
              (item.failed > 0 || item.blocked > 0 || item.uncertain > 0))
              ? "warning"
              : item.run.state === "completed"
                ? "good"
                : "normal"
          }
        >
          {runNames[item.run.state]}
        </Status>
      </div>
      <p className="muted">
        自动处理资源库中的全部本人分享，包含资源副本和拆分链接。同一链接按平台去重，已提交的不重复发送。
      </p>
      <div className="distribution-progress-caption">
        <strong>
          {accepted.toLocaleString()} / {item.total.toLocaleString()} 条已提交
        </strong>
        <span>
          {percent}% · 关联 {item.resourceCount.toLocaleString()} 份资源 · 历史{" "}
          {item.historyTotal.toLocaleString()} 条
        </span>
      </div>
      <progress
        className="distribution-progress"
        max={Math.max(1, item.total)}
        value={accepted}
        aria-label={`${item.platform.name}分发提交进度`}
      />
      <dl className="distribution-counts">
        <div>
          <dt>待分发</dt>
          <dd>{item.pending}</dd>
        </div>
        <div>
          <dt>核验 / 提交中</dt>
          <dd>{item.active}</dd>
        </div>
        <div>
          <dt>已提交 / 处理中</dt>
          <dd>{item.submitted + item.processing}</dd>
        </div>
        <div>
          <dt>待审核 / 已收录</dt>
          <dd>
            {item.reviewing} / {item.published}
          </dd>
        </div>
        <div>
          <dt>失败 / 未就绪</dt>
          <dd>
            {item.failed} / {item.blocked}
          </dd>
        </div>
        <div>
          <dt>结果待核对</dt>
          <dd>{item.uncertain}</dd>
        </div>
        <div>
          <dt>规则跳过 / 旧链接</dt>
          <dd>{item.skipped}</dd>
        </div>
      </dl>
      <div className="distribution-run-message" role="status">
        {item.run.message ||
          "先准备全库链接，检查规则与登录状态后开始自动分发。"}
      </div>
      {item.readiness?.status !== "ready" && item.readiness ? (
        <Notice warning>{item.readiness.message}</Notice>
      ) : null}
      {!item.readiness && item.platform.format === "unverified" ? (
        <Notice warning>
          该平台投稿规则待登录核实，自动分发暂不可用；可以先准备全库记录。
        </Notice>
      ) : null}
      {!running ? (
        <CheckboxField
          checked={rights}
          onChange={(event) => setRights(event.target.checked)}
          label={`我确认全部待分发的本人分享可公开，并同意自动提交到${item.platform.name}`}
        />
      ) : null}
      <div className="row distribution-actions">
        <Button
          disabled={model.busy || running}
          onClick={() =>
            void model.run(
              () =>
                ipc("distribution.prepare", { platformId: item.platform.id }),
              "已开始准备全库链接，进度会自动更新。",
            )
          }
        >
          <RefreshCw size={14} />
          准备全库链接
        </Button>
        {running ? (
          <Button
            disabled={model.busy || item.run.state === "pausing"}
            onClick={() =>
              void model.run(() =>
                ipc("distribution.pause", { platformId: item.platform.id }),
              )
            }
          >
            <Pause size={14} />
            暂停
          </Button>
        ) : (
          <Button
            primary
            disabled={model.busy || !rights || !canStart}
            onClick={() =>
              void model
                .run(
                  () =>
                    ipc("distribution.start", {
                      platformId: item.platform.id,
                      rightsConfirmed: true,
                    }),
                  "已开始当前平台的自动分发。",
                )
                .then((result) => {
                  if (result) setRights(false);
                })
            }
          >
            <Play size={14} />
            {item.run.state === "paused" ? "继续自动分发" : "自动分发"}
          </Button>
        )}
        <Button
          quiet
          disabled={model.busy || running || !item.failed}
          onClick={() =>
            void model.run(
              () => ipc("distribution.retry", { platformId: item.platform.id }),
              (result) => `已将 ${result.updated} 条明确失败记录重新入队。`,
            )
          }
        >
          重试明确失败项
        </Button>
      </div>
      <small className="muted">
        每批最多 100 条，批次间隔 5
        秒。新增或修复分享后重新准备可增量入队；热盘搜跳过同资源的重复链接变体。未提交的旧链接单列历史，不计入有效队列；提交与收录分别统计。
      </small>
    </Panel>
  );
}
