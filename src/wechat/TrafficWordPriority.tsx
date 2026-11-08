import type { WechatTrafficWordPlan } from "../../shared/wechat-traffic-words";

export function TrafficWordPriority({
  plan,
  wordCount,
}: {
  plan: WechatTrafficWordPlan;
  wordCount: number;
}) {
  if (!wordCount) return null;
  return (
    <div className="wechat-traffic-usage muted">
      <p className="wechat-editor-dialog-help">
        全部 {wordCount} 个流量词均可用。
        {plan.mode === "uncovered"
          ? `下次优先考虑 ${plan.priorityWords.length} 个历史改写尚未覆盖的相关词。`
          : "词池已覆盖一轮，下次优先考虑使用较少的相关词。"}
        核心词可重复，长尾词轮换，不要求全部填入。
      </p>
      {plan.priorityWords.length ? (
        <details>
          <summary>优先考虑（{plan.priorityWords.length}）</summary>
          <p>{plan.priorityWords.join("、")}</p>
        </details>
      ) : null}
    </div>
  );
}
