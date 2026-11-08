import { errors, type Page } from "playwright-core";
import type { TiebaBrowserProfile } from "./types";
import type { TiebaPostStatsBrowser } from "../tieba-post-stats/types";
import type { TiebaPostStatsReading } from "../../shared/tieba-post-stats";
import { AppError } from "../errors";
import { tiebaBodyDriveLinks } from "../tieba-post-stats/links";
import {
  assertTiebaAccount,
  assertTiebaViewer,
  withTiebaBusinessPage,
} from "./browser-runtime";
import {
  assertTiebaParticipationPage,
  parseTiebaPosts,
  tiebaObjectId,
  tiebaParticipationPageScript,
  tiebaThreadIdFromUrl,
  tiebaThreadUrl,
  type TiebaParticipationPageSnapshot,
} from "./participation-page";

export const tiebaPostStatsPageScript = String.raw`(() => {
  const base=${tiebaParticipationPageScript};
  const nodes=[...new Set(document.querySelectorAll('#j_p_postlist .l_post[data-field], #pb_content .l_post[data-field]'))];
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const thread=window.PageData?.thread||{};
  return {...base,
    posts:base.posts.map((post,index)=>{const node=nodes[index],body=node?.querySelector('.d_post_content'),full=text(body);return {...post,text:full.slice(0,100000),truncated:!body||!body.getClientRects().length||full.length>100000||node.matches('[data-truncated="true"]')||!!node.querySelector('.j_content_fold,[data-truncated="true"],.j_content_hide')};}),
    postLinks:base.posts.map((post,index)=>({postId:String(post.data?.content?.post_id||post.data?.post_id||''),hrefs:[...(nodes[index]?.querySelectorAll('.d_post_content a[href]')||[])].map(a=>a.getAttribute('href')).filter(Boolean)})),
    metrics:{views:thread.view_num??null,likes:thread.agree_num??null,replyLabels:[...document.querySelectorAll('#thread_theme_5 .l_reply_num, #thread_theme_7 .l_reply_num, #pb_content .l_reply_num')].map(text)}
  };
})()`;
interface StatsPage extends TiebaParticipationPageSnapshot {
  postLinks: { postId: string; hrefs: string[] }[];
  metrics: { views: unknown; likes: unknown; replyLabels: string[] };
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const count = (value: unknown): number | null => {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u.test(value.trim())
  )
    return null;
  const n = Number(value.replaceAll(",", ""));
  return Number.isSafeInteger(n) ? n : null;
};
export function parseTiebaPostStats(
  s: StatsPage,
  uid: string,
  tid: string,
  at = new Date().toISOString(),
): TiebaPostStatsReading {
  assertTiebaParticipationPage(s, uid);
  if (
    tiebaThreadIdFromUrl(s.url) !== tid ||
    tiebaObjectId(record(s.thread).thread_id ?? record(s.thread).id) !== tid
  )
    throw new AppError(
      "TIEBA_POST_STATS_THREAD",
      "官网返回其他主题，原统计保留。",
    );
  const original = parseTiebaPosts(s).filter((p) => p.floor === 1);
  if (original.length !== 1 || original[0].authorUid !== uid)
    throw new AppError(
      "TIEBA_POST_STATS_AUTHOR",
      "未能核实为当前账号发布的主题，未纳入统计。",
    );
  if (original[0].truncated)
    throw new AppError(
      "TIEBA_POST_STATS_INCOMPLETE",
      "首帖正文尚未完整显示，无法核实网盘链接范围，原统计保留。",
    );
  const forum = record(s.forum),
    forumId = tiebaObjectId(forum.id ?? forum.forum_id),
    forumName = String(forum.name ?? forum.forum_name ?? "").trim();
  if (!forumId || !forumName || !s.title.trim())
    throw new AppError(
      "TIEBA_POST_STATS_FORUM",
      "主题标题或所属贴吧尚未完整显示，原统计保留。",
    );
  const linkRows = s.postLinks.filter(
    (row) => row.postId === original[0].postId,
  );
  if (linkRows.length !== 1)
    throw new AppError(
      "TIEBA_POST_STATS_BODY",
      "首帖链接来源无法唯一核实，原统计保留。",
    );
  const links = tiebaBodyDriveLinks(original[0].text, linkRows[0].hrefs);
  const replyValues = s.metrics.replyLabels.flatMap((label) => {
    const match = label
      .replace(/\s/gu, "")
      .match(/^(\d[\d,]*)回复[贴帖](?:，|,|共|$)/u);
    const n = match ? count(match[1]) : null;
    return n === null ? [] : [n];
  });
  const replies =
    replyValues.length && new Set(replyValues).size === 1
      ? replyValues[0]
      : null;
  const views = count(s.metrics.views),
    likes = count(s.metrics.likes);
  const missing = [
    views === null ? "浏览" : "",
    replies === null ? "回复" : "",
    likes === null ? "获赞" : "",
  ].filter(Boolean);
  return {
    threadId: tid,
    uid,
    forumId,
    forumName,
    title: s.title.trim(),
    url: tiebaThreadUrl(tid),
    links,
    views,
    replies,
    likes,
    checkedAt: at,
    message: missing.length
      ? `官网未提供可核实的${missing.join("、")}读数，保持未知。`
      : "已保存官网当前主题计数；不将页面阅读次数推算成浏览量。",
  };
}

