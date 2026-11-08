import { AppError } from "../errors";
import { tiebaCurrentUser } from "./identity";
import type {
  TiebaThreadCandidate,
  TiebaThreadContext,
  TiebaReplyReceipt,
} from "../../shared/tieba-participation";

export const tiebaReplyEditorSelector =
  '#tb_rich_poster_container #ueditor_replace[contenteditable="true"], #tb_rich_poster_container textarea[name="content"]';
export const tiebaReplyButtonSelector =
  "#tb_rich_poster_container .poster_submit";
export const tiebaParticipationPageScript = String.raw`(() => {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const meta = el => { try { return JSON.parse(el.getAttribute('data-field') || '{}'); } catch { return null; } };
  const pd = window.PageData || {};
  const dialogs = [...document.querySelectorAll('.dialogJbody, .ui-dialog, #error_msg, .error_msg, #tb_rich_poster_container .poster_error')].filter(visible);
  const statusText = dialogs.map(text).join(' ').slice(0, 3000);
  const challenge = [...document.querySelectorAll('#captcha, #vcode, .captcha, .verify-dialog, .verify_dialog, iframe[src*="captcha"], iframe[src*="wappass.baidu.com"]')].some(visible)
    || /百度安全验证|请输入验证码|完成验证|拖动.*滑块/.test(statusText) || /百度安全验证|安全验证/.test(document.title);
  const editorRoot = document.getElementById('tb_rich_poster_container');
  const editors = [...document.querySelectorAll('#tb_rich_poster_container #ueditor_replace[contenteditable="true"], #tb_rich_poster_container textarea[name="content"]')].filter(visible);
  const buttons = [...document.querySelectorAll('#tb_rich_poster_container .poster_submit')].filter(visible);
  const rawPosts = [...document.querySelectorAll('#j_p_postlist .l_post[data-field], #pb_content .l_post[data-field]')];
  const posts = [...new Set(rawPosts)].map(el => {
    const data = meta(el); const body = el.querySelector('.d_post_content');
    const raw = text(body);
    const hasMedia = !!body && [...body.querySelectorAll('img, video, audio, iframe')].some(node => !node.matches('img[src*="face"], img[src*="emotion"]'));
    const folded = !!el.querySelector('.j_content_fold, [data-truncated="true"], .j_content_hide');
    const incompleteReason = !body ? '首帖正文尚未加载，请重新读取。' : hasMedia ? '首帖含有尚未读取的图片、视频或附件，当前仅展示文字，暂不能据此生成回复。' : folded ? '首帖存在折叠或隐藏内容，当前正文不完整，请先在官网查看。' : raw.length > 24000 ? '首帖超出当前可完整读取的长度，暂不能据此生成回复。' : null;
    const truncated = !!incompleteReason;
    return { data, text: raw.slice(0, 24000), truncated, incompleteReason, authorName: text(el.querySelector('.p_author_name, .d_name a')).slice(0, 100) };
  });
  const rows = [...document.querySelectorAll('#thread_list .j_thread_list[data-field]')].map(el => {
    const authors = el.querySelectorAll('span.tb_icon_author[data-field]');
    return { data: meta(el), author: authors.length === 1 ? meta(authors[0]) : null, ambiguousAuthor: authors.length > 1, href: el.querySelector('a.j_th_tit')?.getAttribute('href') || null, title: el.querySelector('a.j_th_tit')?.getAttribute('title') || text(el.querySelector('a.j_th_tit')), closed: !!el.querySelector('.icon_thread_locked, .thread_locked') };
  });
  const pagination = [...document.querySelectorAll('#pb_content .l_posts_num a[href], .pb_footer .l_posts_num a[href]')];
  const last = pagination.find(el => /^(尾页|最后一页)$/.test(text(el)));
  const activePage = document.querySelector('#pb_content .l_posts_num .tP, #pb_content .l_posts_num span.red');
  const locked = pd.thread?.is_closed === true || pd.thread?.is_closed === 1 || pd.thread?.is_forbidden === true || pd.thread?.is_forbidden === 1 || /帖子已被锁定|本帖禁止回复|此贴禁止回复|该帖已关闭|禁止回复本帖/.test(text(editorRoot));
  return { url: location.href, viewer: pd.user || null, forum: pd.forum || null, thread: pd.thread || null,
    title: text(document.querySelector('h3.core_title_txt, h1.core_title_txt, .core_title_txt')).slice(0, 200),
    challenge, statusText, login: /登录|登陆/.test(text(editorRoot)) && /后回复|后发表|请先|立即/.test(text(editorRoot)),
    listRecognized: !!document.getElementById('thread_list'), listEmpty: !!document.querySelector('#thread_list .thread_list_empty, #thread_list .j_thread_list_empty'), rows,
    posts, activePage: text(activePage), lastHref: last?.getAttribute('href') || null,
    locked, editorCount: editors.length, editorText: editors[0] ? ('value' in editors[0] ? editors[0].value : text(editors[0])) : '',
    editorDisabled: !!editors[0] && (editors[0].hasAttribute('disabled') || editors[0].getAttribute('aria-disabled') === 'true'),
    submitCount: buttons.length, submitText: text(buttons[0]).replace(/\s+/g, ''),
    submitDisabled: !!buttons[0] && (buttons[0].hasAttribute('disabled') || buttons[0].getAttribute('aria-disabled') === 'true'),
    submitHref: buttons[0]?.getAttribute('href') || null };
})()`;

