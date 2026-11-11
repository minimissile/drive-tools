import { AppError } from "../errors";
import type { TiebaForumReading } from "../../shared/tieba-autocare";
import { tiebaCurrentUser } from "./identity";
import {
  normalizeTiebaForumName,
  tiebaForumHomeUrl,
  decodeTiebaForumUrlName,
} from "../../shared/tieba-forums";

export const tiebaSignSelector = "#signstar_wrapper .j_signbtn.j_cansign";
export const tiebaFollowSelector = "#j_head_focus_btn.focus_btn.islike_focus";

/** Read the signed-in viewer's widgets only; post bodies are never status evidence. */
export const tiebaAutocarePageScript = String.raw`(() => {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const pd = window.PageData || {};
  const sign = document.querySelector('#signstar_wrapper');
  const controls = [...document.querySelectorAll('#signstar_wrapper .j_signbtn.j_cansign')].filter(visible);
  const done = [...document.querySelectorAll('#signstar_wrapper .j_signed, #signstar_wrapper .sign_btn_nonpoint')].filter(visible);
  const errorNodes = [...document.querySelectorAll('.dialogJbody, .ui-dialog, #error_msg, .error_msg, #signstar_wrapper')].filter(visible);
  const statusText = errorNodes.map(text).join(' ').slice(0, 3000);
  const challenge = [...document.querySelectorAll('#captcha, #vcode, .captcha, .verify-dialog, .verify_dialog, iframe[src*="captcha"], iframe[src*="wappass.baidu.com"]')].some(visible)
    || /百度安全验证|安全验证|请输入验证码|完成验证|拖动.*滑块/.test(statusText)
    || /百度安全验证|安全验证/.test(document.title);
  const login = /登录|登陆/.test(text(sign)) && /后签到|再签到|请先|立即/.test(text(sign));
  const root = document.getElementById('pagelet_aside/pagelet/my_tieba');
  const levelNode = root?.querySelector('.my_current_forum .badge_index') || root?.querySelector('.user_level, .level_num, .tb_icon_author_rely, .forum_level');
  const expNode = root?.querySelector('.my_current_forum .exp_current_num') || root?.querySelector('.exp_num, .experience, .exp_value');
  const legacyLevel = root?.querySelector(':scope > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(1) > a > div:nth-child(2)');
  const legacyExp = root?.querySelector(':scope > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(2) > a > div:nth-child(2) > span:nth-child(1)');
  const container = document.querySelector('#like_pagelet, .forum_table');
  const headers=container?[...container.querySelectorAll('tr th')].map(text):[];
  const tableMetrics=headers.length===4&&headers.join('|')==='吧名|经验值|等级|取消关注';
  const links = container ? [...container.querySelectorAll('tr td:first-child a[href]')].map(a => {const cells=a.closest('tr')?.cells;const badges=cells?.[2]?[...cells[2].querySelectorAll('.like_badge_lv')]:[];return {href: a.getAttribute('href'), name: a.getAttribute('title') || text(a),levelText:tableMetrics?(badges.length===1?text(badges[0]):badges.length>1?'':text(cells?.[2])):'',experienceText:tableMetrics?text(cells?.[1]):''};}) : [];
  const next = [...document.querySelectorAll('#like_pagelet a[href], .pagination a[href], .pager a[href]')].find(a => visible(a) && /^(下一页|下页|下一页[>›»]?|[>›»])$/.test(text(a)));
  // The live logged-in PC page renders an empty server table with only four
  // headers, without an explicit empty-state message. Do not recognize the
  // same skeleton until loading is complete, or if rows/pagination remain.
  const table = container?.querySelector('.forum_table table, table');
  const rows = table ? [...table.rows] : [];
  const headerOnlyEmpty = document.readyState === 'complete' && visible(table)
    && rows.length === 1 && rows[0].cells.length === 4
    && [...rows[0].cells].every(cell => cell.tagName === 'TH')
    && [...rows[0].cells].map(text).join('|') === '吧名|经验值|等级|取消关注'
    && links.length === 0 && !next
    && !container.matches('[aria-busy="true"], .loading, .j_loading')
    && !container.querySelector('[aria-busy="true"], .loading, .j_loading');
  return {
    url: location.href,
    viewer: pd.user || null,
    forum: pd.forum || null,
    heading: text(document.querySelector('.card_title_fname')),
    challenge, login,
    statusText,
    signText: text(sign),
    signButtons: controls.length,
    signButtonText: text(controls[0]),
    signButtonTitle: controls[0]?.getAttribute('title') || '',
    signButtonHref: controls[0]?.getAttribute('href') || null,
    signDisabled: controls[0] ? (controls[0].hasAttribute('disabled') || controls[0].getAttribute('aria-disabled') === 'true') : false,
    signed: done.some(el => /已签到|连续\s*\d+\s*天/.test(text(el)+' '+(el.getAttribute('title')||''))),
    levelText: text(levelNode || legacyLevel),
    experienceText: text(expNode || legacyExp),
    memberText: text(document.querySelector('.card_num .card_menNum')),
    postText: text(document.querySelector('.card_num .card_infoNum')),
    footerText: text(document.querySelector('.thread_list_bottom .th_footer_l')),
    followButtonCount:[...document.querySelectorAll('#j_head_focus_btn.focus_btn.islike_focus')].filter(visible).length,
    followButtonHref:document.querySelector('#j_head_focus_btn')?.getAttribute('href')||null,
    followButtonClasses:document.querySelector('#j_head_focus_btn')?.className||'',
    listRecognized: !!container,
    listEmpty: !!container && (headerOnlyEmpty || /您还没有关注|暂未关注|还未关注|尚未关注|暂无关注|未关注任何/.test(text(container))),
    links,
    nextHref: next?.getAttribute('href') || null,
  };
})()`;

