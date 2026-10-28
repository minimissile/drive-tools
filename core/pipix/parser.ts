import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { PipixItem } from "../../shared/pipix";
import { pipixListText } from "./text";

type RecordValue = Record<string, any>;
const text = (v: unknown, max = 10000): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const list = (v: unknown): RecordValue[] =>
  Array.isArray(v) ? v.filter((v) => v && typeof v === "object") : [];
const exactId = (str: unknown, number: unknown) =>
  /^\d{8,30}$/.test(String(str ?? ""))
    ? String(str)
    : Number.isSafeInteger(number)
      ? String(number)
      : "";
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const imageUrl = (image: RecordValue) =>
  list(image.download_list)
    .concat(list(image.url_list))
    .map((v) => text(v.url, 4000))
    .find(Boolean) ?? "";

export function parsePipixPage(html: string, expectedId?: string): PipixItem {
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);
  let data: RecordValue | undefined;
  for (const [, attrs, value] of scripts) {
    if (!/\bid\s*=\s*(["'])RENDER_DATA\1/i.test(attrs)) continue;
    try {
      const raw = value.trim();
      data = JSON.parse(raw.startsWith("{") ? raw : decodeURIComponent(raw));
    } catch {
      throw new AppError(
        "PIPIX_PARSE",
        "分享页数据无法解析，请重新复制官方分享链接。",
      );
    }
    break;
  }
  return parsePipixData(data, expectedId);
}

export function parsePipixData(
  data: RecordValue | undefined,
  expectedId?: string,
  fromList = false,
): PipixItem {
  const item = data?.ppxItemDetail?.item;
  const id = item && exactId(item.item_id_str, item.item_id);
  if (!id)
    throw new AppError(
      "PIPIX_PAGE",
      "分享页未返回帖子数据，可能已删除、需要验证或页面结构已变化。",
    );
  if (expectedId && id !== expectedId)
    throw new AppError(
      "PIPIX_ID",
      "分享页返回的帖子与链接不一致，已停止采集。",
    );
  const rawImages = list(item.note?.multi_image);
  const images = rawImages.slice(0, 9).map((v, i) => ({
    id: `image-${i + 1}`,
    url: imageUrl(v),
    animated: v.is_gif === true,
  }));
  const cells = list(data?.ppxCellComment?.cell_comments)
    .map((v) => v.comment_info)
    .filter(Boolean);
  const comments: PipixItem["comments"] = [];
  for (const c of [
    ...cells,
    ...list(item.comments),
    ...list(item.vital_comments),
  ]) {
    const body = text(c.text);
    if (!body) continue;
    const author = text(c.user?.name, 100) || "未署名用户";
    const commentId =
      exactId(c.comment_id_str, c.comment_id) ||
      `text-${createHash("sha256").update(`${author}\n${body}`).digest("hex")}`;
    if (comments.some((v) => v.id === commentId)) continue;
    comments.push({
      id: commentId,
      text: body,
      author,
      likes: count(c.like_count),
      label: text(c.tag_info?.content, 100),
    });
    if (comments.length >= 50) break;
  }
  const video = !!item.video || item.item_type === 2;
  const warnings = [
    fromList
      ? "图文与评论复用本地已存列表数据；不是完整评论列表，神评以来源明确标注为准。"
      : "仅包含分享页返回的评论，不是完整评论列表；未标注神评的评论按页面评论展示。",
  ];
  if (video)
    warnings.push("视频不下载，仅采集文案和评论；视频封面不作为配图。");
  if (rawImages.length > 9)
    warnings.push(`原帖 ${rawImages.length} 张图片，本轮仅采集前 9 张。`);
  if (images.some((v) => v.animated))
    warnings.push("动态图片将保存为静态配图。");
  return {
    id,
    url: `https://h5.pipix.com/ppx/item/${id}`,
    text: fromList
      ? pipixListText(item.note?.text || item.content)
      : text(item.note?.text || item.content, 30000),
    author:
      (fromList
        ? pipixListText(item.author?.name)
        : text(item.author?.name, 100)) || "未署名作者",
    kind: video ? "video" : images.length ? "images" : "text",
    images: video ? [] : images,
    comments,
    commentCount: count(item.stats?.comment_count),
    warnings,
    collectedAt: new Date().toISOString(),
  };
}
