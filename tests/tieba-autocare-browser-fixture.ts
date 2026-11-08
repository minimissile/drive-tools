export type TiebaFixtureMode =
  | "success"
  | "unknown"
  | "challenge"
  | "signed"
  | "missing"
  | "paid"
  | "ambiguous";

export function tiebaHomeFixture(uid = "111") {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.PageData={user:{user_id:${JSON.stringify(uid)},is_login:1,user_name:'本地测试'}};</script></body></html>`;
}

export function tiebaFollowedFixture(next = false) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <script>window.PageData={user:{user_id:'111',is_login:1}};</script>
    <div id="like_pagelet"><table><tbody><tr><th>吧名</th></tr>
      <tr><td><a href="/f?kw=${next ? "%E7%AC%AC%E4%BA%8C%E4%B8%AA" : "%E6%B5%8B%E8%AF%95"}">${next ? "第二个" : "测试"}</a></td></tr>
      ${next ? "" : '<tr><td><a href="/f?kw=%E6%B5%8B%E8%AF%95">测试</a></td></tr><tr><td><a href="https://example.invalid/f?kw=坏地址">外站</a></td></tr>'}
    </tbody></table>${next ? "" : '<a href="/i/i/forum?pn=2">下一页</a>'}</div></body></html>`;
}

export function tiebaForumFixture(
  name = "测试",
  mode: TiebaFixtureMode = "success",
) {
  const fid = name === "第二个" ? "200" : "100";
  const signed = mode === "signed";
  const anchor = `<a href="${mode === "paid" ? "/tbmall/tshow" : "javascript:;"}" class="j_signbtn ${signed ? "sign_btn_nonpoint" : "sign_btn_bright j_cansign"}">${signed ? "已签到 连续3天" : mode === "paid" ? "补签" : "签到"}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <script>window.PageData={user:{user_id:'111',is_login:1},forum:{id:${JSON.stringify(fid)},name:${JSON.stringify(name)}}};</script>
    <a class="card_title_fname">${name}吧</a>
    <div id="pagelet_aside/pagelet/my_tieba"><span class="user_level">Lv.4</span><span class="experience">35 / 50</span></div>
    <div id="signstar_wrapper">${mode === "missing" ? "" : anchor}${mode === "ambiguous" ? anchor : ""}</div>
    <script>for (const button of document.querySelectorAll('.j_cansign')) button.addEventListener('click', async event => {
      event.preventDefault();
      await fetch('/sign/add', {method:'POST'});
      ${mode === "unknown" ? "" : mode === "challenge" ? "document.querySelector('#signstar_wrapper').textContent='请完成安全验证';" : "button.className='j_signbtn sign_btn_nonpoint';button.textContent='已签到 连续4天';"}
    });</script>
  </body></html>`;
}
