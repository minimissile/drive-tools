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
import {
  collectionDriveType,
  collectionLinkKey,
  type CollectionCandidate,
} from "../../../shared/resource-collection";
import {
  collectionPageCheckpoint,
  type CollectionSearchClient,
} from "../../resource-collection/checkpoint";

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
      .map((i) => collectionLinkKey(i.link)),
  );
  for (const a of input.zhidao ? input.accountIds : []) {
    await ctx.identity(a);
    signal.throwIfAborted();
  }
  const terms = [...new Set(input.keywords)];
  let checkpoint = { ...run.config };
  const saveCheckpoint = (values: Record<string, unknown>) => {
    checkpoint = { ...checkpoint, ...values };
    ctx.store.config(run.id, checkpoint);
  };
  const sources: {
    id: "pansoo" | "haisou";
    enabled: boolean;
    client: CollectionSearchClient;
    finished: Set<string>;
  }[] = [
    {
      id: "pansoo",
      enabled: input.pansoo,
      client: ctx.pansoo,
      finished: new Set(
        Array.isArray(checkpoint.pansooFinished)
          ? checkpoint.pansooFinished.map(String)
          : [],
      ),
    },
    {
      id: "haisou",
      enabled: input.haisou,
      client: ctx.haisou,
      finished: new Set(
        Array.isArray(checkpoint.haisouFinished)
          ? checkpoint.haisouFinished.map(String)
          : [],
      ),
    },
  ];
  const max =
    input.mode === "precise"
      ? terms.length
      : Math.min(120, Math.max(16, input.count * 2));
  for (let index = done; index < max; index++) {
    signal.throwIfAborted();
    if (
      !input.pansou &&
      !input.zhidao &&
      sources
        .filter((source) => source.enabled)
        .every((source) => source.finished.size >= terms.length)
    )
      break;
    if (ctx.store.items(run.id).filter((i) => !!i.link).length >= input.count)
      break;
    const word = terms[index % terms.length];
    ctx.progress(
      run,
      `正在搜索「${word}」 · 已处理${index}/${max}`,
      ctx.store.items(run.id).filter((i) => !!i.link).length,
    );
    const candidates: CollectionCandidate[] = [];
    const errors: string[] = [];
    const pageErrors: unknown[] = [];
    const currentPage = collectionPageCheckpoint(
      checkpoint.collectionPage,
      index,
    );
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
    for (const source of sources.filter((entry) => entry.enabled)) {
      try {
        if (!source.finished.has(word)) {
          const page =
            input.mode === "precise" ? 1 : Math.floor(index / terms.length) + 1;
          let result = currentPage[source.id];
          if (!result) {
            result = await source.client.search(word, page, signal);
            currentPage[source.id] = result;
            // Save the successful response before another source or stop can interrupt the page.
            saveCheckpoint({ collectionPage: currentPage });
          }
          signal.throwIfAborted();
          candidates.push(...result.rows);
          if (!result.hasMore) source.finished.add(word);
        }
        sourceSuccess = true;
      } catch (error) {
        signal.throwIfAborted();
        errors.push(safeMessage(error));
        pageErrors.push(error);
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
              if (!share.code || used.has(collectionLinkKey(share.link)))
                continue;
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
        a.findIndex(
          (v) => collectionLinkKey(v.link) === collectionLinkKey(c.link),
        ) === i && !used.has(collectionLinkKey(c.link)),
    );
    if (!unique.length && !pageErrors.length)
      ctx.store.put(run.id, `miss:${index}`, {
        name: word,
        status: "skipped",
        message: errors.length
          ? `可用来源未命中；${errors.at(-1)}`
          : candidates.length
            ? "本轮结果已在此任务中，不重复采集"
            : "来源正常，未找到符合条件的资源链接",
        evidence: word,
      });
    for (const candidate of input.mode === "precise"
      ? unique.slice(0, 1)
      : unique) {
      if (ctx.store.items(run.id).filter((i) => !!i.link).length >= input.count)
        break;
      used.add(collectionLinkKey(candidate.link));
      ctx.store.put(run.id, collectionLinkKey(candidate.link), {
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
          .filter(
            (c) =>
              c.link !== candidate.link &&
              collectionDriveType(c.link) ===
                collectionDriveType(candidate.link) &&
              normalizedName(c.name) === normalizedName(candidate.name),
          )
          .slice(0, 2)
          .map((c) => ({ name: c.name, link: c.link, code: c.code })),
        evidence: word,
      });
    }
    // Keep successful sources' rows, but do not skip a failed website page on resume.
    if (pageErrors.length)
      throw new AppError(
        "COLLECTION_PAGE_FAILED",
        pageErrors.map(safeMessage).join("；"),
      );
    done = index + 1;
    saveCheckpoint({
      ...input,
      processed: done,
      collectionPage: undefined,
      ...Object.fromEntries(
        sources.map((source) => [`${source.id}Finished`, [...source.finished]]),
      ),
    });
    ctx.progress(
      run,
      `已处理${done}/${max}；已采集${ctx.store.items(run.id).filter((i) => !!i.link).length}条${errors.length ? `；最近来源提示：${errors.at(-1)}` : ""}`,
      ctx.store.items(run.id).filter((i) => !!i.link).length,
    );
    await wait(ctx.pace, signal);
  }
}
