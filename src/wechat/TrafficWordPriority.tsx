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
          ? plan.deliveryCoverage?.count
            ? "下次优先补充送稿尚未确认覆盖的相关词。"
            : "下次优先补充改写尚未覆盖的相关词。"
          : "词池已覆盖一轮，下次优先使用较少出现的相关词。"}
      </p>
      {plan.priorityWords.length ? (
        <details>
          <summary>下次优先（{plan.priorityWords.length}）</summary>
          <p>{plan.priorityWords.join("、")}</p>
        </details>
      ) : null}
    </div>
  );
}
