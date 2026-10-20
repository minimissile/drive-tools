import { AppError, safeMessage } from "../../errors";
import { collectionInput } from "../../../shared/zhidao";
import {
  assertSourcePage,
  extractBaiduShares,
  normalizedName,
  parseZhidaoSearch,
  resourceName,
} from "../parsers";
import { wait } from "./context";
import type { OperationRun } from "../../../shared/zhidao";
import type { WorkerContext } from "./context";

export async function runCollect(
  ctx: WorkerContext,
  run: OperationRun,
  signal: AbortSignal,
) {
  const input = collectionInput.parse(run.config);
  let done = Number(run.config.processed ?? 0);
  const used = new Set(
    ctx.store
      .items(run.id)
      .filter((i) => i.link)
      .map((i) => i.link.split("?")[0]),
  );
  const errors: string[] = [];
  for (const a of input.accountIds) {
    await ctx.identity(a);
    signal.throwIfAborted();
  }
  const terms = [...new Set(input.keywords)];
  const max =
    input.mode === "precise"
      ? terms.length
      : Math.min(120, Math.max(16, input.count * 2));
  for (let index = done; index < max; index++) {
    signal.throwIfAborted();
    if (ctx.store.items(run.id).filter((i) => !!i.link).length >= input.count)
      break;
    const word = terms[index % terms.length];
    ctx.progress(
      run,
      `正在搜索「${word}」 · 已处理${index}/${max}`,
      ctx.store.items(run.id).filter((i) => !!i.link).length,
    );
    let candidates: {
      name: string;
      link: string;
      code: string;
      sourceName?: string;
      sourceUrl?: string;
      verified?: boolean;
    }[] = [];
    let sourceSuccess = false;
    if (input.pansou) {
      try {
        const rows = await ctx.pansou.search(
          word,
          ctx.settings().pansouUrl,
          signal,
        );
        signal.throwIfAborted();
        candidates.push(
          ...rows.map((r) => ({
            ...r,
            sourceName: "PanSou",
            sourceUrl: r.link,
            verified: true,
          })),
        );
        sourceSuccess = true;
      } catch (error) {
        signal.throwIfAborted();
        errors.push(safeMessage(error));
      }
    }
    if (input.zhidao && (input.mode === "fuzzy" || !candidates.length)) {
      try {
        const accountId = input.accountIds[index % input.accountIds.length];
        const firstPage =
          input.mode === "precise" ? 0 : Math.floor(index / terms.length) * 10;
        let inspected = 0;
        for (let page = 0; page < (input.mode === "precise" ? 10 : 1); page++) {
          const body = await ctx.client.text(
            accountId,
            `/search?${new URLSearchParams({ word: `${word} 百度网盘`, pn: String(firstPage + page * 10) })}`,
            signal,
          );
          signal.throwIfAborted();
          const results = parseZhidaoSearch(body);
          sourceSuccess = true;
          if (!results.length) break;
          for (const result of results) {
            if (inspected >= 10) break;
            inspected++;
            signal.throwIfAborted();
            const detail = await ctx.client.text(accountId, result.url, signal);
            signal.throwIfAborted();
            assertSourcePage(detail);
            const name = resourceName(result.title) || word;
            for (const share of extractBaiduShares(detail)) {
              if (!share.code || used.has(share.link.split("?")[0])) continue;
              candidates.push({
                ...share,
                name,
                sourceName: "百度知道",
                sourceUrl: result.url,
                verified: false,
              });
            }
            if (candidates.length >= 3 && input.mode === "precise") break;
            await wait(ctx.pace, signal);
          }
          if (candidates.length || inspected >= 10) break;
          await wait(ctx.pace, signal);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AppError && error.code === "SOURCE_VERIFICATION")
          throw error;
        errors.push(safeMessage(error));
      }
    }
    if (!sourceSuccess)
      throw new AppError(
        "COLLECTION_SOURCES_FAILED",
        errors.slice(-3).join("；") || "采集来源不可用。",
      );
    const unique = candidates.filter(
      (c, i, a) =>
        a.findIndex((v) => v.link.split("?")[0] === c.link.split("?")[0]) ===
          i && !used.has(c.link.split("?")[0]),
    );
    if (!unique.length)
      ctx.store.put(run.id, `miss:${index}`, {
        name: word,
        status: "skipped",
        message: errors.length
          ? `可用来源未命中；${errors.at(-1)}`
          : "来源正常，未找到符合条件的资源链接",
        evidence: word,
      });
    for (const candidate of input.mode === "precise"
      ? unique.slice(0, 1)
      : unique) {
      if (ctx.store.items(run.id).filter((i) => !!i.link).length >= input.count)
        break;
      used.add(candidate.link.split("?")[0]);
      ctx.store.put(run.id, normalizedName(candidate.link.split("?")[0]), {
        name: candidate.name,
        link: candidate.link,
        code: candidate.code,
        sourceName: candidate.sourceName,
        sourceUrl: candidate.sourceUrl,
        status: "ready",
        message: candidate.verified
          ? "来源验活通过"
          : "已提取链接；转存前检查有效性",
        backups: unique
          .filter((c) => c.link !== candidate.link)
          .slice(0, 2)
          .map((c) => ({ name: c.name, link: c.link, code: c.code })),
        evidence: word,
      });
    }
    done = index + 1;
    ctx.store.config(run.id, { ...input, processed: done });
    ctx.progress(
      run,
      `已处理${done}/${max}；已采集${ctx.store.items(run.id).filter((i) => !!i.link).length}条${errors.length ? `；最近来源提示：${errors.at(-1)}` : ""}`,
      ctx.store.items(run.id).filter((i) => !!i.link).length,
    );
    await wait(ctx.pace, signal);
  }
}
