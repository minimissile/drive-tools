import { AppError } from "../errors";
import { readLimited } from "../http";
import { pipixListText } from "./text";
import {
  pipixDiscoverInput,
  type PipixCandidate,
  type PipixDiscoveryPage,
} from "../../shared/pipix";

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as ObjectValue) : {};
const text = (v: unknown, limit?: number) => pipixListText(v).slice(0, limit);
const exact = (v: unknown) =>
  typeof v === "string"
    ? v
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : "";
function shapeError(): never {
  throw new AppError(
    "PIPIX_LIST_SHAPE",
    "列表数据结构无法识别，未将其当作空列表。请核对数据服务响应后重试；本次请求可能已计费。",
  );
}

export function pipixDiscoveryEntries(raw: unknown) {
  const envelope = object(raw);
  let payload = object(envelope.data),
    rows: unknown[] | undefined;
  for (let level = 0; level < 3; level++) {
    if (
      payload.status_code !== undefined &&
      payload.status_code !== 0 &&
      payload.status_code !== "0"
    )
      throw new AppError(
        "PIPIX_LIST_REMOTE",
        "皮皮虾上游未返回成功结果，请稍后手动重试。",
      );
    rows = [payload.cell_list, payload.items, payload.data].find(
      Array.isArray,
    ) as unknown[] | undefined;
    if (rows) break;
    if (!Object.keys(object(payload.data)).length) shapeError();
    payload = object(payload.data);
  }
  if (!rows) shapeError();
  return {
    payload,
    items: rows.map((row) => {
      const cell = object(row);
      return Object.keys(object(cell.item)).length ? object(cell.item) : cell;
    }),
  };
}
export const pipixDiscoveryId = (item: ObjectValue) =>
  exact(item.item_id_str) || exact(item.item_id);

/** Only extracts post identities. Detail/media collection remains in the public-page client. */
export function parsePipixDiscovery(
  raw: unknown,
  input: ReturnType<typeof pipixDiscoverInput.parse>,
): PipixDiscoveryPage {
  const envelope = object(raw);
  if (envelope.code !== 200 && envelope.code !== "200")
    throw new AppError(
      "PIPIX_LIST_REMOTE",
      "数据服务未成功返回列表，请检查 Key、余额或服务状态。本次不自动重试。",
    );
  const { payload, items: rows } = pipixDiscoveryEntries(raw);
  const items: PipixCandidate[] = [];
  let invalid = 0;
  for (const row of rows) {
    const item = row,
      id = pipixDiscoveryId(item);
    if (!/^\d{8,30}$/.test(id)) {
      invalid++;
      continue;
    }
    if (items.some((v) => v.id === id)) continue;
    const note = object(item.note);
    const images =
      Array.isArray(note.multi_image) && note.multi_image.length > 0;
    const video = !!item.video || item.item_type === 2;
    const body = text(note.text || item.content);
    items.push({
      id,
      url: `https://h5.pipix.com/ppx/item/${id}`,
      text: body,
      author: text(object(item.author).name, 100) || "未署名作者",
      kind: video ? "video" : images ? "images" : body ? "text" : "unknown",
    });
  }
  if (rows.length && !items.length) shapeError();
  const warnings = invalid
    ? [`本页 ${invalid} 项缺少可核验的帖子 ID，已跳过。`]
    : [];
  const cursor = exact(
    input.mode === "search" ? payload.offset : payload.loadmore_cursor,
  );
  const hasMore = payload.has_more;
  const nextCursor =
    /^[A-Za-z0-9_=.:-]{1,300}$/.test(cursor) &&
    cursor !== input.cursor &&
    cursor !== "0" &&
    rows.length &&
    hasMore !== false &&
    hasMore !== 0 &&
    hasMore !== "0"
      ? cursor
      : null;
  if (
    rows.length &&
    hasMore !== false &&
    hasMore !== 0 &&
    hasMore !== "0" &&
    !nextCursor
  )
    warnings.push("接口没有提供可继续的分页游标，已停止翻页。");
  return { items, nextCursor, warnings };
}

export class TikHubPipixDiscovery {
  constructor(private request: typeof fetch = fetch) {}
  async discover(
    raw: unknown,
    key: string,
    signal: AbortSignal,
    received?: (body: string, httpStatus: number) => void,
  ): Promise<PipixDiscoveryPage> {
    const input = pipixDiscoverInput.parse(raw);
    const endpoint = {
      search: "fetch_search",
      home: "fetch_home_feed",
      user: "fetch_user_post_list",
      topic: "fetch_hashtag_post_list",
    }[input.mode];
    const url = new URL(`https://api.tikhub.io/api/v1/pipixia/app/${endpoint}`);
    if (input.probe)
      url.searchParams.set(input.probe.parameter, String(input.probe.value));
    if (input.mode === "search") {
      url.searchParams.set("keyword", input.keyword);
      url.searchParams.set("search_type", "3");
      url.searchParams.set("offset", input.cursor);
    } else {
      url.searchParams.set("cursor", input.cursor);
      if (input.mode !== "home") {
        url.searchParams.set(
          input.mode === "user" ? "user_id" : "hashtag_id",
          input.targetId,
        );
        url.searchParams.set("feed_count", String(input.page));
      }
    }
    let response: Response;
    try {
      response = await this.request(url.href, {
        signal,
        redirect: "error",
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch {
      // Never forward a transport error that might contain the request header.
      throw new AppError(
        "PIPIX_LIST_NETWORK",
        "列表请求未完成，请检查网络后手动重试；服务端可能已处理并计费。",
      );
    }
    const body = await readLimited(response, 32 * 1024 * 1024);
    received?.(body, response.status);
    if (!response.ok) {
      const reason =
        response.status === 401 || response.status === 403
          ? "请检查 API Key 或访问权限"
          : response.status === 429
            ? "请求受限，请稍后手动重试"
            : "请检查余额或服务状态";
      throw new AppError(
        "PIPIX_LIST_HTTP",
        `列表读取失败（HTTP ${response.status}），${reason}。`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new AppError(
        "PIPIX_LIST_JSON",
        "数据服务返回了非 JSON 内容，请稍后手动重试。",
      );
    }
    return parsePipixDiscovery(value, input);
  }
}
