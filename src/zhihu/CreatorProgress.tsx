import type { ZhihuProgress } from "../../shared/zhihu";

const number = (value: number) => value.toLocaleString("zh-CN");

/** Shared by the overview and account detail; plan targets never supply scores. */
export function ZhihuCreatorProgress({
  progress: p,
  targetLevel,
}: {
  progress: ZhihuProgress | null;
  targetLevel: number;
}) {
  const score =
    p?.source === "official" &&
    p.creator &&
    Number.isSafeInteger(p.score) &&
    p.score! >= 0
      ? p.score!
      : null;
  const total =
    score !== null &&
    p?.level != null &&
    p.level < 10 &&
    Number.isSafeInteger(p.nextLevelScore) &&
    p.nextLevelScore! > 0 &&
    p.nextLevelScore! >= score
      ? p.nextLevelScore!
      : null;
  const percent = total === null ? null : ((score! / total) * 100).toFixed(1);
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
              创作分 <b>{number(score)}</b>
              {total === null ? " 分" : ` / ${number(total)}`}
            </span>
            {percent !== null ? <span>{percent}%</span> : null}
          </div>
          {total !== null ? (
            <progress
              className="zhihu-score-bar"
              value={score}
              max={total}
              aria-label={`升至 Lv.${p!.level! + 1} 的创作分进度`}
              aria-valuetext={`${number(score)} / ${number(total)} 分，${percent}%`}
            />
          ) : null}
          <div className="zhihu-growth-meta">
            <span>
              {total !== null
                ? `升至 Lv.${p!.level! + 1} 还需 ${number(total - score)} 分`
                : p?.level === 10
                  ? "已达最高创作等级"
                  : "下一等级门槛未读取"}
            </span>
            {p?.scoreUpdatedOn ? (
              <span>分数更新 {p.scoreUpdatedOn}</span>
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
