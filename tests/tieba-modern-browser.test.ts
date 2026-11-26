import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { verifyBitTieba } from "../core/tieba/browser-session";
import { tiebaAutocareBrowser } from "../core/tieba/autocare-browser";
import { tiebaModernForum } from "../core/tieba/modern-page";
import type { WebsiteAccount } from "../shared/website-accounts";
let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
});
after(async () => {
  await browser?.close();
});
const response = (name = "资料", signed = 0) => ({
  error_code: 0,
  user: { id: 111, is_login: 1, name_show: "本人" },
  forum: {
    id: 101,
    name,
    is_like: 1,
    user_level: 3,
    cur_score: 28,
    member_num: 49,
    post_num: 251,
    thread_num: 75,
    sign_in_info: { user_info: { user_id: 111, is_sign_in: signed } },
  },
});
test("新版论坛响应只接收当前登录用户及同一用户的签到状态", () => {
  const reading = tiebaModernForum(response());
  assert.equal(reading?.viewer.uid, "111");
  assert.equal(reading?.signed, false);
  assert.equal(reading?.experience, 28);
  assert.equal(tiebaModernForum({ ...response(), error_code: 1 }), null);
  assert.equal(
    tiebaModernForum({ ...response(), user: { id: 111, is_login: 0 } }),
    null,
  );
  const wrong = response();
  wrong.forum.sign_in_info.user_info.user_id = 222;
  assert.equal(tiebaModernForum(wrong), null);
});
test("新版无PageData页面配对原始UID，浮动控件仅点击一次并核实普通签到", async () => {
  const context = await browser.newContext();
  const manualPage = await context.newPage();
  let signed = 0,
    writes = 0,
    checkpoints = 0;
  try {
    await context.route("https://tieba.baidu.com/**", async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/f/user/json_userinfo")
        return route.fulfill({
          json: {
            no: 0,
            data: { is_login: true, open_uid: 999, user_name_show: "本人" },
          },
        });
      if (u.pathname === "/c/f/frs/page_pc")
        return route.fulfill({
          json: response(u.searchParams.get("kw") || "资料", signed),
        });
      if (u.pathname === "/fixture-sign") {
        assert.equal(checkpoints, 1);
        writes++;
        signed = 1;
        return route.fulfill({ json: { ok: true } });
      }
      if (["/f/like/mylike", "/i/i/forum"].includes(u.pathname))
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: '<div id="like_pagelet"><div class="forum_table"><table><tr><th>吧名</th><th>经验值</th><th>等级</th><th>取消关注</th></tr><tr><td><a href="/f?kw=资料">资料</a></td><td>28</td><td><span class="like_badge_lv">3</span></td><td></td></tr></table></div></div>',
        });
      if (u.pathname === "/f")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<style>.follow-sign{animation:float 0.1s infinite alternate}@keyframes float{from{transform:translateX(0)}to{transform:translateX(2px)}}</style><div class="bar-info"><div class="operate-btn follow-sign"><div class="center">${signed ? "已签到" : "签到"}</div></div><div class="follow-btn">已关注</div></div><script>fetch('/c/f/frs/page_pc?kw='+encodeURIComponent(${JSON.stringify(u.searchParams.get("kw"))}));document.querySelector('.follow-sign').onclick=async()=>{await fetch('/fixture-sign',{method:'POST'});document.querySelector('.follow-sign .center').textContent='已签'}</script>`,
        });
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<html></html>",
      });
    });
    const identity = await verifyBitTieba(context);
    assert.equal(identity.uid, "111");
    assert.equal(identity.tiebaOpenUid, "999");
    const account = {
      provider: "tieba",
      uid: "111",
      id: "web_fixture",
    } as WebsiteAccount;
    const api = tiebaAutocareBrowser(async (_a, action) => action(context), {
      pageTimeoutMs: 100,
      resultTimeoutMs: 500,
    });
    const forums = await api.listForums(account, "111");
    assert.equal(forums.length, 1);
    assert.equal(forums[0].experience, 28);
    assert.equal(forums[0].level, 3);
    assert.equal(forums[0].postCount, 251);
    assert.equal(forums[0].signed, false);
    assert.equal(forums[0].canSign, true);
    const result = await api.checkIn(account, "111", forums[0], async () => {
      checkpoints++;
    });
    assert.equal(result.signed, true);
    assert.equal(writes, 1);
    assert.equal(checkpoints, 1);
    await api.checkIn(account, "111", forums[0], async () => {
      checkpoints++;
    });
    assert.equal(writes, 1);
    assert.equal(checkpoints, 1);
    assert.deepEqual(context.pages(), [manualPage]);
    let identityReads = 0;
    await context.route(
      "https://tieba.baidu.com/f/user/json_userinfo",
      (route) =>
        route.fulfill({
          json: {
            no: 0,
            data: {
              is_login: true,
              open_uid: ++identityReads === 1 ? 999 : 888,
              user_name_show: "本人",
            },
          },
        }),
    );
    await assert.rejects(() => verifyBitTieba(context), {
      code: "TIEBA_IDENTITY_UNVERIFIED",
    });
    assert.deepEqual(context.pages(), [manualPage]);
  } finally {
    await context.close();
  }
});
