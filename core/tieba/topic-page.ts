import { AppError } from "../errors";
import { normalizeTiebaForumName } from "../../shared/tieba-forums";
import type { TiebaTopicReceipt } from "../../shared/tieba-topics";
import type { TiebaTopicPayload } from "./topic-types";
import {
  assertTiebaParticipationPage,
  tiebaObjectId,
  tiebaParticipationPageScript,
  tiebaThreadIdFromUrl,
  tiebaThreadUrl,
  tiebaRowAuthorUid,
  type TiebaParticipationPageSnapshot,
} from "./participation-page";

export const tiebaTopicTitleSelector =
  '#tb_rich_poster_container input[name="title"], #tb_rich_poster_container .j_title_input';
export const tiebaTopicEditorSelector =
  '#tb_rich_poster_container #ueditor_replace[contenteditable="true"], #tb_rich_poster_container textarea[name="content"]';
export const tiebaTopicSubmitSelector =
  "#tb_rich_poster_container .poster_submit";
export const tiebaTopicFileSelector =
  '#tb_rich_poster_container input[type="file"]';
export const tiebaTopicImageButtonSelector =
  "#tb_rich_poster_container .edui-btn-image";
export const tiebaTopicLocalUploadSelector =
  "#tb_rich_poster_container .edui-dialog-container .edui-dropdown-menu.edui-popup .layer_btn_list .from_upload .pic_upload_container";
export const tiebaTopicPageScript = String.raw`(() => {
  const base = ${tiebaParticipationPageScript};
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const titles = [...document.querySelectorAll('${tiebaTopicTitleSelector}')].filter(visible);
  const root = document.getElementById('tb_rich_poster_container');
  const files = root ? [...root.querySelectorAll('input[type="file"]')] : [];
  const editor = root?.querySelector('#ueditor_replace, textarea[name="content"]');
  return {...base,
    topicTitleCount: titles.length, topicTitle: titles[0]?.value || '',
    topicTitleDisabled: !!titles[0] && (titles[0].disabled || titles[0].getAttribute('aria-disabled') === 'true'),
    topicFileCount: files.length, topicFileMultiple: !!files[0]?.multiple,
    topicImageButtonCount: [...document.querySelectorAll('${tiebaTopicImageButtonSelector}')].filter(visible).length,
    topicEditorImages: editor ? [...editor.querySelectorAll('img')].map(i=>i.getAttribute('src') || '') : [],
    topicUploading: !!root?.querySelector('.uploading, .upload_loading, [aria-busy="true"]'),
    topicUnsupported: !!editor?.querySelector('video, audio, iframe') || !!root?.querySelector('input[type="checkbox"]:checked, [data-paid="true"]'),
    topicReview: /(?:帖子|主题|发布内容).{0,20}(?:审核中|等待审核|审核通过后)|(?:发布成功|发表成功).{0,20}(?:审核)/.test(base.statusText),
    topicPosts: [...new Set(document.querySelectorAll('#j_p_postlist .l_post[data-field], #pb_content .l_post[data-field]'))].map(el=>{
      let data=null;try{data=JSON.parse(el.getAttribute('data-field') || '{}');}catch{}
      const body=el.querySelector('.d_post_content');
      const links=body?[...body.querySelectorAll('a[href]')].filter(visible).map(a=>({text:(a.innerText||a.textContent||'').trim(),href:(a.getAttribute('href')||'').trim()})):[];
      const replacedLinkHrefs=[];
      const directShare = value => {try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['pan.baidu.com','yun.baidu.com','pan.quark.cn','drive.uc.cn','pan.uc.cn','fast.uc.cn','pan.xunlei.com','guangyapan.com','www.guangyapan.com','mypikpak.com'].includes(u.hostname)&&(/^\/s\/[a-zA-Z0-9_-]+\/?$/.test(u.pathname)||(['pan.baidu.com','yun.baidu.com'].includes(u.hostname)&&u.pathname==='/share/init'&&/^[a-zA-Z0-9_-]+$/.test(u.searchParams.get('surl')||'')));}catch{return false;}};
      const linkedText = node => {
        if(node.nodeType===Node.TEXT_NODE)return node.textContent||'';
        if(node.nodeType!==Node.ELEMENT_NODE)return '';
        const style=getComputedStyle(node);
        if(style.display==='none'||style.visibility==='hidden'||['SCRIPT','STYLE'].includes(node.tagName))return '';
        if(node.tagName==='BR')return '\n';
        if(node.tagName==='A'){
          const label=(node.innerText||node.textContent||'').trim(),href=(node.getAttribute('href')||'').trim();
          if(label==='网页链接'&&directShare(href)){replacedLinkHrefs.push(href);return href;}
        }
        const value=[...node.childNodes].map(linkedText).join('');
        return /^(block|flex|grid|list-item|table.*)$/.test(style.display)?'\n'+value+'\n':value;
      };
      const linkText=body?linkedText(body).trim():'';
      const date=String(data?.content?.date || [...el.querySelectorAll('.post-tail-wrap .tail-info')].map(n=>n.textContent||'').find(v=>/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(v.trim())) || '');
      return {data,createdAt:date,text:(body?.innerText || body?.textContent || '').trim(),links,linkText,replacedLinkHrefs,images:body?[...body.querySelectorAll('img')].filter(i=>!/face|emotion/.test(i.getAttribute('src')||'')).map(i=>i.getAttribute('src')||''):[],truncated:!body||!!el.querySelector('.j_content_fold,[data-truncated="true"],.j_content_hide')||!!body?.querySelector('video,audio,iframe')};
    })};
})()`;
export interface TiebaTopicPageSnapshot extends TiebaParticipationPageSnapshot {
  topicTitleCount: number;
  topicTitle: string;
  topicTitleDisabled: boolean;
  topicFileCount: number;
  topicFileMultiple: boolean;
  topicImageButtonCount: number;
  topicEditorImages: string[];
  topicUploading: boolean;
  topicUnsupported: boolean;
  topicReview: boolean;
  topicPosts: {
    data: unknown;
    createdAt: string;
    text: string;
    links?: { text: string; href: string }[];
    linkText?: string;
    replacedLinkHrefs?: string[];
    images: string[];
    truncated: boolean;
  }[];
}