export interface TiebaAutocarePageSnapshot {
  url: string;
  viewer: unknown;
  forum: unknown;
  heading: string;
  challenge: boolean;
  login: boolean;
  statusText: string;
  signText: string;
  signButtons: number;
  signButtonText: string;
  signButtonTitle?: string;
  signButtonHref: string | null;
  signDisabled: boolean;
  signed: boolean;
  levelText: string;
  experienceText: string;
  memberText?: string;
  postText?: string;
  footerText?: string;
  followButtonCount?: number;
  followButtonHref?: string | null;
  followButtonClasses?: string;
  listRecognized: boolean;
  listEmpty: boolean;
  links: {
    href: string | null;
    name: string;
    levelText?: string;
    experienceText?: string;
  }[];
  nextHref: string | null;
}

export function tiebaForumUrl(name: string) {
  const url = tiebaForumHomeUrl(name);
  if (!url)
    throw new AppError(
      "TIEBA_FORUM_INVALID",
      "贴吧名称无效，请重新同步关注吧。",
    );
  return url;
}

function officialUrl(value: string) {
  try {
    const url = new URL(value, "https://tieba.baidu.com");
    return url.origin === "https://tieba.baidu.com" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url
      : null;
  } catch {
    return null;
  }
}

export function tiebaForumNameFromUrl(value: string) {
  return decodeTiebaForumUrlName(value, { allowRelative: true });
}

export function assertTiebaPage(
  snapshot: TiebaAutocarePageSnapshot,
  expectedUid: string,
) {
  if (!officialUrl(snapshot.url))
    throw new AppError(
      "TIEBA_PAGE_REDIRECT",
      "贴吧页面已离开官方 HTTPS 地址，请完成登录或安全验证后重试。",
    );
  if (snapshot.challenge)
    throw new AppError(
      "TIEBA_VERIFICATION_REQUIRED",
      "贴吧要求安全验证，请在该账号的官方窗口完成验证后再继续。",
    );
  if (snapshot.login)
    throw new AppError(
      "TIEBA_LOGIN_REQUIRED",
      "贴吧要求重新登录，请在该账号的官方窗口完成登录。",
    );
  if (
    snapshot.viewer &&
    typeof snapshot.viewer === "object" &&
    [false, 0, "0"].includes(
      (snapshot.viewer as Record<string, unknown>).is_login as boolean,
    )
  )
    throw new AppError(
      "TIEBA_LOGIN_REQUIRED",
      "贴吧页面已退出登录，请重新登录后检查。",
    );
  const viewer = tiebaCurrentUser(snapshot.viewer);
  if (viewer && viewer.uid !== expectedUid)
    throw new AppError(
      "TIEBA_IDENTITY_MISMATCH",
      "贴吧当前身份已变化，已停止原账号任务，请重新核验账号。",
    );
  if (
    /操作(?:太|过于|过)?频繁|请求(?:太|过于|过)?频繁|稍后再试|访问过于频繁/.test(
      snapshot.statusText,
    )
  )
    throw new AppError(
      "TIEBA_RATE_LIMITED",
      "贴吧提示操作频繁，已停止本次执行，请稍后重新检查。",
    );
}

