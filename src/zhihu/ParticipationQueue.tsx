import type { ZhihuParticipationActivity } from "../../shared/zhihu-participation";
import { formatTime } from "../lib/format";
import { Notice } from "../ui/primitives";

export function ParticipationQueue({
  activity: a,
}: {
  activity: ZhihuParticipationActivity;
}) {
  if (a.status !== "queued" || !a.automation) return null;
  const { decision, planRevision, queuedAt } = a.automation;
  return (
    <section className="participation-form-section" aria-label="自主参与排期">
      <h3>自主参与排期</h3>
      <Notice>
        已保存互动决定，尚未执行或取得官方回执。到时仍须当前授权、计划版本、账号状态、上下文及额度有效；条件变化时不会强行提交。
      </Notice>
      <dl className="participation-evidence">
        <div>
          <dt>预计提交时间</dt>
          <dd>
            {a.scheduledAt ? formatTime(a.scheduledAt) : "等待有效执行时段"}
          </dd>
        </div>
        <div>
          <dt>安排时间 / 计划版本</dt>
          <dd>
            {formatTime(queuedAt)} · v{planRevision}
          </dd>
        </div>
      </dl>
      <div className="participation-decision">
        <strong>
          {decision.relevance === null
            ? decision.source === "rule"
              ? decision.rule === "autocare_random_comment"
                ? "随机评论规则"
                : "随机点赞规则"
              : "本人确认的互动依据"
            : `AI相关性判断 · ${Math.round(decision.relevance * 100)}%`}
        </strong>
        <p>{decision.basis}</p>
        <blockquote>{decision.quote}</blockquote>
      </div>
    </section>
  );
}