/** Reconciliation includes the viewer's own rows without changing M2 discovery. */
export function topicOwnCandidates(
  s: TiebaTopicPageSnapshot,
  uid: string,
  p: TiebaTopicPayload,
) {
  assertTopicForum(s, uid, p);
  if (!s.listRecognized || (!s.rows.length && !s.listEmpty))
    throw new AppError(
      "TIEBA_TOPIC_LIST",
      "官网主题列表尚未完整显示，不能核对本人主题。",
    );
  const ids = new Set<string>();
  for (const row of s.rows) {
    const data = record(row.data),
      tid = row.href ? tiebaThreadIdFromUrl(row.href) : null;
    if (
      tid &&
      tid === tiebaObjectId(data.id ?? data.tid) &&
      tiebaRowAuthorUid(row) === uid &&
      topicText(row.title) === topicText(p.title)
    )
      ids.add(tid);
    if (ids.size >= 5) break;
  }
  return [...ids];
}
export function topicCreationTime(s: TiebaTopicPageSnapshot) {
  const originals = s.topicPosts.filter(
    (p) => Number(record(record(p.data).content).post_no) === 1,
  );
  if (originals.length !== 1) return null;
  const value = originals[0].createdAt.trim();
  let time: number;
  if (/^\d{10}$/u.test(value)) time = Number(value) * 1000;
  else if (/^\d{13}$/u.test(value)) time = Number(value);
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/u.test(value))
    time = Date.parse(value.replace(" ", "T") + "+08:00");
  else if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
    time = Date.parse(value);
  else return null;
  return Number.isFinite(time) ? time : null;
}
export const topicText = (v: string) =>
  v.normalize("NFKC").replace(/\s+/gu, " ").trim();
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function officialTiebaImage(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      /^(?:[a-z0-9-]+\.)*(?:baidu\.com|bdimg\.com)$/iu.test(u.hostname) &&
      u.pathname !== "/"
      ? `${u.origin}${u.pathname}`
      : null;
  } catch {
    return null;
  }
}
export function assertTopicForum(
  s: TiebaTopicPageSnapshot,
  uid: string,
  p: Pick<TiebaTopicPayload, "forumId" | "forumName">,
) {
  assertTiebaParticipationPage(s, uid);
  const f = record(s.forum);
  let actual: string;
  try {
    actual = normalizeTiebaForumName(String(f.name ?? f.forum_name ?? ""));
  } catch {
    throw new AppError("TIEBA_TOPIC_FORUM", "官网未提供可核实的贴吧名称。");
  }
  const name = (v: string) =>
    normalizeTiebaForumName(v).replace(/[A-Z]/gu, (c) => c.toLowerCase());
  if (
    tiebaObjectId(f.id ?? f.forum_id) !== p.forumId ||
    name(actual) !== name(p.forumName)
  )
    throw new AppError(
      "TIEBA_TOPIC_FORUM",
      "官网贴吧ID或名称与原主题目标不一致。",
    );
  const u = new URL(s.url);
  if (!tiebaThreadIdFromUrl(s.url)) {
    if (
      !/^\/f\/?$/u.test(u.pathname) ||
      u.searchParams.getAll("kw").length !== 1 ||
      name(u.searchParams.get("kw") ?? "") !== name(p.forumName)
    )
      throw new AppError("TIEBA_TOPIC_FORUM", "官网主题页面目标不明确。");
  }
}
export function assertTopicEditor(
  s: TiebaTopicPageSnapshot,
  uid: string,
  p: TiebaTopicPayload,
  filled = false,
  uploaded: { sha256: string; url: string }[] = [],
) {
  assertTopicForum(s, uid, p);
  if (
    tiebaThreadIdFromUrl(s.url) ||
    s.topicTitleCount !== 1 ||
    s.editorCount !== 1 ||
    s.submitCount !== 1 ||
    s.topicTitleDisabled ||
    s.editorDisabled ||
    s.submitDisabled ||
    s.topicUnsupported ||
    s.topicUploading ||
    !/^(?:发表|发表帖子|发帖|发布|发布主题)$/u.test(s.submitText)
  )
    throw new AppError(
      "TIEBA_TOPIC_EDITOR",
      "官网没有唯一可用的普通主题编辑器与发布按钮。",
    );
  if (
    s.submitHref &&
    ![
      "#",
      "javascript:void(0);",
      "javascript:void(0)",
      "javascript:;",
    ].includes(s.submitHref)
  )
    throw new AppError(
      "TIEBA_TOPIC_EDITOR",
      "发布按钮包含未识别目标，已停止。",
    );
  if (filled) {
    if (
      topicText(s.topicTitle) !== topicText(p.title) ||
      topicText(s.editorText) !== topicText(p.body) ||
      s.topicEditorImages.length !== uploaded.length ||
      s.topicEditorImages.some(
        (v) =>
          !uploaded.some(
            (i) => officialTiebaImage(i.url) === officialTiebaImage(v),
          ),
      )
    )
      throw new AppError(
        "TIEBA_TOPIC_EDITOR_CHANGED",
        "编辑器图文与已保存版本不一致。",
      );
  } else if (
    s.topicTitle.trim() ||
    s.editorText.trim() ||
    s.topicEditorImages.length
  )
    throw new AppError(
      "TIEBA_TOPIC_EDITOR_OCCUPIED",
      "官网已有未提交主题内容，已保留原稿，请先在官网处理。",
    );
  if (
    p.images.length &&
    s.topicFileCount !== 1 &&
    s.topicImageButtonCount !== 1
  )
    throw new AppError(
      "TIEBA_TOPIC_IMAGE_CONTROL",
      "官网本地图片上传控件不唯一或无法一次选择本稿配图。",
    );
}
export function topicUnknown(
  p: TiebaTopicPayload,
  message: string,
  images: { sha256: string; url: string }[] = [],
  threadId: string | null = null,
): TiebaTopicReceipt {
  return {
    status: "uncertain",
    forumId: p.forumId,
    threadId,
    postId: null,
    url: threadId ? tiebaThreadUrl(threadId) : null,
    authorUid: null,
    title: null,
    body: null,
    images,
    checkedAt: new Date().toISOString(),
    message,
  };
}
function topicReceiptBody(
  post: TiebaTopicPageSnapshot["topicPosts"][number],
  expected: string,
) {
  const expectedLinks: string[] =
    expected.match(/https?:\/\/[^\s<>"'，。；）)]+/giu) ?? [];
  // Displayed URL text alone cannot prove where an official anchor points.
  for (const link of post.links ?? []) {
    if (link.text === "网页链接" || /https?:\/\//iu.test(link.text)) {
      if (!expectedLinks.includes(link.href)) return null;
      try {
        const url = new URL(link.href);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port
        )
          return null;
      } catch {
        return null;
      }
    }
  }
  if (topicText(post.text) === topicText(expected)) return post.text;
  if (
    !post.replacedLinkHrefs?.length ||
    !post.linkText ||
    post.replacedLinkHrefs.some((href) => !expectedLinks.includes(href))
  )
    return null;
  return topicText(post.linkText) === topicText(expected)
    ? post.linkText
    : null;
}
export function topicReceipt(
  s: TiebaTopicPageSnapshot,
  uid: string,
  p: TiebaTopicPayload,
  images: { sha256: string; url: string }[],
): TiebaTopicReceipt | null {
  assertTopicForum(s, uid, p);
  const tid = tiebaThreadIdFromUrl(s.url),
    thread = record(s.thread);
  if (
    !tid ||
    tiebaObjectId(thread.thread_id ?? thread.id) !== tid ||
    topicText(s.title) !== topicText(p.title)
  )
    return null;
  // Only the complete original floor proves a newly created topic, never an arbitrary reply.
  const matches = s.topicPosts.filter((post) => {
    const c = record(record(post.data).content);
    return Number(c.post_no) === 1;
  });
  if (matches.length !== 1) return null;
  const post = matches[0],
    data = record(post.data),
    author = record(data.author),
    content = record(data.content),
    pid = tiebaObjectId(content.post_id),
    receiptBody = topicReceiptBody(post, p.body);
  if (
    !pid ||
    post.truncated ||
    tiebaObjectId(author.user_id ?? author.id) !== uid ||
    receiptBody === null ||
    post.images.length !== p.images.length ||
    images.length !== p.images.length
  )
    return null;
  if (
    new Set(images.map((i) => i.sha256)).size !== p.images.length ||
    p.images.some((i) => !images.some((v) => v.sha256 === i.sha256)) ||
    images.some(
      (i) =>
        !officialTiebaImage(i.url) ||
        !post.images.some(
          (v) => officialTiebaImage(v) === officialTiebaImage(i.url),
        ),
    ) ||
    post.images.some((v) => !officialTiebaImage(v))
  )
    return null;
  return {
    status: "verified",
    forumId: p.forumId,
    threadId: tid,
    postId: pid,
    url: tiebaThreadUrl(tid, pid),
    authorUid: uid,
    title: s.title,
    body: receiptBody,
    images,
    checkedAt: new Date().toISOString(),
    message: "官网首帖已核实原账号、主题ID、首帖ID及图文。",
  };
}
