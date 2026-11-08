import { createHash } from "node:crypto";
import type { Database } from "../database";
import {
  planWechatTrafficWords,
  wechatTrafficWordUsage,
  type WechatTrafficWordCount,
} from "../../shared/wechat-traffic-words";

function historyKey(sourceUrl: string) {
  const url = new URL(sourceUrl);
  url.hash = "";
  if (url.pathname !== "/s") url.search = "";
  else {
    const fields = new URLSearchParams();
    for (const key of ["__biz", "mid", "idx", "sn"])
      if (url.searchParams.has(key))
        fields.set(key, url.searchParams.get(key)!);
    if (fields.has("__biz") && fields.has("mid"))
      url.search = fields.toString();
    else url.searchParams.sort();
  }
  return `wechat:traffic-word-history:v1:${createHash("sha256").update(url.href).digest("hex")}`;
}

export function wechatTrafficWordPlan(
  db: Database,
  sourceUrl: string,
  words: readonly string[],
) {
  return planWechatTrafficWords(
    words,
    db.setting<WechatTrafficWordCount[]>(historyKey(sourceUrl), []),
  );
}

/** Called in the same transaction as the validated rewritten article. */
export function recordWechatTrafficWords(
  db: Database,
  sourceUrl: string,
  words: readonly string[],
  title: string,
  body: string,
) {
  const used = wechatTrafficWordUsage(words, title, body).used;
  if (!used.length) return;
  const key = historyKey(sourceUrl);
  const history = new Map(
    db
      .setting<WechatTrafficWordCount[]>(key, [])
      .map(({ word, uses }) => [word, uses]),
  );
  for (const word of used) {
    const normalized = word.toLocaleLowerCase();
    history.set(normalized, (history.get(normalized) ?? 0) + 1);
  }
  db.setSetting(
    key,
    Array.from(history, ([word, uses]) => ({ word, uses })),
  );
}
