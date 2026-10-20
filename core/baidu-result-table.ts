import { createHash } from "node:crypto";
import { id, now } from "./database";
import { AppError } from "./errors";
import { readTableBytes, readXlsx } from "./table-files";
import {
  baiduKeywordInputSchema,
  baiduKeywordSource,
  type BaiduKeywordResult,
} from "../shared/baidu-keywords";

/** Official task CSV/XLSX exports. Keep index/growth columns distinct from monthly volume. */
export function baiduTaskKeywordChunks(
  accountId: string,
  uid: string,
  taskId: string,
  name: string,
  bytes: Buffer,
) {
  const rows = /\.xlsx$/i.test(name)
    ? readXlsx(bytes, 100001)
    : readTableBytes(name, bytes);
  if (rows.length < 1 || rows.length > 100001)
    throw new AppError(
      "BAIDU_TASK_TABLE_LIMIT",
      "百度任务结果最多支持10万词。",
    );
  const header = rows[0].map((s) => s.trim().replace(/^\uFEFF/, ""));
  const wordIndex = header.findIndex((s) =>
    ["关键词", "关键字", "keyword", "keywordName", "wordName"].includes(s),
  );
  const monthlyIndex = header.findIndex((s) =>
    ["月均搜索量", "月搜索量", "averageMonthPv"].includes(s),
  );
  if (wordIndex < 0 || monthlyIndex < 0)
    throw new AppError(
      "BAIDU_TASK_MONTHLY_MISSING",
      "结果表未包含关键词和月均搜索量列，无法按大于10的规则收录。请先下载核对，或将候选词带入流量查询补充指标。",
    );
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 24),
    fetchedAt = now();
  const columns: Record<string, string> = {
    点击指导价: "recommendPrice",
    竞争激烈程度: "competition",
    月均移动搜索量: "averageMonthPvMobile",
    月均计算机搜索量: "averageMonthPvPc",
    特色: "showReasons",
    分组维度: "groupName",
  };
  const keywords = rows.slice(1).flatMap((row) => {
    const word = row[wordIndex]?.trim();
    if (!word || word.length > 200) return [];
    const metrics: Record<string, string | number | null> = {
      averageMonthPv: row[monthlyIndex]?.trim() ?? null,
    };
    header.forEach((h, i) => {
      if (columns[h] && row[i]) metrics[columns[h]] = row[i].trim();
    });
    return [
      {
        id: id("baidu_kw"),
        word,
        source: baiduKeywordSource,
        platform: "baidu",
        metrics,
        fetchedAt,
        sourceUpdatedAt: null,
      },
    ];
  });
  const unique=[...new Map(keywords.map(k=>[k.word.normalize("NFKC").trim().toLowerCase(),k])).values()];
  const chunks: BaiduKeywordResult[] = [];
  for (let i = 0; i < unique.length; i += 3000)
    chunks.push({
      id: `baidu-task-${uid}-${taskId}-${hash}-${i}`,
      accountUid: uid,
      input: baiduKeywordInputSchema.parse({
        accountId,
        seeds: ["百度拓词任务"],
      }),
      keywords: unique.slice(i, i + 3000),
      total: unique.length,
      fetchedAt,
    });
  return { received: unique.length, chunks };
}
