import { AppError } from "../errors";
import { decodeHtml, normalizedName, plainHtml } from "./parsers";
import type { SourceFetch } from "./client";
import type { miningCategories } from "../../shared/zhidao";

type Category = (typeof miningCategories)[number];
export interface MiningSource {
  name: string;
  url: string;
  pattern?: RegExp;
  json?: boolean;
  fresh?: boolean;
}
const douban = (type: string, tag: string, fresh = false): MiningSource => ({
  name: `豆瓣${tag}${fresh ? "最新" : "热门"}`,
  url: `https://movie.douban.com/j/search_subjects?${new URLSearchParams({ type, tag, sort: fresh ? "time" : "recommend", page_limit: "50", page_start: "0" })}`,
  json: true,
  fresh,
});
export const miningSources: Record<Category, MiningSource[]> = {
  小说: [
    {
      name: "七猫最新上架",
      url: "https://www.qimao.com/paihang/boy/new/date/",
      pattern: /\/shuku\/\d+/,
      fresh: true,
    },
    {
      name: "纵横人气榜",
      url: "https://www.zongheng.com/rank",
      pattern: /\/detail\/\d+/,
    },
    {
      name: "17K榜单",
      url: "https://www.17k.com/top/",
      pattern: /\/book\/\d+\.html/,
    },
  ],
  电影: [
    douban("movie", "热门"),
    douban("movie", "华语", true),
    {
      name: "猫眼年度票房",
      url: `https://piaofang.maoyan.com/rankings/year?year=${new Date().getFullYear()}`,
      pattern: /\/movie\/\d+/,
    },
  ],
  电视剧: [
    douban("tv", "热门"),
    douban("tv", "国产剧"),
    douban("tv", "热门", true),
  ],
  综艺: [douban("tv", "综艺"), douban("tv", "综艺", true)],
  动漫: [
    douban("tv", "日本动画"),
    douban("movie", "动画"),
    douban("tv", "日本动画", true),
  ],
  短剧: [
    {
      name: "红果热播短剧",
      url: "https://hongguoduanju.com/rank/hot-drama?page=1",
      pattern: /\/(?:drama|video|detail)\//,
    },
    {
      name: "红果真人短剧",
      url: "https://hongguoduanju.com/rank/hot-real-drama?page=1",
      pattern: /\/(?:drama|video|detail)\//,
    },
    douban("movie", "短剧", true),
  ],
  游戏: [
    {
      name: "TapTap热门榜",
      url: "https://www.taptap.cn/top/download",
      pattern: /\/app\/\d+/,
    },
    {
      name: "TapTap新品榜",
      url: "https://www.taptap.cn/top/new",
      pattern: /\/app\/\d+/,
      fresh: true,
    },
    {
      name: "3DM单机库",
      url: "https://www.3dmgame.com/games/",
      pattern: /\/games\/[\w-]+\//,
    },
    {
      name: "游侠热门榜",
      url: "https://www.ali213.net/paihb.html",
      pattern: /\/zt\/[\w-]+\//,
    },
  ],
  软件: [
    {
      name: "华军下载排行",
      url: "https://www.onlinedown.net/hits/",
      pattern: /\/(?:soft|softs)\/\d+/,
    },
    {
      name: "华军最新更新",
      url: "https://www.onlinedown.net/new/",
      pattern: /\/(?:soft|softs)\/\d+/,
      fresh: true,
    },
    {
      name: "非凡最新更新",
      url: "https://www.crsky.com/new/",
      pattern: /\/soft\/\d+/,
      fresh: true,
    },
    {
      name: "423Down近期软件",
      url: "https://www.423down.com/",
      pattern: /\/\d+\.html/,
    },
  ],
};
export function parseMining(body: string, source: MiningSource) {
  const names: string[] = [];
  if (source.json) {
    let value: any;
    try {
      value = JSON.parse(body);
    } catch {
      throw new AppError(
        "MINING_STRUCTURE",
        "榜单未返回有效 JSON，请稍后重试。",
      );
    }
    if (!Array.isArray(value.subjects))
      throw new AppError(
        "MINING_STRUCTURE",
        "榜单结构已变化，请切换来源或稍后重试。",
      );
    names.push(...value.subjects.map((v: any) => String(v.title ?? "")));
  } else {
    if (source.url.includes("taptap.cn")) {
      for (const match of body.matchAll(
        /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      )) {
        try {
          const raw = JSON.parse(match[1]);
          const blocks = Array.isArray(raw) ? raw : [raw];
          for (const block of blocks.flatMap((v) =>
            Array.isArray(v?.["@graph"]) ? v["@graph"] : [v],
          ))
            if (
              block?.["@type"] === "ItemList" &&
              Array.isArray(block.itemListElement)
            )
              for (const item of block.itemListElement)
                if (typeof (item.name ?? item.item?.name) === "string")
                  names.push(item.name ?? item.item.name);
        } catch {
          /* HTML anchors below remain an independent fallback. */
        }
      }
    }
    if (source.url.includes("hongguoduanju.com"))
      for (const match of body.matchAll(
        /(?:title|alt)=["']([^"']{1,80})["']/g,
      )) {
        const name = match[1].replace(/封面$/, "").trim();
        if (
          /[\u4e00-\u9fff]/.test(name) &&
          !/logo|二维码|红果短剧app/i.test(name)
        )
          names.push(name);
      }
    if (source.url.includes("piaofang.maoyan.com"))
      for (const match of body.matchAll(
        /<p\s+class=["']first-line["'][^>]*>([\s\S]*?)<\/p>/gi,
      ))
        names.push(plainHtml(match[1]));
    if (source.url.includes("qimao.com"))
      for (const match of body.matchAll(
        /class=["']s-book-title["'][^>]*>([\s\S]*?)<\/a>/gi,
      ))
        names.push(plainHtml(match[1]));
    for (const m of body.matchAll(
      /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi,
    )) {
      if (source.pattern && !source.pattern.test(decodeHtml(m[2]))) continue;
      const title = (m[1] + m[3]).match(/(?:title|alt)=["']([^"']+)["']/i)?.[1];
      names.push(plainHtml(title ?? m[4]));
    }
  }
  const seen = new Set<string>();
  return names
    .map((s) =>
      decodeHtml(s)
        .replace(/^\d+[.、\s]+/, "")
        .replace(/\s+[vV]\d[\d.]*.*$/, "")
        .trim(),
    )
    .filter((s) => {
      const key = normalizedName(s);
      if (
        s.length < 2 ||
        s.length > 40 ||
        /[。！？]|下载站|排行榜|点击查看|立即下载|查看更多/.test(s) ||
        !key ||
        seen.has(key)
      )
        return false;
      seen.add(key);
      return true;
    });
}
export interface MiningEvidence {
  name: string;
  sourceName: string;
  sourceUrl: string;
  evidence: string;
}
export async function collectNames(
  category: Category,
  count: number,
  fetcher: SourceFetch,
  signal: AbortSignal,
  onSource: (name: string) => void,
  onItem: (item: MiningEvidence) => void,
  known: Set<string>,
) {
  let added = 0,
    success = 0;
  const errors: string[] = [];
  const sources = miningSources[category];
  const quota = Math.max(1, Math.ceil(count / sources.length));
  const remainder: MiningEvidence[] = [];
  for (const source of sources) {
    signal.throwIfAborted();
    onSource(source.name);
    try {
      const body = await fetcher(source.url, signal);
      signal.throwIfAborted();
      const names = parseMining(body, source);
      if (!names.length)
        throw new AppError(
          "SOURCE_EMPTY",
          "没有解析到名称，来源可能限流或结构变化",
        );
      success++;
      let taken = 0;
      for (const name of names) {
        const key = normalizedName(name);
        if (known.has(key)) continue;
        const item = {
          name,
          sourceName: source.name,
          sourceUrl: source.url,
          evidence: `${source.name} · ${new Date().toISOString().slice(0, 10)}采集${source.fresh ? " · 最新来源" : ""}`,
        };
        if (taken < quota && added < count) {
          known.add(key);
          onItem(item);
          taken++;
          added++;
        } else remainder.push(item);
      }
    } catch (error) {
      signal.throwIfAborted();
      errors.push(
        `${source.name}：${error instanceof Error ? error.message : "读取失败"}`,
      );
    }
  }
  for (const item of remainder) {
    if (added >= count) break;
    const key = normalizedName(item.name);
    if (!known.has(key)) {
      known.add(key);
      onItem(item);
      added++;
    }
  }
  if (!success)
    throw new AppError("ALL_SOURCES_FAILED", errors.join("；").slice(0, 1500));
  return { added, errors };
}
export async function publicEvidence(
  query: string,
  fetcher: SourceFetch,
  signal: AbortSignal,
) {
  const sources = [
    `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    `https://www.so.com/s?q=${encodeURIComponent(query)}`,
  ];
  const results: { title: string; url: string; snippet: string }[] = [];
  for (const url of sources) {
    signal.throwIfAborted();
    try {
      const body = await fetcher(url, signal);
      signal.throwIfAborted();
      for (const m of body.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)) {
        const href = m[1].match(/href=["']([^"']+)["']/i)?.[1];
        const title = plainHtml(m[1]);
        if (!href || !title) continue;
        let target: URL;
        try {
          target = new URL(decodeHtml(href), url);
        } catch {
          continue;
        }
        if (target.protocol !== "https:") continue;
        results.push({
          title,
          url: target.href,
          snippet: plainHtml(
            body.slice(m.index! + m[0].length, m.index! + m[0].length + 1200),
          ).slice(0, 400),
        });
        if (results.length >= 6) return results;
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  return results;
}
