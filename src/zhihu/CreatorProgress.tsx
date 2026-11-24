import {
  hasZhihuOfficialScore,
  zhihuOfficialScoreRefreshMs,
  type ZhihuSnapshot,
} from "../../shared/zhihu";
import { formatTime } from "../lib/format";

const number = (value: number) => value.toLocaleString("zh-CN");

/** Shared by the overview and account detail; plan targets never supply scores. */
export function ZhihuCreatorProgress({
  account,
  targetLevel = account.plan.targetLevel,
}: {
  account: Pick<ZhihuSnapshot["accounts"][number], "plan" | "uid" | "status">;
  targetLevel?: number;
}) {
  const sameIdentity = !!account.uid && account.plan.uid === account.uid;
  const p = sameIdentity ? account.plan.progress : null;
  const last = sameIdentity ? account.plan.lastOfficialScore : undefined;
  const scoreReading = hasZhihuOfficialScore(p)
    ? p
    : p?.creator !== false && hasZhihuOfficialScore(last)
      ? last
      : null;
  const checkedAt = Date.parse(scoreReading?.checkedAt ?? "");
  const historical =
    !!scoreReading &&
    (scoreReading !== p ||
      !!account.plan.officialProgressFailedAt ||
      account.status !== "connected" ||
      !Number.isFinite(checkedAt) ||
      Date.now() - checkedAt >= zhihuOfficialScoreRefreshMs);
  const score = scoreReading?.score ?? null;
  const level = scoreReading?.level;
  const threshold = scoreReading?.nextLevelScore;
  const total =
    score !== null &&
    level != null &&
    level < 10 &&
    typeof threshold === "number" &&
    Number.isSafeInteger(threshold) &&
    threshold > 0 &&
    threshold >= score
      ? threshold
      : null;
  const percent = total === null ? null : ((score! / total) * 100).toFixed(1);
  const metric = historical ? "上次官方创作分" : "创作分";
  const nextLevel = level == null ? null : level + 1;
  return (
    <div className="zhihu-creator-progress">
      <div className="zhihu-growth-heading">
        <strong>{p?.level == null ? "等级待核实" : `Lv.${p.level}`}</strong>
        <span>计划目标 Lv.{targetLevel}</span>
      </div>
      {score !== null ? (
        <>
          <div className="zhihu-score-line">
            <span>
              {metric} <b>{number(score)}</b>
              {total === null ? " 分" : ` / ${number(total)}`}
            </span>
            {historical ? (
              <span>待刷新</span>
            ) : percent !== null ? (
              <span>{percent}%</span>
            ) : null}
          </div>
          {total !== null && !historical ? (
            <progress
              className="zhihu-score-bar"
              value={score}
              max={total}
              aria-label={`升至 Lv.${nextLevel} 的创作分进度`}
              aria-valuetext={`${number(score)} / ${number(total)} 分，${percent}%`}
            />
          ) : null}
          <div className="zhihu-growth-meta">
            <span>
              {historical && scoreReading
                ? `上次读取 ${formatTime(scoreReading.checkedAt)}`
                : total !== null
                  ? `升至 Lv.${nextLevel} 还需 ${number(total - score)} 分`
                  : level === 10
                    ? "已达最高创作等级"
                    : "下一等级门槛未读取"}
            </span>
            {scoreReading?.scoreUpdatedOn ? (
              <span>官方分数日期 {scoreReading.scoreUpdatedOn}</span>
            ) : null}
          </div>
        </>
      ) : (
        <small>
          {p?.creator === false
            ? "尚未入驻 · 发布首篇后开通"
            : p?.creator
              ? "创作分尚未读取，请刷新创作进度"
              : "创作者状态待检查"}
        </small>
      )}
      {p?.source === "official" && p.dimensions?.length ? (
        <details className="zhihu-growth-dimensions">
          <summary>创作分维度 · 官方更新口径</summary>
          {historical ? <small>分值以当前官方页面为准</small> : null}
          {p.dimensions.every((d) => d.score === null) ? (
            <small>维度分值暂未读取</small>
          ) : null}
          <dl>
            {p.dimensions.map((d) => (
              <div key={d.name}>
                <dt>
                  {d.name} · {d.cadence}
                </dt>
                {d.score !== null ? <dd>{number(d.score)} 分</dd> : null}
                <dd>{d.description}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}