export const tiebaOwnPostListScript = String.raw`(() => {
  const base=${tiebaParticipationPageScript};
  const pd=window.PageData||{},owner=pd.itieba?.creator||{};
  const root=document.querySelector('#content .simple_block_container');
  const pager=document.querySelector('#content .j_pager');
  return {...base,complete:document.readyState==='complete',ownerIds:[owner.id,owner.user_id].filter(v=>v!==undefined&&v!==null).map(String),threadCount:pd.itieba?.ithreads_num??null,
    ownList:!!root,threadHrefs:[...(root?.querySelectorAll('a[href]')||[])].map(a=>a.getAttribute('href')).filter(h=>/\/p\/[1-9]\d*/.test(h)),
    nextHrefs:[...(pager?.querySelectorAll('a[href]')||[])].filter(a=>/^(?:下一页|下页|>)$/.test((a.innerText||a.textContent||'').trim())||a.getAttribute('rel')==='next').map(a=>a.getAttribute('href'))};
})()`;
interface OwnPostList extends TiebaParticipationPageSnapshot {
  complete: boolean;
  ownerIds: string[];
  threadCount: unknown;
  ownList: boolean;
  threadHrefs: string[];
  nextHrefs: string[];
}
export function parseTiebaOwnPostList(
  s: OwnPostList,
  uid: string,
  page: number,
) {
  assertTiebaParticipationPage(s, uid);
  const url = new URL(s.url);
  if (
    url.pathname !== "/i/i/my_tie" ||
    url.searchParams.getAll("pn").length > 1 ||
    [...url.searchParams.keys()].some((key) => key !== "pn") ||
    Number(url.searchParams.get("pn") || "1") !== page ||
    !s.complete ||
    !s.ownList ||
    !s.ownerIds.length ||
    s.ownerIds.some((id) => id !== uid)
  )
    throw new AppError(
      "TIEBA_POST_STATS_LIST",
      "官网本人帖子列表或身份无法核实，未读取其他账号。",
    );
  const ids = s.threadHrefs.map(tiebaThreadIdFromUrl);
  if (
    ids.some((id) => !id) ||
    (!ids.length && count(s.threadCount) !== 0) ||
    new Set(ids).size > 20
  )
    throw new AppError(
      "TIEBA_POST_STATS_LIST",
      "官网本人帖子列表未完整显示，请稍后重新扫描或导入准确主题链接。",
    );
  const nextUrls = [...new Set(s.nextHrefs)];
  if (nextUrls.length > 1)
    throw new AppError(
      "TIEBA_POST_STATS_PAGINATION",
      "官网帖子分页不明确，原统计保留。",
    );
  let nextPage: number | null = null;
  if (nextUrls.length) {
    const next = new URL(nextUrls[0], "https://tieba.baidu.com");
    if (
      next.origin !== "https://tieba.baidu.com" ||
      next.username ||
      next.password ||
      next.port ||
      next.pathname !== "/i/i/my_tie" ||
      next.searchParams.getAll("pn").length !== 1 ||
      [...next.searchParams.keys()].some((key) => key !== "pn") ||
      next.searchParams.get("pn") !== String(page + 1)
    )
      throw new AppError(
        "TIEBA_POST_STATS_PAGINATION",
        "官网帖子下一页与原账号列表不一致，未继续读取。",
      );
    nextPage = page + 1;
  }
  return { threadIds: [...new Set(ids)] as string[], nextPage };
}

export function tiebaPostStatsBrowser(
  profile: TiebaBrowserProfile,
  options: { pageTimeoutMs?: number } = {},
): TiebaPostStatsBrowser {
  async function capture<T>(
    page: Page,
    script: string,
    ready: string,
  ): Promise<T> {
    try {
      await page.waitForFunction(
        `(()=>{const s=${script};return s.challenge||s.login||(${ready});})()`,
        undefined,
        { timeout: options.pageTimeoutMs ?? 6000 },
      );
    } catch (e) {
      if (!(e instanceof errors.TimeoutError)) throw e;
    }
    return page.evaluate<T>(script);
  }
  return {
    readThread(account, uid, tid) {
      assertTiebaAccount(account, uid);
      return profile(account, async (context) => {
        await assertTiebaViewer(context, uid);
        const reading = await withTiebaBusinessPage(
          context,
          async (page, go) => {
            await go(tiebaThreadUrl(tid));
            const s = await capture<StatsPage>(
              page,
              tiebaPostStatsPageScript,
              "document.readyState==='complete'&&s.forum&&s.thread&&s.posts.length",
            );
            return parseTiebaPostStats(s, uid, tid);
          },
        );
        await assertTiebaViewer(context, uid);
        return reading;
      });
    },
    listOwnThreads(account, uid, pageNumber) {
      assertTiebaAccount(account, uid);
      if (
        !Number.isSafeInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > 100
      )
        throw new AppError(
          "TIEBA_POST_STATS_PAGINATION",
          "请选择有效的本人帖子页码。",
        );
      return profile(account, async (context) => {
        await assertTiebaViewer(context, uid);
        const result = await withTiebaBusinessPage(
          context,
          async (page, go) => {
            await go(`https://tieba.baidu.com/i/i/my_tie?pn=${pageNumber}`);
            const s = await capture<OwnPostList>(
              page,
              tiebaOwnPostListScript,
              "s.complete&&s.ownList&&s.ownerIds.length",
            );
            return parseTiebaOwnPostList(s, uid, pageNumber);
          },
        );
        await assertTiebaViewer(context, uid);
        return result;
      });
    },
  };
}
