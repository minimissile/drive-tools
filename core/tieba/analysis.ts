import { createHash } from "node:crypto";
import type {
  TiebaAnalysisFollowedPage,
  TiebaAnalysisForumPage,
  TiebaAnalysisPage,
} from "../../shared/tieba-analysis";
import { normalizeTiebaForumName } from "../../shared/tieba-forums";
import { AppError } from "../errors";
import { readLimited, readLimitedBytes } from "../http";
import { resourceEvidence } from "../tieba-resource-discovery/rules";
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

async function readThread(tid: string, send: typeof fetch) {
  const data = await request(
    "thread",
    encodeTiebaFields([
      [4, BigInt(tid)],
      [13, 2n],
      [18, 1n],
      [25, legacyCommon],
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

function discoveryEvidence(
  post: ReturnType<typeof tiebaFields>,
  field: number,
  title: string,
) {
  const fragments = post.messages(field).slice(0, 50);
  return resourceEvidence(
    title,
    fragments
      .map((part) => part.string(2))
      .join("\n")
      .slice(0, 8000),
    fragments.map((part) => part.string(3)).filter(Boolean),
  );
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
  { name, page }: { name: string; page: number },
  send: typeof fetch = fetch,
  discoverResources = false,
): Promise<TiebaAnalysisForumPage> {
  const data = await request(
    "forum",
    encodeTiebaFields([
      [1, Buffer.from(name)],
      [2, 20n],
      [3, 25n],
      ...(page > 1 ? [[15, BigInt(page)] as const] : []),
      [39, legacyCommon],
      [47, 1n],
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
    if (
      (current !== BigInt(page) && !(page === 1 && current === 0n)) ||
      hasMore > 1n
    )
      throw invalidResponse();

    const authorName = (user: ReturnType<typeof tiebaFields>) =>
      user.string(4) || user.string(3);
    const authors = new Map(
      data.messages(17).map((user) => [user.integer(2), authorName(user)]),
    );
    const threads = new Map<
      string,
      TiebaAnalysisForumPage["threads"][number]
    >();
    for (const post of data.messages(7)) {
      const tid = objectId(post.integer(1));
      if (!tid || threads.has(tid)) continue;
      const author = tiebaFields(post.bytes(18) ?? empty);
      const agree = tiebaFields(post.bytes(126) ?? empty);
      const title = post.string(3) || "无标题主题帖";
      threads.set(tid, {
        id: tid,
        forumId: id,
        forum: canonical,
        title,
        author: authorName(author) || authors.get(post.integer(56)) || "",
        url: tiebaThreadUrl(tid),
        publishedAt: publishTime(post.integer(45)),
        views: count(post.integer(5)),
        replies: count(post.integer(4)),
        likes: count(agree.integer(1)),
        shares: count(post.integer(135)),
        ...(discoverResources
          ? {
              authorId:
                objectId(post.integer(56)) ?? objectId(author.integer(2)),
              resource: discoveryEvidence(post, 142, title),
            }
          : {}),
      });
    }
    if (!threads.size && hasMore === 1n) throw invalidResponse();
    return {
      id,
      name: canonical,
      url: tiebaForumUrl(canonical),
      page,
      hasMore: hasMore === 1n,
      threads: [...threads.values()],
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidResponse();
  }
}

export async function queryTiebaAnalysisFollowedForums(
  { uid, page }: { uid: string; page: number },
  send: typeof fetch = fetch,
): Promise<TiebaAnalysisFollowedPage> {
  const user = await readAccount({ uid }, send);
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
      return {
        id,
        name,
        url: tiebaForumUrl(name),
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
