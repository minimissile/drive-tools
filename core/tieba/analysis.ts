import { createHash } from "node:crypto";
import type {
  TiebaAnalysisFollowedPage,
  TiebaAnalysisForumPage,
  TiebaAnalysisPage,
  TiebaAnalysisThreadDetail,
} from "../../shared/tieba-analysis";
import { normalizeTiebaForumName } from "../../shared/tieba-forums";
import { AppError } from "../errors";
import { readLimited, readLimitedBytes } from "../http";
import { oldResourceEvidence } from "../tieba-resource-discovery/old-resource";
import {
  forumExposure,
  resourceEvidence,
} from "../tieba-resource-discovery/rules";
import { encodeTiebaFields, tiebaFields } from "./analysis-protobuf";
import { tiebaForumUrl } from "./autocare-page";
import { tiebaThreadIdFromUrl, tiebaThreadUrl } from "./participation-page";

const endpoints = {
  thread: "/c/f/pb/page?cmd=302001",
  user: "/c/u/feed/userpost?cmd=303002",
  profile: "/c/u/user/getUserByTiebaUid?cmd=309702",
  account: "/c/u/user/profile?cmd=303012",
  forum: "/c/f/frs/page?cmd=301001",
};
const maxId = 9_223_372_036_854_775_807n;
const empty = Buffer.alloc(0);
const latestVersion = Buffer.from("22.13.1.0");
const latestCommon = encodeTiebaFields([[2, latestVersion]]);
const legacyCommon = encodeTiebaFields([
  [1, 2n],
  [2, Buffer.from("12.64.1.1")],
]);
const objectId = (n: bigint | undefined) =>
  n !== undefined && n > 0n && n <= maxId ? n.toString() : null;
const count = (n: bigint | undefined) =>
  n !== undefined && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
const jsonCount = (value: unknown) => {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};
const publishTime = (value: bigint | undefined) =>
  value && value <= 0xffffffffn
    ? new Date(Number(value) * 1000).toISOString()
    : null;
const invalidResponse = () =>
  new AppError(
    "TIEBA_ANALYSIS_RESPONSE",
    "贴吧返回的数据无法识别，请稍后重试。",
  );

// Only the fields used by this screen, from aiotieba v4.8.4's public
// UserPost, FrsPage, PbPage, Profile and GetUserByTiebaUid protocol definitions.
async function request(
  source: keyof typeof endpoints,
  data: Buffer,
  send: typeof fetch,
) {
  const form = new FormData();
  form.set(
    "data",
    new Blob([Uint8Array.from(encodeTiebaFields([[1, data]]))]),
    "file",
  );
  let bytes: Buffer;
  try {
    const response = await send(
      "https://tiebac.baidu.com" + endpoints[source],
      {
        method: "POST",
        headers: { x_bd_data_type: "protobuf" },
        body: form,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AppError(
        "TIEBA_ANALYSIS_HTTP",
        `贴吧暂时无法查询（HTTP ${response.status}），请稍后重试。`,
      );
    }
    bytes = await readLimitedBytes(response, 8_000_000);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "TIEBA_ANALYSIS_NETWORK",
      "未能连接贴吧，请检查网络后重试。",
    );
  }
  try {
    const envelope = tiebaFields(bytes);
    const status = envelope.bytes(1);
    const result = envelope.bytes(2);
    if (status === undefined && result === undefined) throw invalidResponse();
    const code = tiebaFields(status ?? empty).integer(1) ?? 0n;
    if (code !== 0n) {
      throw new AppError(
        "TIEBA_ANALYSIS_UPSTREAM",
        source === "forum"
          ? `贴吧未提供该吧的公开帖子（${code}），请核对吧名或稍后重试。`
          : source === "thread"
            ? "贴吧未返回这篇公开主题帖，请检查链接或改用主页 ID。"
            : source === "profile"
              ? `贴吧暂时无法核对主页 ID（${code}），请稍后重试或粘贴主题帖链接。`
              : `贴吧未返回该用户的${source === "account" ? "资料" : "帖子列表"}（${code}），请检查输入或稍后重试。`,
      );
    }
    return tiebaFields(result ?? empty);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidResponse();
  }
}

