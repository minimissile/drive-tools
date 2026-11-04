import type { OperationsAccount } from "../../shared/intelligent-operations";
import type { ZhihuParticipationActivity } from "../../shared/zhihu-participation";
import { useIpcQuery } from "../api/useIpcQuery";
import { formatTime } from "../lib/format";
import { QueryError } from "../ui/QueryError";
import { Button, Empty, LoadingState, Status } from "../ui/primitives";
import {
  participationKindLabels,
  participationStatusKind,
  participationStatusLabels,
} from "../zhihu/participation-state";
import { useOperationsFocus } from "./OperationsFocus";

const priority = (a: ZhihuParticipationActivity) =>
  a.status === "executing"
    ? 0
    : a.status === "attention"
      ? 1
      : a.status === "queued"
        ? 2
        : 3;
const observedTime = (a: ZhihuParticipationActivity) => {
  const attempt = a.attempts?.at(-1);
  return (
    attempt?.receipt?.observedAt ||
    attempt?.finishedAt ||
    a.automation?.queuedAt ||
    a.createdAt
  );
};

/** Local queue inspection only; model wakeups and all execution remain in the backend. */
export function AutonomyParticipationQueue({
  planId,
  accounts,
}: {
  planId: string;
  accounts: OperationsAccount[];
}) {
  const { open } = useOperationsFocus();
  const query = useIpcQuery("zhihu.participation.snapshot", undefined, {
    keepPrevious: true,
    refreshInterval: 5000,
  });
  const items = query.data?.activities
    .filter((a) => a.planId === planId && (a.automation || a.attempts?.length))
    .sort((a, b) => {
      const group = priority(a) - priority(b);
      if (group) return group;
      if (a.status === "queued" && b.status === "queued")
        return (a.scheduledAt || "9999").localeCompare(b.scheduledAt || "9999");
      return observedTime(b).localeCompare(observedTime(a));
    });
  return (
    <section
      className="operations-form-section"
      aria-label="本计划本地参与排期与结果"
    >
      <div className="operations-channel-heading">
        <h3>本地参与排期与结果</h3>
        <Button
          quiet
          size="compact"
          onClick={() => open({ planId, tab: "participation" })}
        >
          查看完整参与计划
        </Button>
      </div>
      <p className="operations-quiet">
        已安排的本地任务不依赖下一次模型观察，仍需当前授权；到时继续核对账号、计划版本、额度与执行时段。
      </p>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
        title="本地参与排期读取失败"
      >
        读取失败不代表任务已停止，也不会重新提交已有任务。
      </QueryError>
      {!query.data && !query.error ? (
        <LoadingState compact label="正在读取本计划本地参与任务…" />
      ) : null}
      {items?.length ? (
        <div className="operations-table-scroll">
          <table className="operations-table">
            <thead>
              <tr>
                <th>类型与目标</th>
                <th>处理状态</th>
                <th>执行或核验时间</th>
                <th>账号与回执</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 3).map((a) => {
                const attempt = a.attempts?.at(-1),
                  receipt = attempt?.receipt;
                const candidate = query.data?.candidates.find(
                  (c) => c.id === a.candidateId && c.accountId === a.accountId,
                );
                const timing: [string, string | null | undefined] =
                  a.status === "queued"
                    ? ["预计执行", a.scheduledAt]
                    : receipt
                      ? ["官方核验", receipt.observedAt]
                      : attempt?.submittedAt
                        ? ["原提交", attempt.submittedAt]
                        : ["开始", attempt?.startedAt];
                return (
                  <tr key={a.id}>
                    <td>
                      {participationKindLabels[a.kind]}
                      <p>
                        {a.context?.title ||
                          candidate?.title ||
                          "原候选暂不可读"}
                      </p>
                    </td>
                    <td>
                      <Status kind={participationStatusKind(a.status)}>
                        {participationStatusLabels[a.status]}
                      </Status>
                    </td>
                    <td className="operations-time">
                      {timing[1] ? (
                        <>
                          {timing[0]}
                          <br />
                          {formatTime(timing[1])}
                        </>
                      ) : (
                        "尚未取得执行时间"
                      )}
                    </td>
                    <td>
                      {accounts.find((account) => account.id === a.accountId)
                        ?.label || "历史账号"}
                      <p>
                        {receipt
                          ? receipt.outcome === "already_present"
                            ? "已确认原有状态，未新增互动"
                            : receipt.summary
                          : a.status === "queued"
                            ? "尚未执行，无官方回执"
                            : attempt?.status === "unknown"
                              ? "结果未知，仅可核对原提交"
                              : attempt?.error || "尚无官方回执"}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : query.data && !query.error ? (
        <Empty compact title="本计划暂无已安排的自主参与任务">
          AI安排后的本地任务与实际回执会显示在这里。查看完整参与计划，可核对候选、决策依据及每次执行证据。
        </Empty>
      ) : null}
    </section>
  );
}
