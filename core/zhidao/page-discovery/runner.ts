import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { AppError } from "../../errors";
import { readLimited } from "../../http";
import {
  pageDiscoveryInput,
  zhidaoAnswerPageUrl,
  type PageDiscoveryRun,
  type PageDiscoveryInput,
} from "../../../shared/zhidao-page-discovery";
import { discoverZhidaoCandidates, inspectZhidaoAnswers } from "./parser";

export type DiscoveryReader = (
  url: string,
  signal: AbortSignal,
) => Promise<{ body: string; url: string }>;
export function allowedDiscoveryUrl(raw: string) {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      (!!zhidaoAnswerPageUrl(raw) ||
        (u.hostname === "www.baidu.com" &&
          ["/s", "/link"].includes(u.pathname)))
    );
  } catch {
    return false;
  }
}
export const readDiscoveryHttp: DiscoveryReader = async (raw, signal) => {
  let url = raw;
  for (let index = 0; index < 6; index++) {
    if (!allowedDiscoveryUrl(url))
      throw new AppError(
        "DISCOVERY_URL",
        "搜索结果没有指向允许的百度知道页面，已跳过。",
      );
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location)
        throw new AppError("DISCOVERY_REDIRECT", "来源重定向缺少目标地址。");
      const target = new URL(location, url);
      await response.body?.cancel();
      if (["wappass.baidu.com", "passport.baidu.com"].includes(target.hostname))
        throw new AppError(
          "DISCOVERY_VERIFICATION",
          "来源要求安全验证，已暂停。可在桌面页查看读取页面并完成验证后继续。",
        );
      url = zhidaoAnswerPageUrl(target.href)?.url || target.href;
      continue;
    }
    if ([403, 429].includes(response.status))
      throw new AppError(
        "DISCOVERY_VERIFICATION",
        `来源限制访问（HTTP ${response.status}），已保留进度，请稍后手动继续。`,
      );
    if (!response.ok)
      throw new AppError(
        "DISCOVERY_HTTP",
        `页面读取失败（HTTP ${response.status}）。`,
      );
    return { url, body: await readLimited(response, 4_000_000) };
  }
  throw new AppError("DISCOVERY_REDIRECT", "来源跳转次数过多，已停止读取。");
};

export function createPageDiscovery(
  input: PageDiscoveryInput,
): PageDiscoveryRun {
  const v = pageDiscoveryInput.parse(input);
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    createdAt: at,
    updatedAt: at,
    status: "running",
    input: v,
    cursor: 0,
    checked: 0,
    searchPages: 0,
    noLinks: 0,
    failed: 0,
    items: [],
    logs: [],
    message: "准备发现网盘回答页…",
    jobs: [
      ...[...new Set(v.urls.map((url) => zhidaoAnswerPageUrl(url)!.url))].map(
        (url) => ({
          kind: "detail" as const,
          url,
          keyword: "指定页面",
          origin: "specified" as const,
        }),
      ),
      ...[...new Set(v.keywords)].flatMap((keyword) =>
        Array.from({ length: v.pages }, (_, page) => ({
          kind: "search" as const,
          keyword,
          origin: "search" as const,
          url: `https://www.baidu.com/s?${new URLSearchParams({ wd: `site:zhidao.baidu.com ${keyword} 网盘`, pn: String(page * 10) })}`,
        })),
      ),
    ],
  };
}
export function logDiscovery(
  run: PageDiscoveryRun,
  kind: PageDiscoveryRun["logs"][number]["kind"],
  message: string,
  url?: string,
) {
  run.logs.push({
    at: new Date().toISOString(),
    kind,
    message,
    ...(url ? { url } : {}),
  });
  if (run.logs.length > 300) run.logs.splice(0, run.logs.length - 300);
  run.message = message;
  run.updatedAt = new Date().toISOString();
}
/** Read-only discovery. Search snippets never count as matches; each answer is fetched and inspected. */
export async function runPageDiscovery(
  run: PageDiscoveryRun,
  read: DiscoveryReader,
  signal: AbortSignal,
  onChange: () => void,
) {
  run.status = "running";
  const seen = new Set(run.jobs.map((job) => job.url));
  while (
    run.cursor < run.jobs.length &&
    run.items.length < run.input.limit &&
    run.checked < 500
  ) {
    signal.throwIfAborted();
    const job = run.jobs[run.cursor];
    logDiscovery(
      run,
      "info",
      job.kind === "search"
        ? `检索「${job.keyword}」`
        : `检查回答正文 · ${job.keyword}`,
      job.url,
    );
    onChange();
    try {
      const page = await read(job.url, signal);
      signal.throwIfAborted();
      if (job.kind === "search") {
        const candidates = discoverZhidaoCandidates(page.body).filter(
          (url) => !seen.has(url),
        );
        const additions = candidates
          .slice(0, Math.max(0, 1000 - run.jobs.length))
          .map((url) => ({
            kind: "detail" as const,
            url,
            keyword: job.keyword,
            origin: "search" as const,
          }));
        additions.forEach((job) => seen.add(job.url));
        run.jobs.splice(run.cursor + 1, 0, ...additions);
        run.searchPages++;
        logDiscovery(
          run,
          "info",
          `本页发现${additions.length}个新候选，逐页检查回答正文。`,
          job.url,
        );
      } else {
        const target = zhidaoAnswerPageUrl(page.url);
        if (!target)
          throw new AppError(
            "DISCOVERY_URL",
            "搜索结果未跳转到百度知道问题页，已跳过。",
          );
        const answers = inspectZhidaoAnswers(page.body, target.url);
        run.checked++;
        let added = 0;
        for (const answer of answers) {
          if (run.items.length >= run.input.limit) break;
          if (run.items.some((v) => v.id === answer.id)) continue;
          run.items.push({
            ...answer,
            keyword: job.keyword,
            origin: job.origin,
            foundAt: new Date().toISOString(),
          });
          added++;
        }
        if (!answers.length) run.noLinks++;
        logDiscovery(
          run,
          added ? "success" : "info",
          added
            ? `确认${added}个回答正文包含网盘链接。`
            : answers.length
              ? "该回答页已记录，跳过重复结果。"
              : "该页公开回答正文中未检出网盘链接。",
          target.url,
        );
      }
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error ? error.message : "页面读取失败";
      if (
        job.kind === "search" ||
        !(error instanceof AppError) ||
        [
          "DISCOVERY_VERIFICATION",
          "DISCOVERY_EMPTY_RESPONSE",
          "DISCOVERY_SEARCH_STRUCTURE",
        ].includes(error.code)
      ) {
        run.status = "paused";
        logDiscovery(run, "warning", message, job.url);
        onChange();
        return;
      }
      run.failed++;
      logDiscovery(run, "warning", message, job.url);
    }
    run.cursor++;
    onChange();
    if (run.cursor < run.jobs.length && run.items.length < run.input.limit)
      await delay(run.input.intervalMs, undefined, { signal });
  }
  run.status = "completed";
  logDiscovery(
    run,
    "info",
    `本轮结束：确认${run.items.length}个回答页，检查${run.checked}个页面${run.failed ? `，${run.failed}页读取异常` : ""}${run.checked >= 500 ? "；已达到500页检查上限" : ""}。`,
  );
  onChange();
}
