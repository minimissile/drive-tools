import type { ZhihuSnapshot } from "../../shared/zhihu";
import { useIpcQuery } from "../api/useIpcQuery";
import { formatTime } from "../lib/format";
import { LoadingState } from "../ui/DataState";
import { QueryError } from "../ui/QueryError";
import { Button, Empty, Panel, Status } from "../ui/primitives";
import { ZhihuLogRows } from "./Logs";
import { ZhihuCreatorProgress } from "./CreatorProgress";

export function ZhihuOverview({
  snapshot: s,
  open,
}: {
  snapshot: ZhihuSnapshot;
  open(tab: string): void;
}) {
  const logs = useIpcQuery(
    "zhihu.logs",
    { page: 1 },
    { keepPrevious: true, refreshInterval: 5000 },
  );
  const queued = s.tasks.filter((t) => t.status === "queued");
  const attention = s.tasks.filter((t) => t.status === "attention");
  const available = s.contents.filter(
    (c) =>
      c.reviewed &&
      c.purpose === "warming" &&
      !s.tasks.some((t) => t.contentId === c.id && t.status !== "cancelled"),
  ).length;
  return (
    <div className="zhihu-overview">
      <Panel
        title="账号运行情况"
        className="zhihu-overview-panel"
        extra={
          <Button size="compact" onClick={() => open("accounts")}>
            管理养号计划
          </Button>
        }
      >
        <div className="zhihu-overview-summary">
          <span>
            已启用{" "}
            <strong>{s.accounts.filter((a) => a.plan.active).length}</strong> /{" "}
            {s.accounts.length} 个账号
          </span>
          <Button quiet size="compact" onClick={() => open("tasks")}>
            排队 {queued.length} · 待核对 {attention.length}
          </Button>
          <Button quiet size="compact" onClick={() => open("contents")}>
            可用养号素材 {available} 篇
          </Button>
          <Button quiet size="compact" onClick={() => open("participation")}>
            日常参与与回答准备
          </Button>
        </div>
        {s.accounts.length ? (
          <div className="zhihu-table-scroll">
            <table className="zhihu-operation-table">
              <thead>
                <tr>
                  <th>账号 / 环境</th>
                  <th>创作者成长</th>
                  <th>执行次数 · 今日 / 本周</th>
                  <th>当前状态与下一步</th>
                </tr>
              </thead>
              <tbody>
                {s.accounts.map((a) => {
                  const next = s.tasks
                    .filter(
                      (t) =>
                        t.accountId === a.id &&
                        [
                          "queued",
                          "running",
                          "submitting",
                          "attention",
                        ].includes(t.status),
                    )
                    .sort((x, y) =>
                      x.scheduledAt.localeCompare(y.scheduledAt),
                    )[0];
                  const p = a.plan.progress;
                  return (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.nickname || a.alias}</strong>
                        <small>
                          {a.environmentName} ·{" "}
                          {a.engine === "bitbrowser"
                            ? "比特浏览器"
                            : "待绑定比特"}
                        </small>
                      </td>
                      <td>
                        <ZhihuCreatorProgress
                          progress={p}
                          targetLevel={a.plan.targetLevel}
                        />
                      </td>
                      <td className="zhihu-usage">
                        <span>
                          {a.today} / {a.plan.dailyLimit} 次
                        </span>
                        <small>
                          {a.week} / {a.plan.weeklyLimit} 次
                        </small>
                      </td>
                      <td>
                        <Status
                          kind={
                            next?.status === "attention"
                              ? "warning"
                              : a.plan.active
                                ? "good"
                                : "normal"
                          }
                        >
                          {next?.status === "attention"
                            ? "待核对"
                            : a.plan.active
                              ? "计划已启用"
                              : "计划已暂停"}
                        </Status>
                        <small>
                          {next
                            ? `${next.status === "queued" ? "计划 " + formatTime(next.scheduledAt) : next.message} · ${next.title}`
                            : a.plan.message || "尚未安排任务"}
                        </small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="还没有知乎账号">
            在账号管理中关联比特浏览器环境，再检查登录身份与创作者等级。
          </Empty>
        )}
        <p className="muted zhihu-overview-footnote">
          仅分发已审核素材；每份素材分配一次。账号及同出口按规则错峰，达到目标等级后暂停。
        </p>
      </Panel>
      <Panel
        title="最近运行记录"
        className="zhihu-log-panel"
        extra={
          <Button size="compact" onClick={() => open("logs")}>
            查看全部日志
          </Button>
        }
      >
        <QueryError
          error={logs.error}
          loading={logs.loading}
          onRetry={logs.reload}
          title="运行记录读取失败"
        />
        {!logs.data && !logs.error ? (
          <LoadingState label="正在读取最近记录…" compact />
        ) : null}
        {logs.data?.items.length ? (
          <ZhihuLogRows
            items={logs.data.items.slice(0, 6)}
            accounts={s.accounts}
          />
        ) : logs.data && !logs.loading && !logs.error ? (
          <Empty title="尚无运行记录">
            启动调度后，账号检查、排队、发布回执及异常将在这里显示。
          </Empty>
        ) : null}
      </Panel>
    </div>
  );
}
