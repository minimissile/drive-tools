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