function numericId(value: string) {
  return /^[1-9]\d{0,18}$/.test(value) ? objectId(BigInt(value)) : null;
}

function portraitId(value: string) {
  const portrait = value.split("?")[0];
  return /^tb\.1\.[\da-f]{8}\.[\w-]{16,32}$/i.test(portrait) ? portrait : null;
}

function homepagePortrait(target: string) {
  try {
    const url = new URL(target);
    if (
      url.origin !== "https://tieba.baidu.com" ||
      url.username ||
      url.password ||
      !/^\/home\/main\/?$/u.test(url.pathname) ||
      url.searchParams.getAll("id").length !== 1
    )
      return null;
    return portraitId(url.searchParams.get("id") ?? "");
  } catch {
    return null;
  }
}

async function readAccount(
  identity: { uid: string } | { portrait: string },
  send: typeof fetch,
) {
  const common = encodeTiebaFields([
    [1, 2n],
    [2, latestVersion],
  ]);
  const data = await request(
    "account",
    encodeTiebaFields([
      "uid" in identity
        ? [1, BigInt(identity.uid)]
        : [16, Buffer.from(identity.portrait)],
      [2, 1n],
      [9, common],
      [15, 1n],
    ]),
    send,
  );
  try {
    return tiebaFields(data.bytes(1) ?? empty);
  } catch {
    throw invalidResponse();
  }
}

async function resolveProfileId(profileId: string, send: typeof fetch) {
  const data = await request(
    "profile",
    encodeTiebaFields([
      [1, latestCommon],
      [2, Buffer.from(profileId)],
    ]),
    send,
  );
  const user = tiebaFields(data.bytes(1) ?? empty);
  const uid = objectId(user.integer(2));
  const returnedId = user.string(120);
  // Some older callers supply an internal UID directly. Only fall back when
  // the profile lookup succeeds and confirms there is no mapping.
  if (!uid && !returnedId)
    return { uid: profileId, profileId: null, author: "" };
  if (!uid || returnedId !== profileId) throw invalidResponse();
  return { uid, profileId, author: user.string(4) || user.string(3) };
}

async function resolveAuthor(target: string, send: typeof fetch) {
  const internal = target.match(/^UID\s*[:：]\s*(\d+)$/i);
  const internalUid = internal && numericId(internal[1]);
  if (internalUid) return { uid: internalUid, profileId: null, author: "" };
  const profileId = numericId(target);
  if (profileId) return resolveProfileId(profileId, send);
  const portrait = homepagePortrait(target);
  if (portrait) {
    const user = await readAccount({ portrait }, send);
    const uid = objectId(user.integer(2));
    if (!uid || portraitId(user.string(5)) !== portrait)
      throw new AppError(
        "TIEBA_ANALYSIS_AUTHOR",
        "未能确认主页对应的用户，请核对主页链接或改用主题帖链接。",
      );
    return {
      uid,
      profileId: numericId(user.string(120)),
      author: user.string(4) || user.string(3),
    };
  }
  const tid = target.startsWith("https://")
    ? tiebaThreadIdFromUrl(target)
    : null;
  if (!tid || !objectId(BigInt(tid)))
    throw new AppError(
      "TIEBA_ANALYSIS_TARGET",
      "请输入贴吧主页 ID，或粘贴百度贴吧个人主页、公开主题帖链接。",
    );
  const { thread } = await readThread(tid, send);
  const author = tiebaFields(thread.bytes(18) ?? empty);
  const uid = objectId(thread.integer(56)) ?? objectId(author.integer(2));
  if (!uid)
    throw new AppError(
      "TIEBA_ANALYSIS_AUTHOR",
      "未能从该主题帖确认作者，请改用主页 ID。",
    );
  return {
    uid,
    profileId: numericId(author.string(120)),
    author: author.string(4) || author.string(3),
  };
}

