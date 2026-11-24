import { discoveryWordKey } from "../shared/baidu-discovery";
import { setTimeout as delay } from "node:timers/promises";
import type { AppPorts } from "./ports";
import { AppError, safeMessage } from "./errors";
import {
  mergeKeywordCandidates,
  normalizeResourceKeywords,
  resourceKeywordLimit,
  resourceSeedLimit,
  type KeywordCandidate,
  type KeywordLookup,
  type ResourceKeywordSource,
  type KeywordBatch,
  type KeywordSourcesCheck,
  type KeywordSourceChannel,
} from "../shared/resource-keywords";

export async function checkKeywordSources(
  ports: Pick<AppPorts, "baiduDiscovery" | "keywordWebBrowser">,
  checkMarketing?: () => Promise<void>,
): Promise<KeywordSourcesCheck> {
  const signal = AbortSignal.timeout(25_000);
  const check = async (
    channel: KeywordSourceChannel,
    action: (() => Promise<void>) | undefined,
  ): Promise<
    [KeywordSourceChannel, KeywordSourcesCheck["sources"][KeywordSourceChannel]]
  > => {
    if (!action)
      return [
        channel,
        {
          status: "unconfigured",
          message:
            channel === "baidu-marketing"
              ? "请在账号管理中选择已接入的百度营销账号。"
              : "当前客户端尚未加载来源检查，请应用更新后重试。",
        },
      ];
    try {
      await action();
      return [
        channel,
        {
          status: "ready",
          message:
            channel === "baidu-marketing"
              ? "已有百度营销登录会话可用，检索时会再次核验。"
              : "检索页面可访问，实际结果以本次检索返回为准。",
        },
      ];
    } catch (cause) {
      const loginRequired =
        cause instanceof AppError &&
        [
          "KEYWORD_5118_LOGIN_REQUIRED",
          "WEBSITE_LOGIN_REQUIRED",
          "BAIDU_LOGIN_REQUIRED",
        ].includes(cause.code);
      return [
        channel,
        {
          status: loginRequired ? "login_required" : "unavailable",
          message: safeMessage(cause),
        },
      ];
    }
  };
  const sources = await Promise.all([
    check("baidu-marketing", checkMarketing),
    check(
      "baidu",
      ports.baiduDiscovery?.check &&
        (() => ports.baiduDiscovery!.check!(signal)),
    ),
    check(
      "5118",
      ports.keywordWebBrowser && (() => ports.keywordWebBrowser!.check(signal)),
    ),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    sources: Object.fromEntries(sources) as KeywordSourcesCheck["sources"],
  };
}

/** Pipeline independent sources; each shared browser/account channel remains serial. */
export async function lookupResourceKeywordBatch(
  batch: KeywordBatch,
  ports: KeywordPorts,
  readMarketingWords: ((words: string[]) => Promise<string[]>) | undefined,
  changed: () => void,
) {
  const serial = () => {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(action: () => Promise<T>) => {
      const task = tail.then(action);
      tail = task.catch(() => {});
      return task;
    };
  };
  const baidu = serial(),
    longtail = serial(),
    marketing = serial();
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, action: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, action());
    return cache.get(key) as Promise<T>;
  };
  const scoped: KeywordPorts = {
    ...ports,
    baiduDiscovery: ports.baiduDiscovery && {
      ...ports.baiduDiscovery,
      read: (source, seed, signal) =>
        once(`baidu:${source}:${discoveryWordKey(seed)}`, () =>
          baidu(() => {
            signal.throwIfAborted();
            return ports.baiduDiscovery!.read(source, seed, signal);
          }),
        ),
      ...(ports.baiduDiscovery.readSearchWords
        ? {
            readSearchWords: (seed: string, signal: AbortSignal) =>
              once(`search:${discoveryWordKey(seed)}`, () =>
                baidu(() => {
                  signal.throwIfAborted();
                  return ports.baiduDiscovery!.readSearchWords!(seed, signal);
                }),
              ),
          }
        : {}),
    },
    read5118PublicKeywords:
      ports.read5118PublicKeywords &&
      ((seed, signal) =>
        once(`5118:${discoveryWordKey(seed)}`, () =>
          longtail(() => {
            signal.throwIfAborted();
            return ports.read5118PublicKeywords!(seed, signal);
          }),
        )),
  };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, batch.items.length) }, async () => {
      for (;;) {
        const item = batch.items[cursor++];
        if (!item) return;
        item.status = "running";
        changed();
        try {
          item.result = await lookupResourceKeywords(
            item.seeds,
            scoped,
            readMarketingWords
              ? (words) =>
                  once(
                    `marketing:${JSON.stringify(words.map(discoveryWordKey))}`,
                    () => marketing(() => readMarketingWords(words)),
                  )
              : undefined,
          );
          item.status = "completed";
        } catch (error) {
          item.status = "failed";
          item.message = safeMessage(error);
        }
        changed();
      }
    }),
  );
  batch.status = "completed";
  changed();
  return batch;
}

type KeywordPorts = Pick<AppPorts, "baiduDiscovery" | "read5118PublicKeywords">;

