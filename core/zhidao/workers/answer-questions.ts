import {
  zhidaoQuestionPageSize,
  type ZhidaoQuestion,
  type ZhidaoQuestionPage,
} from "../client";

export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const other = Math.floor(random() * (i + 1));
    [result[i], result[other]] = [result[other], result[i]];
  }
  return result;
}

/** Read 3–5 pages before drawing questions. Only a bounded sample is fetched. */
export async function* sampledQuestions(
  loadPage: (base: number) => Promise<ZhidaoQuestionPage>,
  random = Math.random,
): AsyncGenerator<ZhidaoQuestion> {
  const first = await loadPage(0);
  const pageCount = first.total
    ? Math.ceil(first.total / zhidaoQuestionPageSize)
    : null;
  const visited = new Set([0]);
  const seen = new Set<string>();
  let latest = first;
  let pool = [...first.items];
  let firstBatch = true;
  let exhausted = false;
  while (true) {
    const batchSize = 3 + Math.floor(random() * 3);
    for (let i = firstBatch ? 1 : 0; i < batchSize && visited.size < 50; i++) {
      let base: number;
      if (pageCount !== null) {
        if (visited.size >= pageCount) break;
        // Select uniformly among unvisited pages without allocating the full catalogue.
        let page = Math.floor(random() * (pageCount - visited.size));
        for (const read of [...visited]
          .map((n) => n / zhidaoQuestionPageSize)
          .sort((a, b) => a - b))
          if (read <= page) page++;
        base = page * zhidaoQuestionPageSize;
      } else {
        if (!latest.hasMore) break;
        base = latest.nextBase;
        if (!Number.isSafeInteger(base) || base < 0 || visited.has(base)) {
          exhausted = true;
          break;
        }
      }
      visited.add(base);
      latest = await loadPage(base);
      pool.push(...latest.items);
    }
    for (const item of shuffled(pool, random)) {
      const qid = String(item.qid ?? "");
      if (seen.has(qid)) continue;
      seen.add(qid);
      yield item;
    }
    if (
      exhausted ||
      visited.size >= Math.min(50, pageCount ?? Infinity) ||
      (pageCount === null && (!latest.hasMore || visited.has(latest.nextBase)))
    )
      return;
    pool = [];
    firstBatch = false;
  }
}
