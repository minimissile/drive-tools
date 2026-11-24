import {
  parseJianshuSourceReference,
  type JianshuSourceCollection,
} from "../../shared/jianshu-sources";
import {
  collectionLinkKey,
  collectionShare,
} from "../../shared/resource-collection";
import { AppError } from "../errors";
import type { readTiebaThreadSource } from "../tieba/analysis";
import {
  tiebaThreadIdFromUrl,
  tiebaThreadUrl,
} from "../tieba/participation-page";
import {
  jianshuSourceWritingText,
  jianshuTextUrls,
  normalizeJianshuBody,
} from "./content";
import { sourceMaterialFromText } from "./sources-parser";

function shareClues(body: string, hrefs: string[]) {
  const shares = new Map<string, { url: string; code: string }>();
  for (const value of [...hrefs, ...(body.match(jianshuTextUrls) ?? [])]) {
    const url = URL.parse(value);
    if (!url || url.username || url.password || url.port) continue;
    const target =
      url.origin === "https://tieba.baidu.com" &&
      url.pathname === "/mo/q/checkurl"
        ? url.searchParams.get("url")
        : url.href;
    const share = target && collectionShare(target);
    if (!share || share.link.length > 4000) continue;
    const key = collectionLinkKey(share.link);
    const previous = shares.get(key);
    if (!previous || (!previous.code && share.code))
      shares.set(key, { url: share.link, code: share.code.slice(0, 100) });
  }
  return [...shares.values()].slice(0, 30);
}

export async function collectTiebaSource(
  input: string,
  readThread: typeof readTiebaThreadSource,
  now: () => string,
): Promise<JianshuSourceCollection> {
  const id = /^https:\/\//i.test(input) ? tiebaThreadIdFromUrl(input) : null;
  if (!id || BigInt(id) > 9_223_372_036_854_775_807n)
    throw new AppError(
      "JIANSHU_TIEBA_URL",
      "请粘贴百度贴吧主题帖的链接，例如 https://tieba.baidu.com/p/9063569462。",
    );
  const url = tiebaThreadUrl(id);
  const thread = await readThread(id).catch(() => {
    throw new AppError(
      "JIANSHU_TIEBA_READ",
      "暂时无法读取这篇贴吧帖子。请查看原帖或稍后重试。",
    );
  });
  const floor = thread.firstFloor;
  if (thread.id !== id || thread.url !== url || !floor)
    throw new AppError(
      "JIANSHU_TIEBA_BODY",
      "未读到楼主首楼，请打开原帖核对后重试。",
    );

  const body = normalizeJianshuBody(floor.text);
  const imageUrls = new Set(
    floor.images.flatMap((value) => {
      const reference = parseJianshuSourceReference(value);
      return reference && reference.length <= 4000 ? [reference] : [];
    }),
  );
  const images = [...imageUrls].slice(0, 12).map((url) => ({ url, alt: "" }));
  const externalShares = shareClues(body, floor.hrefs);
  if (!body && !images.length && !externalShares.length)
    throw new AppError(
      "JIANSHU_TIEBA_BODY",
      "未读到楼主首楼的内容，请打开原帖核对后重试。",
    );

  const forum = thread.forum.trim();
  const sourceName = forum
    ? `百度贴吧 · ${forum}${forum.endsWith("吧") ? "" : "吧"}`
    : "百度贴吧";
  const collectedAt = now();
  const warnings = [
    ...(floor.truncated
      ? ["楼主首楼过长，素材仅保留前段，请到原帖核对完整内容。"]
      : []),
    ...(imageUrls.size > images.length ? ["首楼仅保留前 12 个图片引用。"] : []),
  ];
  const item = sourceMaterialFromText({
    provider: "tieba",
    title: thread.title,
    body,
    url,
    sourceName,
    author: thread.author,
    publishedAt: thread.publishedAt,
    collectedAt,
    images,
    externalShares,
    warnings,
  });
  item.summary = jianshuSourceWritingText(item, item.body)
    .replace(/\s+/g, " ")
    .slice(0, 400);
  return {
    items: [item],
    warnings: [],
    sourceName,
    url,
    collectedAt,
    truncated: false,
  };
}