export interface TiebaParticipationPageSnapshot {
  url: string;
  viewer: unknown;
  forum: unknown;
  thread: unknown;
  title: string;
  challenge: boolean;
  statusText: string;
  login: boolean;
  listRecognized: boolean;
  listEmpty: boolean;
  rows: {
    data: unknown;
    author?: unknown;
    ambiguousAuthor?: boolean;
    href: string | null;
    title: string;
    closed: boolean;
  }[];
  posts: {
    data: unknown;
    text: string;
    truncated: boolean;
    incompleteReason?: string | null;
    authorName: string;
  }[];
  activePage: string;
  lastHref: string | null;
  locked: boolean;
  editorCount: number;
  editorText: string;
  editorDisabled: boolean;
  submitCount: number;
  submitText: string;
  submitDisabled: boolean;
  submitHref: string | null;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const tiebaObjectId = (value: unknown): string | null => {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const id = String(value ?? "");
  return /^[1-9]\d{0,19}$/.test(id) ? id : null;
};
/** Undefined means conflicting author evidence; null means no author evidence. */
export function tiebaRowAuthorUid(
  row: TiebaParticipationPageSnapshot["rows"][number],
): string | null | undefined {
  const data = record(row.data);
  const rowUid = tiebaObjectId(data.author_id ?? record(data.author).user_id);
  const iconUid = tiebaObjectId(record(row.author).user_id);
  if (row.ambiguousAuthor || (rowUid && iconUid && rowUid !== iconUid))
    return undefined;
  return rowUid ?? iconUid;
}
export function tiebaThreadUrl(threadId: string, postId?: string) {
  if (
    !tiebaObjectId(threadId) ||
    (postId !== undefined && !tiebaObjectId(postId))
  )
    throw new AppError(
      "TIEBA_THREAD_INVALID",
      "帖子或楼层 ID 无效，请重新读取。",
    );
  return `https://tieba.baidu.com/p/${threadId}${postId ? `?pid=${postId}#${postId}` : ""}`;
}
export function tiebaThreadIdFromUrl(value: string) {
  try {
    const u = new URL(value, "https://tieba.baidu.com");
    if (
      u.origin !== "https://tieba.baidu.com" ||
      u.username ||
      u.password ||
      u.port
    )
      return null;
    const m = u.pathname.match(/^\/p\/([1-9]\d{0,19})\/?$/u);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
export function tiebaSafeThreadPage(value: string, threadId: string) {
  if (tiebaThreadIdFromUrl(value) !== threadId) return null;
  const u = new URL(value, "https://tieba.baidu.com");
  const keys = [...u.searchParams.keys()];
  if (
    keys.some(
      (key) => !["pn", "pid", "see_lz", "red_tag", "fr"].includes(key),
    ) ||
    (u.searchParams.has("pn") &&
      !/^[1-9]\d{0,4}$/.test(u.searchParams.get("pn")!))
  )
    return null;
  // A receipt search must include all authors, never a "see only original poster" view.
  u.searchParams.delete("see_lz");
  return u.href;
}
export function assertTiebaParticipationPage(
  s: TiebaParticipationPageSnapshot,
  uid: string,
) {
  const u = new URL(s.url);
  if (
    u.origin !== "https://tieba.baidu.com" ||
    u.username ||
    u.password ||
    u.port
  )
    throw new AppError(
      "TIEBA_PAGE_REDIRECT",
      "贴吧页面离开官方 HTTPS 地址，已停止执行。",
    );
  if (s.challenge)
    throw new AppError(
      "TIEBA_VERIFICATION_REQUIRED",
      "贴吧要求安全验证，请在账号窗口完成后重新检查。",
    );
  if (s.login || [false, 0, "0"].includes(record(s.viewer).is_login as boolean))
    throw new AppError(
      "TIEBA_LOGIN_REQUIRED",
      "贴吧要求重新登录，请先核验原账号。",
    );
  if (
    /操作(?:太|过于|过)?频繁|请求(?:太|过于|过)?频繁|稍后再试/.test(
      s.statusText,
    )
  )
    throw new AppError(
      "TIEBA_RATE_LIMITED",
      "贴吧提示操作频繁，已停止本次操作。",
    );
  const viewer = tiebaCurrentUser(s.viewer);
  if (!viewer || viewer.uid !== uid)
    throw new AppError(
      "TIEBA_IDENTITY_MISMATCH",
      "未能核实页面当前身份，已停止原账号操作。",
    );
}
function assertForum(
  s: TiebaParticipationPageSnapshot,
  expected: { forumId: string; forumName: string },
) {
  const forum = record(s.forum);
  if (
    tiebaObjectId(forum.id ?? forum.forum_id) !== expected.forumId ||
    (forum.name ?? forum.forum_name) !== expected.forumName
  )
    throw new AppError(
      "TIEBA_FORUM_MISMATCH",
      "帖子所属贴吧与目标不一致，已停止读取。",
    );
}
export function parseTiebaThreadList(
  s: TiebaParticipationPageSnapshot,
  uid: string,
  forum: { forumId: string; name: string },
  at = new Date().toISOString(),
): TiebaThreadCandidate[] {
  assertTiebaParticipationPage(s, uid);
  assertForum(s, { forumId: forum.forumId, forumName: forum.name });
  const u = new URL(s.url);
  if (
    !/^\/f\/?$/u.test(u.pathname) ||
    u.searchParams.get("kw") !== forum.name ||
    !s.listRecognized ||
    (!s.rows.length && !s.listEmpty)
  )
    throw new AppError(
      "TIEBA_THREADS_UNRECOGNIZED",
      "帖子列表尚未完整显示或页面结构已变化，原候选已保留。",
    );
  const seen = new Set<string>(),
    result: TiebaThreadCandidate[] = [];
  for (const row of s.rows) {
    const data = record(row.data),
      threadId = row.href ? tiebaThreadIdFromUrl(row.href) : null;
    if (
      !threadId ||
      tiebaObjectId(data.id ?? data.tid) !== threadId ||
      seen.has(threadId)
    )
      continue;
    if (
      row.closed ||
      [true, 1, "1"].includes(data.is_top as boolean) ||
      [true, 1, "1"].includes(data.is_locked as boolean) ||
      [true, 1, "1"].includes(data.is_closed as boolean)
    )
      continue;
    const title = row.title.trim();
    if (!title || title.length > 200) continue;
    const authorUid = tiebaRowAuthorUid(row);
    if (authorUid === undefined) continue;
    if (authorUid === uid) continue;
    const count =
      typeof data.reply_num === "number" &&
      Number.isSafeInteger(data.reply_num) &&
      data.reply_num >= 0
        ? data.reply_num
        : null;
    seen.add(threadId);
    result.push({
      threadId,
      forumId: forum.forumId,
      forumName: forum.name,
      title,
      url: tiebaThreadUrl(threadId),
      authorUid,
      replyCount: count,
      lastActiveAt: null,
      discoveredAt: at,
    });
    if (result.length >= 30) break;
  }
  return result;
}
export function parseTiebaPosts(s: TiebaParticipationPageSnapshot) {
  return s.posts.flatMap((row) => {
    const data = record(row.data),
      content = record(data.content),
      author = record(data.author);
    const postId = tiebaObjectId(content.post_id ?? data.post_id),
      authorUid = tiebaObjectId(author.user_id ?? author.id);
    const no = Number(content.post_no);
    if (!postId || !Number.isSafeInteger(no) || no < 1) return [];
    return [
      {
        postId,
        authorUid,
        authorName: row.authorName.slice(0, 100),
        text: row.text,
        truncated: row.truncated,
        incompleteReason: row.incompleteReason,
        floor: no,
      },
    ];
  });
}
export function canReplyToTiebaPage(s: TiebaParticipationPageSnapshot) {
  const safeHref =
    !s.submitHref ||
    /^(?:#|javascript:(?:void\(0\)|;)?;?)$/iu.test(s.submitHref.trim());
  return (
    !s.locked &&
    s.editorCount === 1 &&
    !s.editorDisabled &&
    s.submitCount === 1 &&
    !s.submitDisabled &&
    /^(?:发表|发布|回复)$/u.test(s.submitText) &&
    safeHref
  );
}
export function assertTiebaThreadIdentity(
  s: TiebaParticipationPageSnapshot,
  uid: string,
  expected: { threadId: string; forumId: string; forumName: string },
) {
  assertTiebaParticipationPage(s, uid);
  assertForum(s, expected);
  const thread = record(s.thread);
  if (
    tiebaThreadIdFromUrl(s.url) !== expected.threadId ||
    tiebaObjectId(thread.thread_id ?? thread.id ?? thread.tid) !==
      expected.threadId
  )
    throw new AppError(
      "TIEBA_THREAD_MISMATCH",
      "帖子 ID 与原目标不一致，已停止操作。",
    );
}
export function parseTiebaThreadContext(
  s: TiebaParticipationPageSnapshot,
  uid: string,
  candidate: TiebaThreadCandidate,
  at = new Date().toISOString(),
): TiebaThreadContext {
  assertTiebaThreadIdentity(s, uid, candidate);
  const posts = parseTiebaPosts(s),
    original = posts.find((p) => p.floor === 1);
  const title = s.title.trim();
  const truncated =
    !original ||
    original.truncated ||
    !original.authorUid ||
    !original.text.trim() ||
    original.text.length > 24000 ||
    !title;
  const canReply = canReplyToTiebaPage(s);
  const incompleteReason = !original
    ? "官网尚未完整显示首帖，请重新读取。"
    : original.truncated
      ? original.incompleteReason ||
        "首帖含有尚未完整读取的内容，暂不能据此生成回复。"
      : !original.authorUid
        ? "未能核实首帖作者身份，请重新读取。"
        : !title
          ? "官网主题标题尚未完整显示，请重新读取。"
          : original.text.trim().length < 20
            ? "首帖文字不足20字，缺少准备有效回复的上下文。"
            : s.locked
              ? "官网已锁定该主题，不能回复。"
              : !canReply
                ? "官网普通回复编辑器尚不可用，请重新读取或在官网核实限制。"
                : null;
  return {
    threadId: candidate.threadId,
    forumId: candidate.forumId,
    forumName: candidate.forumName,
    title: title || candidate.title,
    url: tiebaThreadUrl(candidate.threadId),
    authorUid: original?.authorUid ?? candidate.authorUid,
    body: original?.text.trim() ?? "",
    replies: posts
      .filter((p) => p.floor !== 1 && !p.truncated && p.text.trim())
      .slice(0, 8)
      .map(
        ({
          floor: _floor,
          truncated: _truncated,
          incompleteReason: _reason,
          ...p
        }) => p,
      ),
    closed: s.locked ? true : canReply ? false : null,
    canReply: canReply ? true : s.locked ? false : null,
    truncated,
    incompleteReason,
    checkedAt: at,
  };
}
export const normalizedTiebaReply = (body: string) =>
  body.normalize("NFKC").replace(/\s+/gu, " ").trim();
export function findTiebaReplyReceipt(
  s: TiebaParticipationPageSnapshot,
  uid: string,
  thread: TiebaThreadContext,
  body: string,
  at = new Date().toISOString(),
): TiebaReplyReceipt | null {
  assertTiebaThreadIdentity(s, uid, thread);
  const matched = parseTiebaPosts(s).filter(
    (p) =>
      p.floor > 1 &&
      !p.truncated &&
      p.authorUid === uid &&
      normalizedTiebaReply(p.text) === normalizedTiebaReply(body),
  );
  if (matched.length !== 1) return null;
  const post = matched[0];
  return {
    status: "verified",
    threadId: thread.threadId,
    postId: post.postId,
    url: tiebaThreadUrl(thread.threadId, post.postId),
    authorUid: uid,
    body: post.text,
    checkedAt: at,
    message: "官网楼层已核实，作者与回复正文匹配。",
  };
}
