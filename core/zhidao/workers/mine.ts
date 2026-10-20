import { z } from "zod";
import { now } from "../../database";
import { safeMessage } from "../../errors";
import { miningInput } from "../../../shared/zhidao";
import { normalizedName } from "../parsers";
import { collectNames, publicEvidence } from "../mining";
import type { OperationRun } from "../../../shared/zhidao";
import type { WorkerContext } from "./context";

export async function runMine(
  ctx: WorkerContext,
  run: OperationRun,
  signal: AbortSignal,
) {
  const input = miningInput.parse(run.config);
  ctx.repo.db.run(
    "DELETE FROM mining_history WHERE seen_at<?",
    new Date(Date.now() - 3 * 86400000).toISOString(),
  );
  const known = new Set(
    ctx.repo.db
      .all<{ word: string }>(
        "SELECT word FROM mining_history WHERE category=? AND seen_at>?",
        input.category,
        new Date(Date.now() - 3 * 86400000).toISOString(),
      )
      .map((r) => r.word),
  );
  for (const i of ctx.store.items(run.id)) known.add(normalizedName(i.name));
  const add = (item: {
    name: string;
    sourceName: string;
    sourceUrl: string;
    evidence: string;
  }) => {
    signal.throwIfAborted();
    const key = normalizedName(item.name);
    ctx.store.put(run.id, key, { ...item, status: "ready" });
    ctx.repo.db.run(
      "INSERT INTO mining_history(category,word,seen_at) VALUES(?,?,?) ON CONFLICT(category,word) DO UPDATE SET seen_at=excluded.seen_at",
      input.category,
      key,
      now(),
    );
    ctx.progress(
      run,
      `已采集${ctx.store.items(run.id).length}/${input.count}个名称`,
    );
  };
  const warnings: string[] = [];
  if (input.live && ctx.store.items(run.id).length < input.count) {
    try {
      ctx.progress(run, "正在检索近两周的公开热点证据…");
      const evidence = await publicEvidence(
        `${input.category} 最新 热门 排行榜 ${new Date().toISOString().slice(0, 10)}`,
        ctx.fetcher,
        signal,
      );
      signal.throwIfAborted();
      if (evidence.length) {
        const generated = await ctx.ai.resourceExport(
          "zhidao_hot_names",
          z.object({
            names: z
              .array(
                z.object({
                  name: z.string().max(40),
                  sourceIndex: z.number().int().min(0),
                }),
              )
              .max(30),
          }),
          "只从提供的网页标题和摘要中提取具体作品或软件名称。禁止凭记忆补充，禁止把榜单网页标题当作品名；sourceIndex指向提供的证据数组下标。不足就返回实际数量。",
          { category: input.category, date: now(), evidence },
        );
        signal.throwIfAborted();
        for (const item of generated.names) {
          if (ctx.store.items(run.id).length >= input.count) break;
          const source = evidence[item.sourceIndex];
          if (
            !source ||
            !normalizedName(source.title + source.snippet).includes(
              normalizedName(item.name),
            ) ||
            known.has(normalizedName(item.name))
          )
            continue;
          known.add(normalizedName(item.name));
          add({
            name: item.name,
            sourceName: "公开搜索候选",
            sourceUrl: source.url,
            evidence: source.title + "：" + source.snippet,
          });
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      warnings.push(`公开搜索整理未完成：${safeMessage(error)}`);
    }
  }
  let result = { added: 0, errors: [] as string[] };
  if (ctx.store.items(run.id).length < input.count) {
    try {
      result = await collectNames(
        input.category,
        input.count - ctx.store.items(run.id).length,
        ctx.fetcher,
        signal,
        (name) => ctx.progress(run, `正在读取${name}…`),
        add,
        known,
      );
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (!ctx.store.items(run.id).length) throw error;
      warnings.push(safeMessage(error));
    }
  }
  result.errors.push(...warnings);
  const count = ctx.store.items(run.id).length;
  ctx.progress(
    run,
    `实际采集${count}/${input.count}条${result.errors.length ? `；${result.errors.join("；")}` : ""}`,
    count,
  );
}
