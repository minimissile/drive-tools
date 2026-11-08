import type { TiebaInsightsSnapshot } from "../../shared/tieba-insights";
import type { FeedbackMessage } from "../lib/feedback";
import { tiebaAvailableTargets } from "./view-model";
import type { TiebaAutocareTarget } from "../../shared/tieba-autocare";

export function tiebaTargetRefreshFeedback(
  value: Pick<TiebaInsightsSnapshot, "refreshResult">,
  targets: Pick<TiebaAutocareTarget, "id" | "name">[],
): FeedbackMessage {
  const result = value.refreshResult;
  if (!result)
    return {
      text: "未取得本次官网资料读取结果，请重新读取本地状态并检查后台是否需要应用更新。",
      tone: "warning",
    };
  const failures = result.failed.map(
    (item) =>
      `${targets.find((target) => target.id === item.id)?.name ?? "目标贴吧"}：${item.message}`,
  );
  return {
    text: failures.length
      ? `官网资料读取成功${result.succeeded.length}项，未完成${failures.length}项。${failures.slice(0, 2).join("；")}${failures.length > 2 ? "；其他原因见复盘日志。" : ""}`
      : `已读取${result.succeeded.length}个贴吧的官网资料；个人读数仅显示官网可核实的结果。`,
    tone: failures.length
      ? result.succeeded.length
        ? "warning"
        : "error"
      : "success",
  };
}

export function tiebaInsightsRefreshFeedback(
  value: Pick<TiebaInsightsSnapshot, "refreshResult">,
): FeedbackMessage {
  const result = value.refreshResult;
  if (!result)
    return {
      text: "未取得本次官网读取结果，请查看复盘日志。",
      tone: "warning",
    };
  if (result.failed.length)
    return {
      text: `官网读取完成 ${result.succeeded.length} 项，${result.failed.length} 项未完成；原记录已保留，原因见复盘日志。`,
      tone: result.succeeded.length ? "warning" : "error",
    };
  return {
    text: `官网读取完成 ${result.succeeded.length} 项，请查看真实进度与可见性记录。`,
    tone: "success",
  };
}

export const tiebaSignedDelta = (value: number | null) =>
  value === null
    ? "暂无可比记录"
    : value === 0
      ? "与上次相同"
      : `较上次 ${value > 0 ? "+" : ""}${value}`;
export function tiebaVisibilityLabel(value: string) {
  return (
    (
      {
        visible: "官网可见",
        pending_review: "官网提示审核中",
        unavailable: "官网明确不可用",
        unknown: "可见性未知",
      } as Record<string, string>
    )[value] ?? "可见性未知"
  );
}
export function tiebaVisibilityKind(value: string) {
  return value === "visible"
    ? ("good" as const)
    : value === "unavailable"
      ? ("danger" as const)
      : ("warning" as const);
}
import type {
  TiebaAutomationConfig,
  TiebaAutomationSnapshot,
  TiebaAutomationStatus,
} from "../../shared/tieba-automation";

export function tiebaAutomationInitialRecommendation(
  snapshot: TiebaAutomationSnapshot,
): TiebaAutomationConfig | null {
  if (
    snapshot.revision !== 1 ||
    snapshot.enabled ||
    snapshot.config.targetIds.length ||
    snapshot.run ||
    snapshot.tasks.length
  )
    return null;
  const targetIds = tiebaAvailableTargets(snapshot.targets, snapshot.accounts)
    .slice(0, 5)
    .map((target) => target.id);
  return targetIds.length ? { targetIds, mode: "draft", dailyLimit: 1 } : null;
}

const sameAutomationConfig = (
  left: TiebaAutomationConfig,
  right: TiebaAutomationConfig,
) =>
  left.mode === right.mode &&
  left.dailyLimit === right.dailyLimit &&
  left.targetIds.length === right.targetIds.length &&
  left.targetIds.every((id) => right.targetIds.includes(id));
export function tiebaAutomationConfigView(
  local: {
    config: TiebaAutomationConfig;
    base: TiebaAutomationConfig;
    revision: number;
  },
  current: Pick<TiebaAutomationSnapshot, "config" | "revision">,
) {
  const changed =
    !sameAutomationConfig(local.config, local.base) &&
    !sameAutomationConfig(local.config, current.config);
  return {
    config: changed ? local.config : current.config,
    changed,
    stale: changed && local.revision !== current.revision,
  };
}
export const tiebaAutomationTaskLabels: Record<TiebaAutomationStatus, string> =
  {
    pending: "待安排",
    running: "处理中",
    draft: "草稿已保留",
    verified: "官网已核实",
    uncertain: "结果待核对",
    attention: "需要检查",
    skipped: "已跳过",
    failed: "未完成",
    expired: "已过期",
    cancelled: "已取消",
  };
export const tiebaAutomationTaskKind = (value: TiebaAutomationStatus) =>
  value === "verified"
    ? ("good" as const)
    : value === "failed"
      ? ("danger" as const)
      : ["uncertain", "attention", "expired"].includes(value)
        ? ("warning" as const)
        : ("normal" as const);
