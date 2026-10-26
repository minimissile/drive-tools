import { z } from "zod";
import { parseJson } from "./database";
import type { Repository } from "./repository";
import type { SearchOperations } from "./search";
import type {
  ContentKeyword,
  ContentResourceMatch,
} from "../shared/content-sources";

export const sameContentWord = (word: string) =>
  word.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** Local discovery shared by publishing channels. Never performs a paid or remote query. */
export class ContentSources {
  constructor(
    private repo: Repository,
    private search: Pick<SearchOperations, "assertTarget">,
  ) {}
  words(raw: unknown): ContentKeyword[] {
    const { query } = z
      .object({ query: z.string().trim().max(100) })
      .parse(raw);
    const term = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.repo.db.all<{
      id: string;
      word: string;
      source: string;
      observed_at: string | null;
      metrics: string;
    }>(
      "SELECT i.id,i.word,i.source,i.observed_at,i.metrics FROM traffic_items i WHERE i.kind='word' AND i.word LIKE ? ESCAPE '\\' ORDER BY coalesce(i.observed_at,'') DESC,i.rowid DESC LIMIT 60",
      term,
    );
    const result: ContentKeyword[] = rows.map((r) => ({
      id: `knowledge:${r.id}`,
      word: r.word,
      source: r.source,
      observedAt: r.observed_at,
      metrics: parseJson(r.metrics, {}),
    }));
    for (const pool of this.repo.pools())
      for (const word of pool.keywords) {
        if (!word.word.toLowerCase().includes(query.toLowerCase())) continue;
        result.push({
          id: `pool:${pool.id}:${word.id}`,
          word: word.word,
          source: `词池：${pool.name} · ${word.source}`,
          observedAt: word.fetchedAt ?? pool.createdAt,
          metrics: word.metrics,
        });
        if (result.length >= 100) break;
      }
    return [
      ...new Map(
        result.map((word) => [
          `${sameContentWord(word.word)}:${word.source}`,
          word,
        ]),
      ).values(),
    ].slice(0, 30);
  }
  matches(raw: unknown): ContentResourceMatch[] {
    const { keyword } = z
      .object({ keyword: z.string().trim().max(100) })
      .parse(raw);
    const tokens = new Set(
      keyword
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9.+#-]*|[\u3400-\u9fff]{2,}/g) ?? [],
    );
    for (const token of [...tokens])
      if (/^[\u3400-\u9fff]+$/.test(token))
        for (let i = 0; i < token.length - 1; i++)
          tokens.add(token.slice(i, i + 2));
    for (const generic of [
      "教程",
      "资料",
      "安装",
      "下载",
      "分享",
      "如何",
      "使用",
      "完整",
      "入门",
      "步骤",
    ])
      tokens.delete(generic);
    const args: string[] = [];
    const clauses = [...tokens].map((token) => {
      args.push(token);
      return "instr(lower(r.title||' '||r.summary||' '||r.tags||' '||c.files),?)>0";
    });
    const rows = this.repo.db.all<{
      copy_id: string;
      resource_id: string;
    }>(
      `SELECT c.id copy_id,r.id resource_id FROM copies c JOIN resources r ON r.id=c.resource_id JOIN accounts a ON a.id=c.account_id WHERE c.status='ready' AND a.enabled=1 AND c.owner_uid=a.uid AND c.share_owner_uid=a.uid AND c.share_verified_at IS NOT NULL ${clauses.length ? `AND (${clauses.join(" OR ")})` : ""} ORDER BY r.updated_at DESC LIMIT 300`,
      ...args,
    );
    return rows
      .flatMap((row) => {
        const resource = this.repo.getResource(row.resource_id),
          copy = this.repo.getCopy(row.copy_id);
        const text =
          `${resource.title} ${resource.summary} ${resource.tags.join(" ")} ${copy.files.map((f) => f.name).join(" ")}`.toLowerCase();
        const matchedTerms = [...tokens].filter((token) =>
          text.includes(token),
        );
        try {
          this.search.assertTarget(copy.id, null);
        } catch {
          return [];
        }
        return [
          {
            resourceId: resource.id,
            copyId: copy.id,
            title: resource.title,
            summary: resource.summary.slice(0, 400),
            accountAlias: this.repo.getAccount(copy.accountId).alias,
            matchedTerms,
          },
        ];
      })
      .sort(
        (a, b) =>
          b.matchedTerms.reduce((n, t) => n + t.length, 0) -
          a.matchedTerms.reduce((n, t) => n + t.length, 0),
      )
      .slice(0, 30);
  }
}
