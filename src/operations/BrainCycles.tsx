import {
  operationsBrainCycleQuery,
  type OperationsBrainCycle,
} from "../../shared/operations-brain";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatMoney, formatTime } from "../lib/format";
import { Empty, LoadingState, Panel, Status } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { ChevronRight } from "lucide-react";

const cycleNames: Record<OperationsBrainCycle["status"], string> = {
  running: "执行中",
  completed: "已完成",
  stopped: "已停止",
  failed: "失败",
  budget: "预算停止",
  uncertain: "待核实",
};
const money = (cycle: OperationsBrainCycle) =>
  cycle.costKnown
    ? formatMoney(cycle.costMicros, "USD")
    : `费用待核实，已记 ${formatMoney(cycle.costMicros, "USD")}`;

export function BrainCycles({
  planId,
  workspace,
}: {
  planId: string;
  workspace: string;
}) {
  const filters = useLocalDraft(
    `panxu-operations-brain-cycles-v1:${workspace}:${planId}`,
    operationsBrainCycleQuery.parse({ planId }),
    (value) => operationsBrainCycleQuery.parse(value),
  );
  const query = useIpcQuery(
    "intelligentOps.brain.cycles",
    { ...filters.value, planId },
    { keepPrevious: true, refreshInterval: 5000 },
  );
  const data = query.data;
  return (
    <Panel title="自主决策轮次">
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
        title="自主轮次读取失败"
      />
      {!data && !query.error ? (
        <LoadingState compact label="正在读取决策与工具执行记录…" />
      ) : null}
      {data?.items.length ? (
        <>
          <div className="operations-cycle-list">
            {data.items.map((cycle) => (
              <details key={cycle.id} className="operations-cycle">
                <summary>
                  <ChevronRight
                    className="operations-cycle-disclosure"
                    size={15}
                    aria-hidden="true"
                  />
                  <time dateTime={cycle.startedAt}>
                    {formatTime(cycle.startedAt)}
                  </time>
                  <Status
                    kind={
                      cycle.status === "completed"
                        ? "good"
                        : cycle.status === "failed" ||
                            cycle.status === "uncertain"
                          ? "danger"
                          : cycle.status === "budget"
                            ? "warning"
                            : "normal"
                    }
                  >
                    {cycleNames[cycle.status]}
                  </Status>
                  <strong>{cycle.summary || "轮次进行中"}</strong>
                  <span>{money(cycle)}</span>
                </summary>
                <div className="operations-cycle-body">
                  <p className="operations-quiet">
                    轮次 {cycle.id} · 计划 v{cycle.planRevision} · {cycle.model}
                    <br />
                    结束{" "}
                    {cycle.finishedAt
                      ? formatTime(cycle.finishedAt)
                      : "尚未结束"}{" "}
                    · 下次唤醒{" "}
                    {cycle.nextWakeAt
                      ? formatTime(cycle.nextWakeAt)
                      : "尚未安排"}
                  </p>
                  {cycle.steps.length ? (
                    <ol className="operations-cycle-steps">
                      {cycle.steps.map((step) => (
                        <li key={step.id}>
                          <strong>
                            {step.kind === "decision"
                              ? "模型决策摘要"
                              : `工具执行 · ${step.tool || "未提供工具名"}`}
                          </strong>
                          <small>
                            {formatTime(step.createdAt)} ·{" "}
                            {step.success ? "已记录成功结果" : "失败或待核实"}
                            {step.kind === "tool" &&
                            (step.costMicros == null || step.costMicros === 0)
                              ? " · 工具自身无新增模型费用，调用费用计入模型步骤"
                              : step.costMicros == null
                                ? " · 本步模型费用待核实"
                                : ` · ${formatMoney(step.costMicros, "USD")}`}
                          </small>
                          <p>{step.summary}</p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="operations-quiet">尚无已记录步骤。</p>
                  )}
                </div>
              </details>
            ))}
          </div>
          <Pagination
            label="自主决策轮次分页"
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            disabled={query.loading}
            onPageChange={(page) => filters.update({ page })}
          />
        </>
      ) : data && !query.loading && !query.error ? (
        <Empty compact title="尚无自主决策轮次">
          完成本计划的持续授权并启用执行条件后，模型决策、工具摘要及费用会逐轮记录在这里。
        </Empty>
      ) : null}
    </Panel>
  );
}
