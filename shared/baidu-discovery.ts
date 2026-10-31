import { z } from "zod";

export const discoverySources = ["suggest", "related"] as const;
export type DiscoverySource = (typeof discoverySources)[number];
export const discoverySourceLabels: Record<DiscoverySource, string> = {
  suggest: "下拉联想词",
  related: "相关搜索",
};
export const normalizeDiscoveryWord = (word: string) =>
  word.normalize("NFKC").replace(/\s+/g, " ").trim();
export const discoveryWordKey = (word: string) =>
  normalizeDiscoveryWord(word).toLocaleLowerCase("zh-CN");
export function discoverySeeds(text: string): string[] {
  const words = new Map<string, string>();
  for (const part of text.split(/[\n\r,，;；]+/)) {
    const word = normalizeDiscoveryWord(part);
    if (word) words.set(discoveryWordKey(word), word);
  }
  return [...words.values()];
}
const wordSchema = z.string().trim().min(1).max(100);
export const discoveryInputSchema = z
  .object({
    seeds: z
      .array(wordSchema)
      .min(1, "请至少输入一个关键词。")
      .max(200, "最多输入200个关键词。"),
    sources: z
      .array(z.enum(discoverySources))
      .min(1, "请至少选择一种采集来源。")
      .max(2),
    maxDepth: z.number().int().min(1).max(3),
    maxQueries: z.number().int().min(1).max(500),
    intervalMs: z.number().int().min(1500).max(30000),
  })
  .refine((v) => v.maxQueries >= new Set(v.seeds.map(discoveryWordKey)).size, {
    message: "查询上限不能少于输入关键词的数量。",
    path: ["maxQueries"],
  });
export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
export const discoveryOriginSchema = z.object({
  source: z.enum(discoverySources),
  query: wordSchema,
  seed: wordSchema,
  depth: z.number().int().min(1).max(4),
  url: z.string().url(),
  at: z.string(),
});
export const discoveryWordSchema = z.object({
  key: z.string(),
  word: wordSchema,
  origins: z.array(discoveryOriginSchema),
});
export type DiscoveryWord = z.infer<typeof discoveryWordSchema>;
export const discoveryQuerySchema = z.object({
  word: wordSchema,
  seed: wordSchema,
  depth: z.number().int().min(0).max(3),
  completedSources: z.array(z.enum(discoverySources)),
  status: z.enum(["pending", "completed", "skipped"]),
  message: z.string(),
});
export const discoveryRunSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["running", "paused", "waiting", "completed"]),
  input: discoveryInputSchema,
  queries: z.array(discoveryQuerySchema).max(500),
  words: z.array(discoveryWordSchema).max(10000),
  removedKeys: z.array(z.string().max(200)).max(100000).default([]),
  materialPool: z
    .object({
      brief: z.string().max(6000),
      entries: z.array(z.string().min(1).max(2000)).min(1).max(10),
      requestedCount: z.number().int().min(1).max(10).optional(),
      warnings: z.array(z.string().max(300)).max(20).default([]),
      createdAt: z.string(),
    })
    .nullable()
    .default(null),
  message: z.string(),
  currentWord: z.string(),
  limited: z.boolean(),
});
export type DiscoveryRun = z.infer<typeof discoveryRunSchema>;
export type DiscoverySummary = Omit<
  DiscoveryRun,
  "queries" | "words" | "removedKeys" | "materialPool"
> & {
  queryCount: number;
  completedCount: number;
  wordCount: number;
};
export interface BaiduDiscoveryPort {
  read(
    source: DiscoverySource,
    keyword: string,
    signal: AbortSignal,
  ): Promise<string[]>;
  open(keyword?: string): Promise<void>;
  isOpen(): boolean;
  close(): void;
}
type Contract<A, V> = { args: A; value: V };
export interface BaiduDiscoveryContract {
  "baiduDiscovery.list": Contract<undefined, DiscoverySummary[]>;
  "baiduDiscovery.get": Contract<{ id: string }, DiscoveryRun>;
  "baiduDiscovery.start": Contract<DiscoveryInput, DiscoveryRun>;
  "baiduDiscovery.pause": Contract<{ id: string }, DiscoveryRun>;
  "baiduDiscovery.resume": Contract<{ id: string }, DiscoveryRun>;
  "baiduDiscovery.skip": Contract<{ id: string }, DiscoveryRun>;
  "baiduDiscovery.expand": Contract<
    { id: string; words: string[] },
    DiscoveryRun
  >;
  "baiduDiscovery.open": Contract<{ id?: string }, void>;
  "baiduDiscovery.removeWord": Contract<
    { id: string; key: string },
    DiscoveryRun
  >;
  "baiduDiscovery.insertZhidao": Contract<
    { id: string; keys?: string[]; links: string; materials: string[] },
    import("./zhidao-publishing").QuestionDraftInsertResult
  >;
  "baiduDiscovery.generateMaterials": Contract<
    {
      id: string;
      keys?: string[];
      brief: string;
      count: number;
      authorized: true;
    },
    NonNullable<DiscoveryRun["materialPool"]>
  >;
  "baiduDiscovery.closeBrowser": Contract<undefined, void>;
  "baiduDiscovery.openShareBrowser": Contract<undefined, void>;
  "baiduDiscovery.closeShareBrowser": Contract<undefined, void>;
  "baiduDiscovery.inspectShare": Contract<
    { sourceText: string; code?: string; parentId?: string; page?: number },
    import("./types").ShareInspection
  >;
  "baiduDiscovery.export": Contract<
    { id: string; words?: string[]; format: "csv" | "txt" },
    string | null
  >;
}
