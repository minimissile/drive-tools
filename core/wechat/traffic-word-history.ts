import { createHash } from "node:crypto";
import type { Database } from "../database";
import type { WechatArticle, WechatDeliveryRecord } from "../../shared/wechat";
import { wechatSourceIdentity } from "./article-family";
import {
  planWechatTrafficWords,
  normalizeWechatTrafficWords,
  wechatTrafficWordUsage,
  type WechatTrafficWordCount,
  type WechatTrafficWordDeliveryCoverage,
} from "../../shared/wechat-traffic-words";

function historyKey(sourceUrl: string) {
  return `wechat:traffic-word-history:v1:${createHash("sha256").update(wechatSourceIdentity(sourceUrl)).digest("hex")}`;
}

export function wechatTrafficWordPlan(
  db: Database,
  sourceUrl: string,
  words: readonly string[],
  deliveryCoverage?: WechatTrafficWordDeliveryCoverage,
) {
  return planWechatTrafficWords(
    words,
    db.setting<WechatTrafficWordCount[]>(historyKey(sourceUrl), []),
    deliveryCoverage,
  );
}

/** Only read the current body when it still matches the recorded sent revision. */
export function wechatDeliveryWordCoverage(
  rawWords: readonly string[],
  family: readonly WechatArticle[],
): WechatTrafficWordDeliveryCoverage {
  const words = normalizeWechatTrafficWords(rawWords);
  const covered = new Set<string>();
  let count = 0;
  let incomplete = false;
  for (const article of family) {
    const deliveries: Pick<
      WechatDeliveryRecord,
      "revision" | "title" | "trafficWordUsage"
    >[] = article.deliveryHistory?.length
      ? article.deliveryHistory
      : article.remote
        ? [{ revision: article.remote.revision, title: "" }]
        : [];
    for (const delivery of deliveries) {
      count++;
      if (delivery.revision === article.revision) {
        const { used } = wechatTrafficWordUsage(
          words,
          article.title,
          article.body,
        );
        used.forEach((word) => covered.add(word));
        continue;
      }
      const snapshot = delivery.trafficWordUsage;
      const keys = (values: string[]) =>
        new Set(values.map((word) => word.toLocaleLowerCase()));
      const used = keys(snapshot?.used ?? []);
      const checked = keys(snapshot?.unused ?? []);
      const titleWords = new Set(
        wechatTrafficWordUsage(words, delivery.title, "").used,
      );
      for (const word of words) {
        const key = word.toLocaleLowerCase();
        if (used.has(key) || titleWords.has(word)) covered.add(word);
        else if (!checked.has(key)) incomplete = true;
      }
    }
  }
  return {
    count,
    coveredWords: words.filter((word) => covered.has(word)),
    incomplete,
  };
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