async function readThread(tid: string, send: typeof fetch, latestReplies = false) {
  const data = await request(
    "thread",
    encodeTiebaFields([
      [4, BigInt(tid)],
      [13, latestReplies ? 21n : 2n],
      [18, 1n],
      [25, legacyCommon],
      ...(latestReplies ? [[6, 1n], [8, 1n], [9, 5n]] as const : []),
    ]),
    send,
  );
  const thread = tiebaFields(data.bytes(8) ?? empty);
  if (objectId(thread.integer(1)) !== tid) throw invalidResponse();
  return { data, thread };
}

export async function readTiebaDiscoveryViews(
  tid: string,
  send: typeof fetch = fetch,
) {
  if (!numericId(tid)) throw invalidResponse();
  const { data } = await readThread(tid, send);
  return count(data.integer(37));
}

export async function readTiebaOldResource(tid: string, send: typeof fetch = fetch) {
  return (await readTiebaDiscoveryDetails(tid, send)).resource;
}

export async function readTiebaDiscoveryThread(tid: string, send: typeof fetch = fetch) {
  return (await readThreadOverview(tid, send)).summary;
}

export async function queryTiebaAnalysisThread(
  { target }: { target: string },
  send: typeof fetch = fetch,
): Promise<TiebaAnalysisThreadDetail> {
  const tid = numericId(target) ?? numericId(tiebaThreadIdFromUrl(target.replace(/^http:/i, "https:")) ?? "");
  if (!tid)
    throw new AppError("TIEBA_ANALYSIS_THREAD_TARGET", "请输入百度贴吧主题帖链接或数字帖子 ID。");
  const { summary, firstFloor } = await readThreadOverview(tid, send);
  const { uid, ...post } = summary;
  return {
    ...post,
    id: tid,
    url: tiebaThreadUrl(tid),
    authorId: uid,
    bodyText: firstFloor ? contentFragments(firstFloor, 5).text.trim() : "",
    observedAt: Date.now(),
  };
}

async function readThreadOverview(tid: string, send: typeof fetch) {
  if (!numericId(tid)) throw invalidResponse();
  const { data, thread } = await readThread(tid, send);
  const author = tiebaFields(thread.bytes(18) ?? empty);
  const forum = tiebaFields(data.bytes(2) ?? empty);
  const firstFloor = data.messages(6).find((post) => post.integer(3) === 1n);
  const summary = {
    views: count(data.integer(37)),
    title: thread.string(3) || "无标题主题帖",
    forum: forum.string(2) || thread.string(28),
    author: author.string(4) || author.string(3),
    uid: objectId(thread.integer(56)) ?? objectId(author.integer(2)),
    publishedAt: publishTime(thread.integer(45) ?? firstFloor?.integer(4)),
    replies: count(thread.integer(4)),
    likes: count(tiebaFields(thread.bytes(126) ?? empty).integer(1)),
    shares: count(thread.integer(135)),
  };
  return { summary, firstFloor };
}

export type TiebaSourcePart =
  | { kind: "text"; text: string; href?: string }
  | { kind: "image"; url: string };

/** Read the original post and its references for use as source material. */
export async function readTiebaThreadSource(
  tid: string,
  send: typeof fetch = fetch,
  includeOrderedParts = false,
) {
  const { summary, firstFloor } = await readThreadOverview(tid, send);
  return {
    id: tid,
    url: tiebaThreadUrl(tid),
    title: summary.title,
    forum: summary.forum,
    author: summary.author,
    publishedAt: summary.publishedAt,
    firstFloor: firstFloor
      ? sourcePostContent(firstFloor, includeOrderedParts)
      : null,
  };
}

