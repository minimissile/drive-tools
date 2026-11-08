import { useState } from "react";
import type { AutocareSnapshot } from "../../shared/zhihu-autocare";
import { Button, Empty, Panel, Status } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { formatTime } from "../lib/format";
import {
  buildAutocareAgenda,
  buildAutocareDailyProgress,
  getAutocareRunView,
  type AutocareAgendaItem,
} from "./autocare-agenda";
import "./autocare-agenda.css";

export interface AutocareAgendaProps {
  snapshot: AutocareSnapshot;
  onOpenTasks?(): void;
  onOpenParticipation?(): void;
  onManageAccount?(accountId: string): void;
}

function shortTime(value: string, day: string) {
  const date = new Date(Date.parse(value) + 8 * 3600000).toISOString();
  const time = date.slice(11, 16);
  return date.startsWith(day) ? time : `${date.slice(5, 10)} ${time}`;
}

export function AutocareAgenda({
  snapshot,
  onOpenTasks,
  onOpenParticipation,
  onManageAccount,
}: AutocareAgendaProps) {
  const [page, setPage] = useState(1);
  const items = buildAutocareAgenda(snapshot);
  const daily = buildAutocareDailyProgress(snapshot);
  const run = getAutocareRunView(snapshot);
  const pageSize = 3;
  const actualPage = Math.min(
    page,
    Math.max(1, Math.ceil(items.length / pageSize)),
  );
  const activeDetails =
    run.ended ||
    items.some(
      (item) => item.state === "attention" || item.state === "running",
    );
  const action = (item: AutocareAgendaItem) => {
    if (item.action === "tasks" && onOpenTasks)
      return (
        <Button quiet size="compact" onClick={onOpenTasks}>
          查看原任务
        </Button>
      );
    if (item.action === "participation" && onOpenParticipation)
      return (
        <Button quiet size="compact" onClick={onOpenParticipation}>
          互动记录
        </Button>
      );
    if (item.action === "account" && onManageAccount)
      return (
        <Button
          quiet
          size="compact"
          onClick={() => onManageAccount(item.accountId)}
        >
          管理账号
        </Button>
      );
    return null;
  };
  return (
    <Panel
      title="养号计划 · 启动后2小时内"
      className="autocare-agenda"
      extra={<small className="muted">{daily.date} · 北京时间</small>}
    >
      <p className="autocare-agenda-intro">
        {!run.supported
          ? "两小时方案待应用后端更新，当前仅展示旧版记录。"
          : run.startedAt && run.deadlineAt
            ? `开始 ${shortTime(run.startedAt, daily.date)} · 截止 ${shortTime(run.deadlineAt, daily.date)}。今日数量限本轮截止前执行，不因重开重置。`
            : "开启后开始计算2小时。今日数量限本轮截止前执行，不因重开重置。"}
      </p>
      {daily.accounts.length ? (
        <div className="table-wrap">
          <table className="autocare-day-table" aria-label="今日养号操作与进度">
            <thead>
              <tr>
                <th>账号</th>
                <th>养号方向</th>
                <th>今日操作与数量</th>
                <th>进度</th>
                <th>下项</th>
              </tr>
            </thead>
            <tbody>
              {daily.accounts.map((account) => {
                const target =
                  snapshot.config.accountTargets?.[account.accountId];
                const attention = items.find(
                  (item) =>
                    item.accountId === account.accountId &&
                    item.state === "attention" &&
                    item.blocking !== false,
                );
                const running = items.some(
                  (item) =>
                    item.accountId === account.accountId &&
                    item.state === "running",
                );
                return (
                  <tr key={account.accountId}>
                    <td>
                      <strong>{account.accountName}</strong>
                    </td>
                    <td>
                      {target?.enabled && target.domain
                        ? target.domain
                        : "提升创作分 · 皮皮虾"}
                    </td>
                    <td>
                      <p className="autocare-day-action-names">
                        {account.actionSummary || "未选择自动操作"}
                      </p>
                      <p className="autocare-day-limit">
                        {account.limits.join(" · ")}
                      </p>
                    </td>
                    <td>
                      <p className="autocare-day-progress">
                        {account.progressSummary || "尚无已核实完成"}
                      </p>
                      {account.remainingSummary ? (
                        <p className="autocare-day-remaining">
                          {account.remainingSummary}
                        </p>
                      ) : null}
                      {daily.usageKnown ? (
                        <details className="autocare-day-usage-detail">
                          <summary>额度使用情况</summary>
                          <p>
                            {account.usage.join("；") || "当前未取得额度记录"}
                          </p>
                        </details>
                      ) : null}
                    </td>
                    <td>
                      <Status
                        kind={
                          attention ? "warning" : running ? "good" : "normal"
                        }
                      >
                        {attention
                          ? "需处理"
                          : running
                            ? "执行中"
                            : !run.supported
                              ? "待应用更新"
                              : run.ended
                                ? run.status === "completed"
                                  ? "本轮已结束"
                                  : "本轮已到期"
                                : !snapshot.enabled
                                  ? "已关闭"
                                  : "等待下项"}
                      </Status>
                      <span className="autocare-day-next-operation">
                        {attention?.operation || account.nextOperation}
                      </span>
                      {!attention && account.nextAt ? (
                        <time
                          dateTime={account.nextAt}
                          title={formatTime(account.nextAt)}
                        >
                          {shortTime(account.nextAt, daily.date)}
                        </time>
                      ) : null}
                      {attention ? action(attention) : null}
                      {!attention &&
                      (run.ended || (!account.nextAt && run.startedAt)) ? (
                        <small className="autocare-day-cutoff">
                          {run.ended
                            ? "未完成原因见具体任务"
                            : account.waitingReason}
                        </small>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty compact title="尚未选择养号账号">
          保存账号与操作后开启，实际任务会显示在这里。
        </Empty>
      )}
      {!daily.usageKnown && daily.accounts.length ? (
        <p className="autocare-agenda-compatibility">
          当前运行版本未提供跨模式占用，剩余额度暂不估算。
        </p>
      ) : null}
      <details
        className="autocare-agenda-specific"
        open={activeDetails || undefined}
      >
        <summary>具体排期与任务（{items.length} 项）</summary>
        {items.length ? (
          <>
            <div className="table-wrap">
              <table
                className="autocare-agenda-table"
                aria-label="自动养号已保存的具体安排"
              >
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>账号</th>
                    <th>操作 / 等待原因</th>
                    <th>状态</th>
                    <th>查看</th>
                  </tr>
                </thead>
                <tbody>
                  {items
                    .slice((actualPage - 1) * pageSize, actualPage * pageSize)
                    .map((item) => (
                      <tr key={item.id} data-state={item.state}>
                        <td className="autocare-agenda-time">
                          {item.at ? (
                            <time
                              dateTime={item.at}
                              title={formatTime(item.at)}
                            >
                              {shortTime(item.at, daily.date)}
                            </time>
                          ) : (
                            <span>{item.timeLabel}</span>
                          )}
                          {item.at &&
                          (item.state === "running" ||
                            item.state === "attention") ? (
                            <small>{item.timeLabel}</small>
                          ) : null}
                        </td>
                        <td className="autocare-agenda-account">
                          {item.accountName}
                        </td>
                        <td>
                          <strong className="autocare-agenda-operation">
                            {item.operation}
                          </strong>
                          {item.state === "attention" ? (
                            <p className="autocare-agenda-reason">
                              {item.reason}
                            </p>
                          ) : (
                            <p
                              className="autocare-agenda-detail"
                              title={item.detail}
                            >
                              {item.detail}
                            </p>
                          )}
                        </td>
                        <td>
                          <Status
                            kind={
                              item.state === "attention"
                                ? "warning"
                                : item.state === "running"
                                  ? "good"
                                  : "normal"
                            }
                          >
                            {item.stateLabel}
                          </Status>
                        </td>
                        <td>{action(item)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={actualPage}
              pageSize={pageSize}
              total={items.length}
              onPageChange={setPage}
              label="自动养号任务安排分页"
            />
          </>
        ) : (
          <Empty compact title="暂未排定具体任务">
            {snapshot.enabled ? snapshot.message : "开启后生成实际安排。"}
          </Empty>
        )}
      </details>
    </Panel>
  );
}
