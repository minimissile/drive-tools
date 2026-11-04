import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { PipixComment } from "../../shared/pipix";

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const exact = (value: unknown) =>
  typeof value === "string"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : "";
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const malformed = (): never => {
  throw new AppError(
    "PIPIX_COMMENTS_SHAPE",
    "评论响应结构无法识别，完整响应已归档，未当成空评论，也不会自动重复请求。",
  );
};

export function parsePipixComments(
  raw: unknown,
  sourceId: string,
  cursor: string,
) {
  const envelope = object(raw);
  if (String(envelope.code) !== "200")
    throw new AppError(
      "PIPIX_COMMENTS_REMOTE",
      "评论接口未返回成功结果，请检查服务商状态；原响应保留，不自动重试。",
    );
  if (envelope.params?.cell_id && exact(envelope.params.cell_id) !== sourceId)
    throw new AppError(
      "PIPIX_COMMENTS_ID",
      "评论响应的帖子ID与请求不一致，已停止。",
    );
  let payload = object(envelope.data),
    rows: unknown[] | undefined;
  for (let depth = 0; depth < 4; depth++) {
    if (
      payload.status_code !== undefined &&
      String(payload.status_code) !== "0"
    )
      throw new AppError(
        "PIPIX_COMMENTS_REMOTE",
        "皮皮虾上游评论读取未成功；响应已保存。",
      );
    rows = [
      payload.comments,
      payload.cell_comments,
      payload.comment_list,
      payload.data,
    ].find(Array.isArray);
    if (rows) break;
    if (!Object.keys(object(payload.data)).length) malformed();
    payload = object(payload.data);
  }
  if (!rows) return malformed();
  const items: PipixComment[] = [],
    originals = new Map<string, unknown>();
  let mediaOnly = 0,
    invalid = 0;
  for (const rawRow of rows) {
    const row = object(rawRow),
      c = object(row.comment_info ?? row.comment ?? row),
      body = text(c.text ?? c.content);
    if (!body) {
      if (c.image || c.video || c.images?.length || c.audio) mediaOnly++;
      else invalid++;
      continue;
    }
    const author =
      text(c.user?.name ?? c.user?.nickname ?? c.author?.name) || "未署名用户";
    const candidateId =
      exact(c.comment_id_str ?? c.id_str) || exact(c.comment_id ?? c.id);
    const commentId = /^\d{1,30}$/.test(candidateId)
      ? candidateId
      : `text-${createHash("sha256").update(`${sourceId}\n${author}\n${body}`).digest("hex")}`;
    if (items.some((item) => item.id === commentId)) continue;
    const label = text(c.tag_info?.content ?? c.tag_info?.name);
    items.push({
      id: commentId,
      text: body,
      author,
      likes:
        typeof c.like_count === "number" &&
        Number.isSafeInteger(c.like_count) &&
        c.like_count >= 0
          ? c.like_count
          : null,
      label,
    });
    originals.set(commentId, rawRow);
  }
  if (rows.length && !items.length && invalid) return malformed();
  const next = exact(payload.offset ?? payload.next_offset),
    more = payload.has_more;
  const hasMore = more === true || more === 1 || more === "1";
  const nextCursor =
    hasMore &&
    /^[A-Za-z0-9_=.:-]{1,300}$/.test(next) &&
    next !== cursor &&
    next !== "0"
      ? next
      : null;
  const warnings = [
    ...(mediaOnly
      ? [`本页${mediaOnly}条纯媒体评论仅保留原始响应，没有转写为文字。`]
      : []),
    ...(invalid ? [`本页${invalid}项未识别为文字评论，原始内容保留。`] : []),
  ];
  if (hasMore && !nextCursor)
    warnings.push("服务端未提供可继续的有效评论游标，已停止翻页。");
  if (more === undefined)
    warnings.push("上游未明确返回更多评论标记，未推测下一页。");
  return {
    items,
    originals,
    nextCursor,
    hasMore: !!nextCursor,
    warnings,
    returned: rows.length,
  };
}