function sourcePostContent(
  post: ReturnType<typeof tiebaFields>,
  includeOrderedParts: boolean,
) {
  const fragments = post.messages(5);
  const fragmentLimit = 200;
  const textLimit = 30_000;
  const textParts: string[] = [];
  const hrefs = new Set<string>();
  const images = new Set<string>();
  const parts: TiebaSourcePart[] | undefined = includeOrderedParts
    ? []
    : undefined;
  for (const fragment of fragments.slice(0, fragmentLimit)) {
    const type = fragment.integer(1) ?? 0n;
    if (type === 3n) {
      // PbContent origin_src, big_cdn_src, cdn_src, then src.
      let imageUrl = "";
      for (const field of [25, 9, 8, 4]) {
        const value = fragment.string(field);
        const url = URL.parse(value.startsWith("//") ? `https:${value}` : value);
        if (
          url &&
          (url.protocol === "https:" || url.protocol === "http:") &&
          !url.username && !url.password && !url.port
        ) {
          imageUrl = url.href;
          break;
        }
      }
      if (imageUrl) images.add(imageUrl);
      parts?.push({ kind: "image", url: imageUrl });
    } else if (type === 0n || type === 1n) {
      // Fragments can split a line around an inline link. Keep the text bytes' whitespace.
      const text = fragment.bytes(2)?.toString("utf8") ?? "";
      const href = type === 1n ? fragment.string(3) : "";
      textParts.push(text);
      if (href) hrefs.add(href);
      parts?.push(href ? { kind: "text", text, href } : { kind: "text", text });
    }
  }
  const text = textParts.join("").trim();
  return {
    text: text.slice(0, textLimit),
    hrefs: [...hrefs],
    images: [...images],
    truncated: fragments.length > fragmentLimit || text.length > textLimit,
    ...(parts ? { parts } : {}),
  };
}

export async function readTiebaDiscoveryDetails(tid: string, send: typeof fetch = fetch) {
  if (!numericId(tid)) throw invalidResponse();
  const { data, thread } = await readThread(tid, send, true);
  const posts = data.messages(6);
  const firstFloor = (items: typeof posts) => items.find((post) => post.integer(3) === 1n);
  const body = firstFloor(posts) ?? firstFloor((await readThread(tid, send)).data.messages(6));
  if (!body) throw invalidResponse();
  const replies = posts.flatMap((post) => [
    ...(post.integer(3) === 1n ? [] : [{
      time: Number(post.integer(4) ?? 0n),
      ...contentFragments(post, 5),
    }]),
    ...tiebaFields(post.bytes(15) ?? empty).messages(2).slice(0, 5).map((reply) => ({
      time: Number(reply.integer(3) ?? 0n),
      ...contentFragments(reply, 2),
    })),
  ]).sort((a, b) => b.time - a.time).slice(0, 20);
  const resource = oldResourceEvidence([
    { source: "标题", text: thread.string(3) },
    { source: "正文", ...contentFragments(body, 5) },
    ...replies.map((reply) => ({ source: "回复" as const, ...reply })),
  ]);
  return { views: count(data.integer(37)), resource };
}

function contentFragments(post: ReturnType<typeof tiebaFields>, field: number) {
  const fragments = post.messages(field).slice(0, 50);
  return {
    text: fragments.map((part) => part.string(2)).join("\n").slice(0, 8000),
    hrefs: fragments.map((part) => part.string(3)).filter(Boolean),
  };
}

function discoveryEvidence(
  post: ReturnType<typeof tiebaFields>,
  field: number,
  title: string,
) {
  const { text, hrefs } = contentFragments(post, field);
  return resourceEvidence(title, text, hrefs);
}

export async function queryTiebaAnalysis(
  { target, page }: { target: string; page: number },
  send: typeof fetch = fetch,
  discoverResources = false,
): Promise<TiebaAnalysisPage> {
  const identity = await resolveAuthor(target, send);
  const { uid } = identity;
  const data = await request(
    "user",
    encodeTiebaFields([
      [1, BigInt(uid)],
      [4, 1n],
      [5, 1n],
      [26, BigInt(page)],
      [27, latestCommon],
      [33, 1n],
    ]),
    send,
  );
  try {
    const posts = data.messages(1);
    let author = "";
    const threads = posts.map((post) => {
      const id = objectId(post.integer(2));
      if (!id || objectId(post.integer(18)) !== uid) throw invalidResponse();
      author ||= post.string(35) || post.string(10);
      const agree = tiebaFields(post.bytes(40) ?? empty);
      const title = post.string(7) || "无标题主题帖";
      return {
        id,
        title,
        forumId: objectId(post.integer(1)),
        forum: post.string(6),
        url: tiebaThreadUrl(id),
        publishedAt: publishTime(post.integer(5)),
        views: count(post.integer(33)),
        replies: count(post.integer(17)),
        likes: count(agree.integer(1)),
        shares: count(post.integer(39)),
        ...(discoverResources
          ? { authorId: uid, resource: discoveryEvidence(post, 49, title) }
          : {}),
      };
    });
    return { ...identity, author: author || identity.author, threads };
  } catch {
    throw invalidResponse();
  }
}

