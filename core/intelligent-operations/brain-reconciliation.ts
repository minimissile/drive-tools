import type { z } from "zod";
import { AppError } from "../errors";
import { cleanKnowledge } from "../knowledge-response";
import type { operationsBrainReconcileRoutingInput } from "../../shared/operations-brain";
import type { OperationsBrainHost } from "./brain-types";

const officialEvidence =
  "https://openrouter.ai/docs/api_reference/errors-and-debugging";
const fail = (message: string): never => {
  throw new AppError("OPERATIONS_RECONCILIATION_BLOCKED", message);
};
interface LedgerRow {
  id: string;
  endpoint: string;
  phase: string;
  units: number;
  request_count: number;
  estimated_micros: number | null;
  reserved_micros: number | null;
  confirmed_micros: number | null;
  status: string;
  message: string;
}
/**
 * Only historical native-runtime HTTP 404 records qualify. Zero tool steps alone
 * never prove zero cost. This does not settle network, HTTP 200-body, or timeout failures.
 */
export function reconcileOperationsRoutingRejection(
  host: OperationsBrainHost,
  input: z.output<typeof operationsBrainReconcileRoutingInput>,
) {
  const plan = host.plan(input.planId),
    state = host.state(),
    cycle =
      state.brain.cycles.find(
        (item) => item.id === input.cycleId && item.planId === plan.id,
      ) ?? fail("未找到属于此计划的原轮次，未修改费用记录");
  if (
    plan.active ||
    host.running() ||
    host.closed() ||
    cycle.status !== "uncertain" ||
    cycle.costKnown ||
    cycle.costMicros !== 0 ||
    !cycle.finishedAt ||
    cycle.steps.length
  )
    fail("仅完全停止、费用未知且无决策或工具步骤的原轮次可核对");
  const originalSummary = cycle.summary,
    recorded = originalSummary.match(
      /^请求结果\/费用待核实，停止且不执行后续工具：自主运营模型请求未完成（HTTP 404），调用记录 (ai_[\w-]+)；实际费用待核实，禁止自动重试。/,
    );
  if (recorded?.[1] !== input.callId)
    fail("原轮次没有保存与此调用精确对应的 HTTP 404 证据；不能推定费用为零");
  if (
    state.tasks.some((task) => task.brainCycleId === cycle.id) ||
    state.brain.provenance.some((item) => item.cycleId === cycle.id) ||
    state.brain.memory.some((item) => item.cycleId === cycle.id)
  )
    fail("原轮次已有任务或业务产物，不能使用前置路由拒绝核对入口");
  const rows = host.d.db.all<LedgerRow>(
      "SELECT * FROM api_calls WHERE phase=?",
      `agent:${plan.id}:${cycle.id}`,
    ),
    row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.id !== input.callId ||
    row.endpoint !== "openrouter" ||
    row.status !== "uncertain" ||
    row.units !== 1 ||
    row.request_count !== 1 ||
    row.confirmed_micros !== null ||
    row.reserved_micros === null ||
    row.reserved_micros < 0
  )
    fail("调用账本不是唯一、未结算的原生模型请求；保持原有费用阻塞");
  const evidence = String(cleanKnowledge(input.evidence)),
    stamp = new Date(host.now()).toISOString(),
    note = `人工核对 ${stamp}：原轮次已记录精确 HTTP 404；按 OpenRouter 官方“模型接受前返回HTTP错误、接受后错误仍HTTP200”的协议，登记前置请求失败并释放本地预留，不是服务商账单查询或请求重试。依据：${officialEvidence}；核查证据：${evidence}`,
    previous = { ...cycle };
  try {
    host.d.db.transaction(() => {
      host.d.db.run(
        "UPDATE api_calls SET status='failed',confirmed_micros=0,reserved_micros=0,message=? WHERE id=? AND status='uncertain' AND confirmed_micros IS NULL",
        `${row.message}\n${note}`,
        row.id,
      );
      cycle.status = "failed";
      cycle.costKnown = true;
      cycle.costMicros = 0;
      cycle.nextWakeAt = null;
      cycle.summary = `${originalSummary}\n${note}`.slice(0, 4000);
      host.persist();
      host.log(
        "brain.cost.routing_rejection_reconciled",
        "已核对原HTTP404前置拒绝并释放本地预留；计划仍停止，旧轮次不会重放",
        plan.id,
        {
          cycleId: cycle.id,
          callId: row.id,
          priorMessage: row.message,
          priorSummary: originalSummary,
          priorReservedMicros: row.reserved_micros,
          estimatedMicros: row.estimated_micros,
          statusBefore: row.status,
          statusAfter: "failed",
          confirmedMicros: 0,
          evidence,
          officialEvidence,
          basis: "persisted-http-404-before-provider-acceptance",
        },
      );
    });
  } catch (error) {
    Object.assign(cycle, previous);
    throw error;
  }
}
