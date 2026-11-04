/** Read only the account's named score fields, never radar averages or history. */
export function parseZhihuCreatorScore(raw: string) {
  const text = raw.replace(/[\u200b-\u200d\uFEFF]/g, "");
  const numeric = "(0|[1-9]\\d*|[1-9]\\d{0,2}(?:[,，]\\d{3})+)";
  const value = (raw: string) => Number(raw.replace(/[,，]/g, ""));
  const scores = Array.from(
    text.matchAll(new RegExp(`当前创作分\\s*${numeric}(?![\\d,，.])`, "g")),
    (m) => value(m[1]),
  );
  const score =
    scores.length &&
    scores.every((n) => Number.isSafeInteger(n) && n === scores[0])
      ? scores[0]
      : null;
  const bars = Array.from(
    text.matchAll(
      new RegExp(
        `距离下一等级达成还需\\s*${numeric}\\s*分\\s*${numeric}\\s*/\\s*${numeric}(?![\\d,，.])`,
        "g",
      ),
    ),
  );
  const thresholds = bars.map((m) => {
    const remaining = value(m[1]),
      current = value(m[2]),
      total = value(m[3]);
    return [remaining, current, total].every(Number.isSafeInteger) &&
      score !== null &&
      current === score &&
      total > 0 &&
      total >= current &&
      remaining === total - current
      ? total
      : null;
  });
  const nextLevelScore =
    thresholds.length &&
    thresholds.every((n) => n !== null && n === thresholds[0])
      ? thresholds[0]
      : null;
  const updated = text.match(/当前已更新至\s*(\d{4}-\d{2}-\d{2})(?!\d)/)?.[1];
  const date = updated ? new Date(`${updated}T00:00:00Z`) : null;
  return {
    score,
    nextLevelScore,
    scoreUpdatedOn:
      score !== null &&
      date &&
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === updated
        ? updated!
        : null,
  };
}

export const zhihuGrowthDimensions = [
  "创作活跃度",
  "创作垂直度",
  "内容优质分",
  "创作影响力",
  "关注者亲密度",
  "社区成就分",
] as const;
/** Only explicit official dimension labels; never turn changes or averages into current scores. */
export function parseZhihuGrowthDimensions(raw: string, total: number | null) {
  const text = raw.replace(/[\u200b-\u200d\uFEFF]/g, "");
  const names = zhihuGrowthDimensions.join("|");
  const definitions = [
    ...text.matchAll(
      new RegExp(
        `(${names})\\s*(日更|周更|月更)\\s*([\\s\\S]*?)(?=(?:${names})\\s*(?:日更|周更|月更)|创作分变更记录|$)`,
        "g",
      ),
    ),
  ];
  const start = text.indexOf("创作分雷达图"),
    end = text.indexOf("维度释义", start);
  const chart = start >= 0 && end > start ? text.slice(start, end) : "";
  const values = zhihuGrowthDimensions.map((name) => {
    const matches = [
      ...chart.matchAll(
        new RegExp(
          `(0|[1-9]\\d*|[1-9]\\d{0,2}(?:[,，]\\d{3})+)\\s*${name}`,
          "g",
        ),
      ),
    ];
    return matches.length === 1
      ? Number(matches[0][1].replace(/[,，]/g, ""))
      : null;
  });
  const exact =
    values.every((v) => v !== null && Number.isSafeInteger(v)) &&
    total !== null &&
    values.reduce<number>((n, v) => n + (v ?? 0), 0) === total;
  return definitions
    .filter((d, i, a) => a.findIndex((m) => m[1] === d[1]) === i)
    .map((d) => ({
      name: d[1],
      cadence: d[2],
      description: d[3].trim().slice(0, 1000),
      score: exact
        ? values[
            zhihuGrowthDimensions.indexOf(
              d[1] as (typeof zhihuGrowthDimensions)[number],
            )
          ]
        : null,
    }));
}
