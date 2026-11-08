import type {
  TiebaAutocareConfig,
  TiebaAutocareTask,
  TiebaAutocareTaskStatus,
  TiebaAutocareTarget,
} from "../../shared/tieba-autocare";
import type { WebsiteAccount } from "../../shared/website-accounts";

export function tiebaAccountNeedsVerification(
  account: Pick<WebsiteAccount, "status"> & { unverified?: boolean },
) {
  return account.status !== "connected" || account.unverified === true;
}

export function tiebaAvailableTargets(
  targets: TiebaAutocareTarget[],
  accounts: Pick<WebsiteAccount, "id" | "uid" | "status">[],
) {
  return targets.filter(
    (target) =>
      !target.paused &&
      accounts.some(
        (account) =>
          account.id === target.accountId &&
          account.status === "connected" &&
          !!account.uid &&
          account.uid === target.uid,
      ),
  );
}
export function tiebaTargetRefreshIds(
  filtered: Pick<TiebaAutocareTarget, "id">[],
) {
  return [...new Set(filtered.map((target) => target.id))].slice(0, 5);
}
export function tiebaStartingTarget(
  storedId: string,
  touched: boolean,
  targets: TiebaAutocareTarget[],
  accounts: Pick<WebsiteAccount, "id" | "uid" | "status">[],
) {
  const available = tiebaAvailableTargets(targets, accounts);
  const selected = available.find((target) => target.id === storedId);
  return {
    available,
    target: storedId ? selected : touched ? undefined : available[0],
    needsRecovery: !!storedId && !selected,
    fallback: available[0],
  };
}

export function tiebaTargetCanSign(
  target: TiebaAutocareTarget,
  uid: string | null | undefined,
) {
  return target.source !== "observed" && !!uid && uid === target.uid;
}
export function tiebaTargetRunLabel(
  target: Pick<TiebaAutocareTarget, "source" | "followIntent" | "paused">,
  identityValid: boolean,
  selected: boolean,
) {
  if (["submitting", "uncertain"].includes(target.followIntent?.status ?? ""))
    return "关注待核对";
  if (!identityValid) return "身份已变化";
  if (target.paused) return "已暂停";
  if (selected) return "已选目标";
  return target.source === "observed" ? "待关注" : "未选签到";
}

export function tiebaReplyTargets(targets: TiebaAutocareTarget[]) {
  return targets.filter((target) => !target.paused);
}

export function sameTiebaTargets(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

/** Remote updates are authoritative until the window has actual local edits. */
export function tiebaSelectionView(
  draft: {
    config: TiebaAutocareConfig;
    revision: number;
    baseTargetIds: string[];
  },
  current: { config: TiebaAutocareConfig; revision: number },
) {
  const locallyEdited = !sameTiebaTargets(
    draft.config.targetIds,
    draft.baseTargetIds,
  );
  const changed =
    locallyEdited &&
    !sameTiebaTargets(draft.config.targetIds, current.config.targetIds);
  return {
    selected: changed ? draft.config.targetIds : current.config.targetIds,
    changed,
    stale: changed && draft.revision !== current.revision,
  };
}

export const tiebaTaskLabels: Record<TiebaAutocareTaskStatus, string> = {
  pending: "待执行",
  running: "正在检查",
  submitting: "正在提交",
  verified: "签到已核实",
  already_signed: "今日已签到",
  uncertain: "结果待核对",
  failed: "未完成",
  skipped: "已跳过",
  expired: "已过期",
  cancelled: "已取消",
};

export function tiebaTaskKind(status: TiebaAutocareTaskStatus) {
  if (status === "verified" || status === "already_signed") return "good";
  if (status === "failed") return "danger";
  if (status === "uncertain" || status === "expired") return "warning";
  return "normal";
}

export function tiebaTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "待获取";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function tiebaTaskSummary(tasks: TiebaAutocareTask[]) {
  return {
    verified: tasks.filter((task) => task.status === "verified").length,
    already: tasks.filter((task) => task.status === "already_signed").length,
    uncertain: tasks.filter((task) => task.status === "uncertain").length,
  };
}
