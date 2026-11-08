export type TiebaParticipationFixtureMode =
  | "success"
  | "unknown"
  | "challenge"
  | "missing"
  | "truncated"
  | "locked"
  | "ambiguous"
  | "occupied"
  | "last-page"
  | "delayed-editor"
  | "changed";
export const fixtureThreadBody =
  "我正在整理本地开发环境的资料，已有项目的账号与浏览器环境共用。请问怎样确保多个任务依次执行，并且应用重新启动后不会重复发布已经提交的内容？目前使用的是桌面客户端。";
export const fixtureReplyBody =
  "可以先把待执行任务与提交记录分别保存，执行时按账号环境串行领取；重启后先核对已经提交的结果，再继续尚未提交的任务。";
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function participationForumFixture() {
  const row = (tid: string, author: string, pinned = false) =>
    `<li class="j_thread_list" data-field='${JSON.stringify({ id: tid, reply_num: 2, is_top: pinned })}'><a class="j_th_tit" href="/p/${tid}" title="如何整理本地开发任务">如何整理本地开发任务</a><span class="tb_icon_author" data-field='${JSON.stringify({ user_id: author })}'></span></li>`;
  return `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{user_id:'111',is_login:1},forum:{id:'100',name:'测试'}};</script><ul id="thread_list">${row("1000", "333")}${row("1000", "333")}${row("2000", "111")}${row("3000", "444", true)}</ul>`;
}
export function participationPostFixture(
  postId: string,
  uid: string,
  floor: number,
  body: string,
  truncated = false,
) {
  return `<div class="l_post" data-field='${JSON.stringify({ author: { user_id: uid }, content: { post_id: postId, post_no: floor } })}'><a class="p_author_name">作者${uid}</a><div class="d_post_content">${escape(body)}${truncated ? '<img class="BDE_Image" src="https://image.invalid/content.png">' : ""}</div></div>`;
}
export function participationThreadFixture(
  mode: TiebaParticipationFixtureMode = "success",
  already = false,
  last = false,
) {
  const body =
    mode === "changed"
      ? `${fixtureThreadBody}后来又修改了需求。`
      : fixtureThreadBody;
  const content =
    mode === "missing"
      ? ""
      : participationPostFixture("10001", "333", 1, body, mode === "truncated");
  const posts = `${last ? "" : content}${already ? participationPostFixture("10009", "111", 9, fixtureReplyBody) : participationPostFixture("10002", "555", 2, "建议查看任务的实际提交时间。")}`;
  const editor = `<div id="ueditor_replace" contenteditable="true">${mode === "occupied" ? "已有本人未提交草稿" : ""}</div><a href="javascript:;" class="poster_submit j_submit">发 表</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <script>window.PageData={user:{user_id:'111',is_login:1},forum:{id:'100',name:'测试'},thread:{thread_id:'1000'}};</script>
  <h3 class="core_title_txt">如何整理本地开发任务</h3><div id="pb_content"><div id="j_p_postlist">${posts}</div>${mode === "last-page" && !last ? '<div class="l_posts_num"><a href="/p/1000?pn=2">尾页</a></div>' : ""}</div>
  <div id="tb_rich_poster_container">${mode === "locked" ? "帖子已被锁定" : mode === "delayed-editor" ? "" : `${editor}${mode === "ambiguous" ? editor : ""}`}</div>
  ${mode === "delayed-editor" ? `<script>setTimeout(()=>{document.getElementById('tb_rich_poster_container').innerHTML=${JSON.stringify(editor)}},80)</script>` : ""}
  <script>for (const button of document.querySelectorAll('.poster_submit')) button.addEventListener('click',async event=>{event.preventDefault();const body=document.querySelector('#ueditor_replace').innerText;await fetch('/reply-fixture',{method:'POST',body});${mode === "unknown" || mode === "last-page" ? "" : mode === "challenge" ? "document.querySelector('#tb_rich_poster_container').insertAdjacentHTML('beforeend','<div class=dialogJbody>请完成验证</div>');" : `document.querySelector('#j_p_postlist').insertAdjacentHTML('beforeend', ${JSON.stringify(participationPostFixture("10009", "111", 9, fixtureReplyBody))});`}});</script></body></html>`;
}
