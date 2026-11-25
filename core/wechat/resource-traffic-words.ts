import type { SmzdmResourceLink } from "../../shared/smzdm";
import {
  normalizeWechatTrafficWords,
  wechatTrafficWordLengthLimit,
  wechatTrafficWordLimit,
} from "../../shared/wechat-traffic-words";
import { parseJson, type Database } from "../database";

interface ResourceKeywordsRow {
  id: string;
  search_keywords: string | null;
}

export function resourceTrafficWords(
  db: Database,
  links: readonly SmzdmResourceLink[],
) {
  const resources = new Set<string>();
  const words: string[] = [];
  for (const link of links) {
    let resource = link.copyId
      ? db.get<ResourceKeywordsRow>(
          `SELECT r.id, r.search_keywords FROM copies c
           JOIN resources r ON r.id = c.resource_id WHERE c.id = ?`,
          link.copyId,
        )
      : undefined;
    if (!resource) {
      const address = link.ownUrl || link.url;
      const matches = db.all<ResourceKeywordsRow>(
        `SELECT id, search_keywords FROM resources WHERE source_url = ?
         UNION
         SELECT r.id, r.search_keywords FROM copies c
         JOIN resources r ON r.id = c.resource_id WHERE c.share_url = ?
         LIMIT 2`,
        address,
        address,
      );
      if (matches.length === 1) resource = matches[0];
    }
    if (!resource || resources.has(resource.id)) continue;
    resources.add(resource.id);
    const keywords = parseJson<unknown>(resource.search_keywords, []);
    if (Array.isArray(keywords))
      words.push(
        ...keywords.filter((word): word is string => typeof word === "string"),
      );
  }
  return normalizeWechatTrafficWords(words)
    .filter((word) => word.length <= wechatTrafficWordLengthLimit)
    .slice(0, wechatTrafficWordLimit);
}
