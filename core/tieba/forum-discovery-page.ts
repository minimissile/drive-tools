import { AppError } from "../errors";
import {
  decodeTiebaForumUrlName,
  normalizeTiebaForumName,
} from "../../shared/tieba-forums";
import {
  tiebaForumKeywordSchema,
  type TiebaForumDiscoveryItem,
} from "../../shared/tieba-forum-discovery";
import {
  assertTiebaPage,
  parseTiebaForum,
  tiebaAutocarePageScript,
  tiebaForumUrl,
  type TiebaAutocarePageSnapshot,
} from "./autocare-page";
import { tiebaThreadIdFromUrl } from "./participation-page";
export const tiebaDiscoveryLimit = 8;
export const tiebaDiscoveryThreadLimit = 30;
export const tiebaForumDiscoverySearchUrl = (keyword: string) =>
  `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(tiebaForumKeywordSchema.parse(keyword))}&tab=forum`;
export const tiebaForumDiscoveryPageScript = String.raw`(()=>{
 const base=${tiebaAutocarePageScript};
 const visible=n=>!!n&&n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden';
 const text=n=>(n?.innerText||n?.textContent||'').replace(/\s+/g,' ').trim();
 const roots=[...document.querySelectorAll('.forum-content')].filter(n=>visible(n)&&!n.closest('.recommend-forums,.list-container-wrapper-nav'));
 const leaves=roots.filter(n=>![...n.querySelectorAll('.forum-content')].some(visible));
 const primary=leaves.flatMap(n=>[...n.querySelectorAll(':scope > .forum-jinzhun-jiucuo,:scope > .forum-jingzhun-jiucuo')]);
 const related=leaves.flatMap(n=>[...n.querySelectorAll(':scope > #relevantwrap.tb-simple-list')]).filter(n=>[...n.querySelectorAll(':scope > .linecard-component .line-card-font-weight')].some(h=>text(h)==='相关吧'));
 const blocks=[...new Set([...primary,...related])].filter(n=>!n.closest('.recommend-forums,.list-container-wrapper-nav'));
 const rows=[...new Set(blocks.flatMap(n=>[...n.querySelectorAll('a.relevant-forum')]))].filter(n=>!n.closest('.recommend-forums,.list-container-wrapper-nav'));
 const active=[...document.querySelectorAll('a.tab-item.active')].filter(n=>{try{return visible(n)&&text(n)==='吧'&&new URL(n.href).searchParams.get('tab')==='forum';}catch{return false;}});
 const input=[...document.querySelectorAll('input.search-box[type="search"]')].filter(visible);
 const area=blocks.map(n=>{const copy=n.cloneNode(true);copy.querySelectorAll('.recommend-forums,.list-container-wrapper-nav,[hidden],[aria-hidden="true"]').forEach(x=>x.remove());return text(copy);}).join(' ');
 const empty=rows.length===0&&/没有找到相关(?:的)?(?:贴吧|吧)|暂无相关(?:的)?(?:贴吧|吧)|未找到相关(?:的)?(?:贴吧|吧)/.test(area);
 const more=[...new Set(blocks.flatMap(n=>[...n.querySelectorAll('.list-load-more')]))].filter(n=>!n.closest('.recommend-forums,.list-container-wrapper-nav'));
 return{...base,searchInputCount:input.length,searchInput:input[0]?.value||'',searchActive:active.length===1,searchRecognized:leaves.length>0&&(blocks.length>0||empty),searchEmpty:empty,searchFailed:/加载失败|网络异常|服务繁忙|请求失败/.test(area),searchMore:more.some(n=>visible(n)&&/查看更多|加载更多/.test(text(n))),searchRowCount:rows.length,searchExcludedRecommendations:[...new Set(roots.flatMap(n=>[...n.querySelectorAll('.recommend-forums a.relevant-forum')]))].length,searchRows:rows.slice(0,16).map(n=>{const names=[...n.querySelectorAll('.name-wrapper > span:first-child')];return{href:n.getAttribute('href'),nameCount:names.length,name:text(names[0]),description:text(n.querySelector('.forum-des')).slice(0,600),info:text(n.querySelector('.forum-info')).slice(0,300)};})};
})()`;
export interface TiebaForumDiscoverySnapshot extends TiebaAutocarePageSnapshot {
  searchInputCount: number;
  searchInput: string;
  searchActive: boolean;
  searchRecognized: boolean;
  searchEmpty: boolean;
  searchFailed: boolean;
  searchMore: boolean;
  searchRowCount: number;
  searchExcludedRecommendations?: number;
  searchRows: {
    href: string | null;
    nameCount: number;
    name: string;
    description: string;
    info: string;
  }[];
}
export const discoveryCount = (value: string) => {
  const s = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/u.test(s)) return null;
  const n = Number(s.replace(/,/gu, ""));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