/** Keep missing values unknown. The denominator of an experience bar is not earned experience. */
export function tiebaMetric(value: unknown, kind: "level" | "experience") {
  if (typeof value === "number")
    return Number.isSafeInteger(value) &&
      value >= 0 &&
      (kind !== "level" || value <= 100)
      ? value
      : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/,/g, "");
  const match =
    kind === "level"
      ? text.match(
          /^(?:(?:Lv\.?|LV\.?|等级|本吧等级)\s*[:：]?\s*)?(\d{1,3})(?:\s*级)?$/u,
        )
      : text.match(
          /^(?:(?:经验值?|当前经验)\s*[:：]?\s*)?(\d+)(?:\s*\/\s*\d+)?$/u,
        );
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) &&
    number >= 0 &&
    (kind !== "level" || number <= 100)
    ? number
    : null;
}

export function parseTiebaForum(
  snapshot: TiebaAutocarePageSnapshot,
  expectedUid: string,
  expected: { name: string; forumId?: string; canonicalName?: boolean },
  checkedAt = new Date().toISOString(),
): TiebaForumReading {
  assertTiebaPage(snapshot, expectedUid);
  const forum =
    snapshot.forum && typeof snapshot.forum === "object"
      ? (snapshot.forum as Record<string, unknown>)
      : {};
  const rawId = forum.id ?? forum.forum_id;
  const forumId =
    typeof rawId === "number" && !Number.isSafeInteger(rawId)
      ? ""
      : String(rawId ?? "");
  const rawName = forum.name ?? forum.forum_name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const matchesName = (actual: string | null, wanted: string) => {
    if (!expected.canonicalName) return actual === wanted;
    if (!actual) return false;
    try {
      // Forum names may preserve Latin case on the official page. Do not strip
      // trailing characters or accept aliases that resolve to a different name.
      const canonical = (value: string) =>
        normalizeTiebaForumName(value).replace(/[A-Z]/g, (letter) =>
          letter.toLowerCase(),
        );
      return canonical(actual) === canonical(wanted);
    } catch {
      return false;
    }
  };
  if (
    !/^[1-9]\d{0,19}$/.test(forumId) ||
    !matchesName(name, expected.name) ||
    !matchesName(tiebaForumNameFromUrl(snapshot.url), name)
  )
    throw new AppError(
      "TIEBA_FORUM_UNRECOGNIZED",
      "贴吧页面结构已变化或目标不匹配，未能核实吧名称与 ID，本次未执行签到。",
    );
  if (expected.forumId && forumId !== expected.forumId)
    throw new AppError(
      "TIEBA_FORUM_MISMATCH",
      "贴吧 ID 与保存的目标不一致，请重新同步后检查。",
    );
  const href = snapshot.signButtonHref?.trim() ?? "";
  const unsafeHref = !tiebaInertControlHref(href);
  const label = `${snapshot.signButtonTitle ?? ""} ${snapshot.signButtonText}`;
  const forbidden =
    unsafeHref ||
    !/签到/.test(label) ||
    /关注|会员|补签|购买|付费|签到卡/.test(label);
  const canSign =
    !forbidden && snapshot.signButtons === 1 && !snapshot.signDisabled
      ? true
      : snapshot.signed
        ? false
        : null;
  const signed = snapshot.signed ? true : canSign ? false : null;
  const count = (v: string | undefined) => {
    const s = (v ?? "").replace(/,/gu, "").trim();
    if (!/^\d+$/u.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  };
  const footer = snapshot.footerText ?? "";
  const footerMember = count(footer.match(/会员\s*数\s*([\d,]+)/u)?.[1]);
  const footerPosts = count(footer.match(/贴[子文]?数\s*([\d,]+)/u)?.[1]);
  const agree = (a: number | null, b: number | null) =>
    a !== null && b !== null && a !== b ? null : (a ?? b);
  return {
    forumId,
    name,
    url: tiebaForumUrl(name),
    level: tiebaMetric(snapshot.levelText, "level"),
    experience: tiebaMetric(snapshot.experienceText, "experience"),
    signed,
    canSign,
    memberCount: agree(count(snapshot.memberText), footerMember),
    postCount: agree(count(snapshot.postText), footerPosts),
    threadCount: count(footer.match(/主题数\s*([\d,]+)/u)?.[1]),
    message:
      signed === null ? "官网签到状态暂不可识别，已保留未知状态。" : null,
    checkedAt,
  };
}

/** Stats are meaningful only in the current account's explicitly labelled list. */
export function parseTiebaFollowedStats(
  snapshot: TiebaAutocarePageSnapshot,
  expectedUid: string,
) {
  const { names } = parseTiebaFollowedPage(snapshot, expectedUid);
  const result = new Map<
    string,
    { level: number | null; experience: number | null }
  >();
  for (const link of snapshot.links) {
    const name = link.href ? tiebaForumNameFromUrl(link.href) : null;
    if (!name || !names.includes(name)) continue;
    const row = {
      level: tiebaMetric(link.levelText, "level"),
      experience: tiebaMetric(link.experienceText, "experience"),
    };
    const old = result.get(name);
    result.set(
      name,
      old
        ? {
            level: old.level === row.level ? row.level : null,
            experience:
              old.experience === row.experience ? row.experience : null,
          }
        : row,
    );
  }
  return result;
}

export function tiebaInertControlHref(value: string | null) {
  return (
    value === null ||
    /^(?:|#|javascript:\s*(?:void\s*\(\s*0\s*\)\s*;?|;)?)$/iu.test(value.trim())
  );
}

export function parseTiebaFollowedPage(
  snapshot: TiebaAutocarePageSnapshot,
  expectedUid: string,
) {
  assertTiebaPage(snapshot, expectedUid);
  const url = officialUrl(snapshot.url);
  if (
    !url ||
    !["/i/i/forum", "/f/like/mylike"].includes(url.pathname) ||
    url.searchParams.has("uid") ||
    url.searchParams.has("un")
  )
    throw new AppError(
      "TIEBA_FOLLOWED_PAGE",
      "关注吧页面不是当前账号的官方列表，已停止同步。",
    );
  if (!snapshot.listRecognized)
    throw new AppError(
      "TIEBA_FOLLOWED_UNRECOGNIZED",
      "官网关注吧列表暂不可识别，原有目标已保留，请稍后重试。",
    );
  const names: string[] = [];
  for (const link of snapshot.links) {
    const name = link.href ? tiebaForumNameFromUrl(link.href) : null;
    if (link.href && !name) {
      const broken = officialUrl(link.href);
      if (broken && /^\/f\/?$/u.test(broken.pathname))
        throw new AppError(
          "TIEBA_FOLLOWED_UNRECOGNIZED",
          "官网关注列表有无法解码的吧名链接，未将该行视为未关注。",
        );
    }
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.length && !snapshot.listEmpty)
    throw new AppError(
      "TIEBA_FOLLOWED_UNRECOGNIZED",
      "关注吧列表尚未加载或结构已变化，未将其视为空列表。",
    );
  let next: string | null = null;
  if (snapshot.nextHref) {
    const nextUrl = officialUrl(snapshot.nextHref);
    const page = Number(nextUrl?.searchParams.get("pn"));
    if (
      !nextUrl ||
      nextUrl.pathname !== url.pathname ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100 ||
      nextUrl.searchParams.has("uid") ||
      nextUrl.searchParams.has("un")
    )
      throw new AppError(
        "TIEBA_FOLLOWED_PAGINATION",
        "关注吧翻页地址异常，已停止同步并保留原有目标。",
      );
    next = `https://tieba.baidu.com${url.pathname}?pn=${page}`;
  }
  return { names, next };
}