export async function queryTiebaAnalysisForumPosts(
  { name, page, list = "published", pageSize = 20, allowEmptyPage = false }: {
    name: string;
    page: number;
    list?: "published" | "featured" | "replied";
    pageSize?: number;
    allowEmptyPage?: boolean;
  },
  send: typeof fetch = fetch,
  discoverResources: boolean | "old" = false,
): Promise<TiebaAnalysisForumPage> {
  const data = await request(
    "forum",
    encodeTiebaFields([
      [1, Buffer.from(name)],
      [2, BigInt(pageSize)],
      [3, BigInt(pageSize + 5)],
      ...(list === "featured" ? [[4, 1n] as const] : []),
      ...(page > 1 ? [[15, BigInt(page)] as const] : []),
      [39, legacyCommon],
      [47, list === "published" ? 1n : list === "replied" ? 6n : 0n],
    ]),
    send,
  );
  try {
    const forum = tiebaFields(data.bytes(2) ?? empty);
    const id = objectId(forum.integer(1));
    const canonical = forum.string(2);
    if (
      !id ||
      normalizeTiebaForumName(canonical).toLowerCase() !== name.toLowerCase()
    )
      throw new AppError(
        "TIEBA_ANALYSIS_FORUM",
        "贴吧返回的吧名与输入不一致，请核对吧名。",
      );
    const pagination = tiebaFields(data.bytes(4) ?? empty);
    const current = pagination.integer(3) ?? 0n;
    const hasMore = pagination.integer(6) ?? 0n;
    const totalPages = count(pagination.integer(5));
    if (
      (current !== BigInt(page) && !(page === 1 && current === 0n)) ||
      hasMore > 1n
    )
      throw invalidResponse();

    const authorName = (user: ReturnType<typeof tiebaFields>) =>
      user.string(4) || user.string(3);
    const authors = new Map(
      data.messages(17).map((user) => [objectId(user.integer(2)), user]),
    );
    const threads = new Map<
      string,
      TiebaAnalysisForumPage["threads"][number]
    >();
    for (const post of data.messages(7)) {
      const tid = objectId(post.integer(1));
      if (!tid || threads.has(tid)) continue;
      const author = tiebaFields(post.bytes(18) ?? empty);
      const embeddedUid = objectId(author.integer(2));
      const authorUid = objectId(post.integer(56)) ?? embeddedUid;
      const listedAuthor = authorUid ? authors.get(authorUid) : undefined;
      const embeddedMatches = !embeddedUid || embeddedUid === authorUid;
      const agree = tiebaFields(post.bytes(126) ?? empty);
      const title = post.string(3) || "无标题主题帖";
      const fragments = discoverResources ? contentFragments(post, 142) : undefined;
      threads.set(tid, {
        id: tid,
        forumId: id,
        forum: canonical,
        title,
        author:
          (embeddedMatches ? authorName(author) : "") ||
          (listedAuthor ? authorName(listedAuthor) : ""),
        authorId: authorUid,
        forumLevel:
          count(
            (embeddedMatches ? author.integer(23) : undefined) ??
              listedAuthor?.integer(23),
          ) || null,
        url: tiebaThreadUrl(tid),
        publishedAt: publishTime(post.integer(45)),
        repliedAt: publishTime(post.integer(7)),
        views: count(post.integer(5)),
        replies: count(post.integer(4)),
        likes: count(agree.integer(1)),
        shares: count(post.integer(135)),
        ...(fragments ? {
            oldResource: oldResourceEvidence([
              { source: "标题", text: title },
              { source: "正文", ...fragments },
            ]),
            resource: resourceEvidence(title, fragments.text, fragments.hrefs),
          } : {}),
      });
    }
    if (!allowEmptyPage && !threads.size && hasMore === 1n && (discoverResources !== "old" || data.messages(7).length))
      throw invalidResponse();
    const list = [...threads.values()];
    const followers = count(forum.integer(9));
    const posts = count(forum.integer(11));
    return {
      id,
      name: canonical,
      url: tiebaForumUrl(canonical),
      page,
      hasMore: hasMore === 1n,
      ...(totalPages !== null && totalPages >= page + Number(hasMore === 1n) &&
        totalPages <= 2_147_483_647 && (hasMore === 1n || totalPages === page)
        ? { totalPages } : {}),
      ...(followers !== null ? { followers } : {}),
      ...(posts !== null ? { posts } : {}),
      threads: list,
      exposure: forumExposure(list, Date.now()),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidResponse();
  }
}

export async function queryTiebaAnalysisFollowedForums(
  { uid, page }: { uid: string; page: number },
  send: typeof fetch = fetch,
  withStats = false,
): Promise<TiebaAnalysisFollowedPage> {
  const user = await readAccount({ uid }, send);
  const result = await readFollowedPage(uid, page, user, send);
  if (result.visibility === "restricted" || !withStats) return result;
  const queue = result.forums.entries();
  const forums = [...result.forums];
  const deadline = AbortSignal.timeout(9000);
  const read: typeof fetch = (input, options) => send(input, {
    ...options,
    signal: options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });
  await Promise.all(Array.from({ length: Math.min(4, result.forums.length) }, async () => {
    for (const [index, forum] of queue) {
      if (deadline.aborted) break;
      if (forum.followers != null && forum.posts != null) continue;
      const sample = await queryTiebaAnalysisForumPosts({ name: forum.name, page: 1 }, read).catch(() => null);
      if (sample?.id === forum.id)
        forums[index] = {
          ...forum,
          followers: forum.followers ?? sample.followers,
          posts: forum.posts ?? sample.posts,
        };
    }
  }));
  return { ...result, forums };
}

async function readFollowedPage(
  uid: string,
  page: number,
  user: ReturnType<typeof tiebaFields>,
  send: typeof fetch,
): Promise<TiebaAnalysisFollowedPage> {
  try {
    if (objectId(user.integer(2)) !== uid) throw invalidResponse();
    const privacy = tiebaFields(user.bytes(45) ?? empty).integer(2);
    if (privacy === 2n || privacy === 3n) return { visibility: "restricted" };
    const portrait = portraitId(user.string(5));
    if (!portrait)
      throw new AppError(
        "TIEBA_ANALYSIS_PORTRAIT",
        "贴吧暂未返回可用的主页资料，无法读取关注列表。",
      );

    // Standard anonymous PC list request as used by aiotieba's get_follow_forums_pc.
    const url = new URL("https://tieba.baidu.com/c/f/pc/myForumList");
    url.search = new URLSearchParams({
      portrait,
      pn: String(page),
      rn: "20",
      subapp_type: "pc",
      _client_type: "20",
    }).toString();
    url.searchParams.sort();
    const signature = Array.from(
      url.searchParams,
      ([key, value]) => `${key}=${value}`,
    ).join("");
    url.searchParams.set(
      "sign",
      createHash("md5")
        .update(signature + "36770b1f34c9bbf2e7d1a99d2b82fa9e")
        .digest("hex"),
    );
    const response = await send(url, {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AppError(
        "TIEBA_ANALYSIS_FOLLOWED_HTTP",
        `贴吧暂时无法读取关注列表（HTTP ${response.status}），请稍后重试。`,
      );
    }
    const body = JSON.parse(await readLimited(response, 1_000_000));
    if (body?.error_code !== 0 && body?.error_code !== "0")
      throw new AppError(
        "TIEBA_ANALYSIS_FOLLOWED",
        "贴吧暂未提供该用户的关注列表。",
      );
    const data = body.data;
    if (
      !Array.isArray(data?.like) ||
      ![0, 1, "0", "1", false, true].includes(data.has_more)
    )
      throw new AppError(
        "TIEBA_ANALYSIS_FOLLOWED",
        "贴吧未返回可读取的关注列表。",
      );
    const forums = data.like.map((forum: Record<string, unknown>) => {
      const id =
        typeof forum.forum_id === "string" ||
        Number.isSafeInteger(forum.forum_id)
          ? numericId(String(forum.forum_id))
          : null;
      if (!id || typeof forum.forum_name !== "string") throw invalidResponse();
      const name = forum.forum_name.trim();
      const level = forum.level_id;
      const followers = jsonCount(forum.member_num);
      const posts = jsonCount(forum.post_num);
      return {
        id,
        name,
        url: tiebaForumUrl(name),
        ...(followers !== undefined ? { followers } : {}),
        ...(posts !== undefined ? { posts } : {}),
        level:
          typeof level === "number" && Number.isSafeInteger(level) && level > 0
            ? level
            : null,
      };
    });
    return {
      visibility: "public",
      forums,
      hasMore:
        data.has_more === 1 || data.has_more === "1" || data.has_more === true,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "TIEBA_ANALYSIS_FOLLOWED",
      "未能读取贴吧关注列表，请稍后重试。",
    );
  }
}

export async function queryTiebaAnalysisWithContext(
  input: { target: string; page: number },
  send: typeof fetch = fetch,
): Promise<TiebaAnalysisPage> {
  const result = await queryTiebaAnalysis(input, send);
  const timeout = AbortSignal.timeout(12_000);
  const read: typeof fetch = (url, options) =>
    send(url, {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([timeout, options.signal])
        : timeout,
    });
  const targets = new Map(
    result.threads.flatMap((post) =>
      post.forumId && post.forum ? [[post.forumId, post.forum] as const] : [],
    ),
  );
  const samples = new Map<string, TiebaAnalysisForumPage>();
  const levels = new Map<string, number>();
  let ageYears: number | null = null;
  let vip: boolean | null = null;
  const profile = async () => {
    const user = await readAccount({ uid: result.uid }, read);
    if (objectId(user.integer(2)) !== result.uid) return;
    const age = user.string(38).trim();
    if (/^\d+(?:\.\d+)?$/u.test(age) && Number.isFinite(Number(age)))
      ageYears = Number(age);
    const status = tiebaFields(user.bytes(61) ?? empty).integer(1);
    const member = user.integer(39);
    if (member !== undefined) vip = member !== 0n;
    else if (status === 1n || status === 0n) vip = status === 1n;
    for (let page = 1; page <= 3 && levels.size < targets.size; page++) {
      const followed = await readFollowedPage(result.uid, page, user, read);
      if (followed.visibility === "restricted") break;
      for (const forum of followed.forums) {
        if (targets.has(forum.id) && forum.level !== null)
          levels.set(forum.id, forum.level);
      }
      if (!followed.hasMore) break;
    }
  };
  const queue = targets.entries();
  const sample = async () => {
    for (const [id, name] of queue) {
      if (timeout.aborted) break;
      const page = await queryTiebaAnalysisForumPosts(
        { name, page: 1 },
        read,
      ).catch(() => null);
      if (page?.id === id) samples.set(id, page);
    }
  };
  await Promise.all([
    profile().catch(() => {}),
    ...Array.from({ length: Math.min(4, targets.size) }, sample),
  ]);
  const forums = [...targets].map(([id, name]) => {
    const page = samples.get(id);
    const forumLevel = page?.threads.find(
      (post) => post.authorId === result.uid && post.forumLevel,
    )?.forumLevel;
    return {
      id,
      name,
      level: levels.get(id) ?? forumLevel ?? null,
      exposure: page?.exposure ?? null,
    };
  });
  const byId = new Map(forums.map((forum) => [forum.id, forum]));
  return {
    ...result,
    ageYears,
    vip,
    forums,
    threads: result.threads.map((post) => {
      const id = post.forumId ?? "";
      return {
        ...post,
        forumLevel: byId.get(id)?.level ?? null,
      };
    }),
  };
}