/** The new official result renderer emits one extra URI encoding layer. */
export function discoveryForumName(href: string, displayName: string) {
  if (href.length > 2000) return null;
  let source: URL;
  try {
    source = new URL(href, "https://tieba.baidu.com");
  } catch {
    return null;
  }
  if (
    source.origin !== "https://tieba.baidu.com" ||
    source.username ||
    source.password ||
    source.port ||
    !/^\/f\/?$/u.test(source.pathname) ||
    source.searchParams.getAll("kw").length !== 1
  )
    return null;
  const first = decodeTiebaForumUrlName(href, { allowRelative: true });
  let name: string;
  try {
    name = normalizeTiebaForumName(displayName);
  } catch {
    return null;
  }
  const candidates = first === null ? [] : [first];
  const intermediate = source.searchParams.get("kw") ?? "";
  if (/%[a-f\d]{2}/iu.test(intermediate) && !/[&#]/u.test(intermediate)) {
    const second = decodeTiebaForumUrlName(
      `https://tieba.baidu.com/f?kw=${intermediate}${source.searchParams
        .getAll("ie")
        .map((value) => `&ie=${encodeURIComponent(value)}`)
        .join("")}`,
    );
    if (second !== null) candidates.push(second);
  }
  return candidates.some((v) => {
    try {
      return normalizeTiebaForumName(v) === name;
    } catch {
      return false;
    }
  })
    ? name
    : null;
}
export function parseTiebaForumDiscovery(
  s: TiebaForumDiscoverySnapshot,
  uid: string,
  keyword: string,
  checkedAt = new Date().toISOString(),
) {
  assertTiebaPage(s, uid);
  const u = new URL(s.url);
  if (
    u.pathname !== "/f/search/res" ||
    u.searchParams.has("kw") ||
    u.searchParams.getAll("qw").length !== 1 ||
    u.searchParams.get("qw") !== keyword ||
    u.searchParams.getAll("tab").length !== 1 ||
    u.searchParams.get("tab") !== "forum" ||
    !s.searchActive ||
    s.searchInputCount !== 1 ||
    s.searchInput !== keyword ||
    !s.searchRecognized
  )
    throw new AppError(
      "TIEBA_DISCOVERY_UNRECOGNIZED",
      "官网找吧页的查询、结果标签或页面结构尚未核实，请重新查找。",
    );
  if (s.searchFailed)
    throw new AppError(
      "TIEBA_DISCOVERY_UNAVAILABLE",
      "官网找吧暂时加载失败，请稍后重新查找。",
    );
  const items: TiebaForumDiscoveryItem[] = [];
  const seen = new Set<string>();
  for (const row of s.searchRows) {
    if (!row.href || row.nameCount !== 1) continue;
    const name = discoveryForumName(row.href, row.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push({
      name,
      forumId: null,
      url: tiebaForumUrl(name),
      description: row.description,
      memberCount: discoveryCount(
        row.info.match(/关注\s*([\d,]+)(?=\s|$)/u)?.[1] ?? "",
      ),
      postCount: discoveryCount(
        row.info.match(/贴[子]?\s*([\d,]+)(?=\s|$)/u)?.[1] ?? "",
      ),
      threadCount: null,
      sampledThreads: 0,
      zeroReplyThreads: 0,
      latestActiveLabel: null,
      checkedAt,
      message: "候选来自官网本次找吧结果，尚未采样首页。",
    });
    if (items.length >= tiebaDiscoveryLimit) break;
  }
  if (!items.length && !s.searchEmpty)
    throw new AppError(
      "TIEBA_DISCOVERY_UNRECOGNIZED",
      "官网找吧尚未显示可核实的论坛候选，未将侧栏或推荐榜单当作结果。",
    );
  return { items, truncated: s.searchMore || s.searchRowCount > items.length };
}
export const tiebaForumActivityScript = String.raw`(()=>{
 const base=${tiebaAutocarePageScript};const text=n=>(n?.innerText||n?.textContent||'').replace(/\s+/g,' ').trim();
 const rows=[...document.querySelectorAll('#thread_list .j_thread_list[data-field]')];
 return{...base,description:text(document.querySelector('.card_slogan')).slice(0,600),threadsRecognized:!!document.getElementById('thread_list'),threadRowCount:rows.length,threadRows:rows.slice(0,${tiebaDiscoveryThreadLimit}).map(n=>{let data=null;try{data=JSON.parse(n.getAttribute('data-field')||'{}');}catch{}return{data,href:n.querySelector('a.j_th_tit')?.getAttribute('href')||null,activeLabel:text(n.querySelector('.threadlist_reply_date')).slice(0,100)};})};
})()`;
export interface TiebaForumActivitySnapshot extends TiebaAutocarePageSnapshot {
  description: string;
  threadsRecognized: boolean;
  threadRowCount: number;
  threadRows: { data: unknown; href: string | null; activeLabel: string }[];
}
export function parseTiebaForumActivity(
  s: TiebaForumActivitySnapshot,
  uid: string,
  item: TiebaForumDiscoveryItem,
  checkedAt = new Date().toISOString(),
) {
  const reading = parseTiebaForum(s, uid, {
    name: item.name,
    canonicalName: true,
  });
  const ids = new Set<string>();
  let sampledThreads = 0,
    zeroReplyThreads = 0,
    latestActiveLabel: string | null = null;
  for (const row of s.threadRows) {
    const d =
      row.data && typeof row.data === "object" && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {};
    const id = row.href ? tiebaThreadIdFromUrl(row.href) : null;
    if (
      !id ||
      String(d.id ?? d.tid) !== id ||
      ids.has(id) ||
      [true, 1, "1"].includes(d.is_top as boolean) ||
      [true, 1, "1"].includes(d.is_bakan as boolean)
    )
      continue;
    const count =
      typeof d.reply_num === "number"
        ? d.reply_num
        : typeof d.reply_num === "string" && /^\d+$/u.test(d.reply_num)
          ? Number(d.reply_num)
          : null;
    if (count === null || !Number.isSafeInteger(count) || count < 0) continue;
    ids.add(id);
    sampledThreads++;
    if (count === 0) zeroReplyThreads++;
    if (latestActiveLabel === null && row.activeLabel.trim())
      latestActiveLabel = row.activeLabel.trim();
  }
  const issues: string[] = [];
  if (!s.threadsRecognized) issues.push("首页主题列表未核实，未计算回复样本");
  else if (!sampledThreads) issues.push("首页没有可核实回复数的普通主题样本");
  if (s.threadRowCount > tiebaDiscoveryThreadLimit)
    issues.push(`仅读取首页前${tiebaDiscoveryThreadLimit}行`);
  if (latestActiveLabel)
    issues.push("时间标签保留首页首条样本原文，未推断年份");
  return {
    ...item,
    name: reading.name,
    forumId: reading.forumId,
    url: reading.url,
    description: s.description || item.description,
    memberCount: reading.memberCount ?? item.memberCount,
    postCount: reading.postCount ?? item.postCount,
    threadCount: reading.threadCount ?? null,
    sampledThreads,
    zeroReplyThreads,
    latestActiveLabel,
    checkedAt,
    message:
      issues.join("；") ||
      `仅采样当前首页${sampledThreads}条有明确回复数的普通主题。`,
  };
}