export async function lookupResourceKeywords(
  seeds: string[],
  ports: KeywordPorts,
  readMarketingWords?: (words: string[]) => Promise<string[]>,
): Promise<KeywordLookup> {
  const words = normalizeResourceKeywords(seeds);
  if (words.length > resourceSeedLimit)
    throw new AppError(
      "KEYWORD_SEEDS",
      `一次最多检索 ${resourceSeedLimit} 个搜索词。`,
    );
  if (
    !words.length ||
    words.length !== new Set(seeds.map(discoveryWordKey)).size
  )
    throw new AppError("KEYWORD_SEEDS", "请输入真实的搜索词，不要粘贴链接。");
  const channel = async (name: "baidu" | "5118") => {
    const candidates: KeywordCandidate[] = [];
    const issues: KeywordLookup["issues"] = [];
    const signal = AbortSignal.timeout(110_000);
    for (const seed of words) {
      let verificationRequired = false;
      const read = async (
        source: ResourceKeywordSource,
        request: () => Promise<string[]>,
      ) => {
        try {
          signal.throwIfAborted();
          for (const word of normalizeResourceKeywords(await request(), 30))
            candidates.push({ word, sources: [source], seeds: [seed] });
        } catch (error) {
          verificationRequired ||=
            error instanceof AppError && error.code === "BAIDU_VERIFICATION";
          const loginRequired =
            !signal.aborted &&
            error instanceof AppError &&
            error.code === "KEYWORD_5118_LOGIN_REQUIRED";
          issues.push({
            channel: name,
            seed,
            ...(loginRequired ? { code: "login_required" } : {}),
            message: signal.aborted
              ? "检索超时，已保留读到的词。"
              : safeMessage(error),
          });
        }
      };
      if (name === "5118") {
        const previousIssueCount = issues.length;
        await read("5118", () => {
          if (!ports.read5118PublicKeywords)
            throw new AppError(
              "KEYWORD_SOURCE",
              "当前客户端暂不能读取 5118 网页，可打开官网后粘贴关键词。",
            );
          return ports.read5118PublicKeywords(seed, signal);
        });
        if (issues.length > previousIssueCount) break;
      } else {
        await read("suggest", () => {
          if (!ports.baiduDiscovery)
            throw new AppError(
              "KEYWORD_SOURCE",
              "当前客户端暂不能读取百度搜索。",
            );
          return ports.baiduDiscovery.read("suggest", seed, signal);
        });
        if (!ports.baiduDiscovery || verificationRequired) break;
        if (ports.baiduDiscovery.readSearchWords) {
          try {
            signal.throwIfAborted();
            const result = await ports.baiduDiscovery.readSearchWords(
              seed,
              signal,
            );
            for (const source of ["people", "related"] as const)
              for (const word of normalizeResourceKeywords(result[source], 30))
                candidates.push({ word, sources: [source], seeds: [seed] });
            if (!result.related.length && !result.people.length)
              issues.push({
                channel: name,
                seed,
                message: "未识别到相关搜索或大家还在搜模块；下拉词仍可使用。",
              });
          } catch (error) {
            verificationRequired ||=
              error instanceof AppError && error.code === "BAIDU_VERIFICATION";
            issues.push({
              channel: name,
              seed,
              message: signal.aborted
                ? "检索超时，已保留读到的词。"
                : safeMessage(error),
            });
          }
        } else {
          await read("related", () =>
            ports.baiduDiscovery!.read("related", seed, signal),
          );
        }
      }
      if (signal.aborted || verificationRequired) break;
      if (seed !== words.at(-1))
        await delay(1000, undefined, { signal }).catch(() => {});
    }
    return { candidates, issues };
  };
  const marketing = async (): Promise<KeywordLookup> => {
    if (!readMarketingWords) return { candidates: [], issues: [] };
    try {
      const result = normalizeResourceKeywords(
        await readMarketingWords(words),
        resourceKeywordLimit,
      );
      return {
        candidates: result.map((word) => ({
          word,
          sources: ["baidu-marketing"],
          seeds: words,
        })),
        issues: [],
      };
    } catch (error) {
      const loginRequired =
        error instanceof AppError &&
        [
          "WEBSITE_LOGIN_REQUIRED",
          "BAIDU_LOGIN_REQUIRED",
          "WEBSITE_ACCOUNT_NOT_FOUND",
        ].includes(error.code);
      return {
        candidates: [],
        issues: [
          {
            channel: "baidu-marketing",
            ...(loginRequired ? { code: "login_required" } : {}),
            message: loginRequired
              ? "百度营销账号不可用，请在账号管理中检查登录后重试。"
              : safeMessage(error),
          },
        ],
      };
    }
  };
  const [baidu, longtail, marketingResult] = await Promise.all([
    channel("baidu"),
    channel("5118"),
    marketing(),
  ]);
  return {
    candidates: mergeKeywordCandidates(
      marketingResult.candidates,
      baidu.candidates,
      longtail.candidates,
    ),
    issues: [...marketingResult.issues, ...baidu.issues, ...longtail.issues],
  };
}
