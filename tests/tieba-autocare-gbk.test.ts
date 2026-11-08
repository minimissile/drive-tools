import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { tiebaAutocareBrowser } from "../core/tieba/autocare-browser";
import {
  tiebaAutocarePageScript,
  parseTiebaFollowedPage,
  parseTiebaFollowedStats,
  type TiebaAutocarePageSnapshot,
} from "../core/tieba/autocare-page";
import { tiebaHomeFixture } from "./tieba-autocare-browser-fixture";
import type { WebsiteAccount } from "../shared/website-accounts";
const account: WebsiteAccount = {
  id: "web_gbk_fixture",
  provider: "tieba",
  uid: "111",
  alias: "GBK官网结构",
  status: "connected",
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
};
const forum = {
  forumId: "2503486",
  name: "电子书资源",
  url: "https://tieba.baidu.com/f?kw=%E7%94%B5%E5%AD%90%E4%B9%A6%E8%B5%84%E6%BA%90&ie=utf-8",
  level: null,
  experience: null,
  signed: null,
  canSign: null,
  message: null,
  checkedAt: "2026-11-07T00:00:00Z",
};
const gbk = "/f?kw=%B5%E7%D7%D3%CA%E9%D7%CA%D4%B4";
// Sanitized from the live four-column table; no cancel token or personal data.
const row = `<tr><td><a href="${gbk}" title="电子书资源">电子书资源</a></td><td><a class="cur_exp">1</a></td><td><a class="like_badge badge_lv1" title="1级会员"><div class="like_badge_title">白丁</div><div class="like_badge_lv">1</div></a></td><td>取消关注</td></tr>`;
const list = (liked: boolean, broken = false) =>
  `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{id:'111',is_login:1}};</script><div id="like_pagelet"><meta charset="gbk"><div class="forum_table"><table><tr><th>吧名</th><th>经验值</th><th>等级</th><th>取消关注</th></tr>${liked ? row : ""}${broken ? '<tr><td><a href="/f?kw=%E7%94&ie=utf-8">无法识别的一行</a></td><td>0</td><td>0</td><td>取消关注</td></tr>' : ""}</table></div></div>`;
const pageHtml = (liked: boolean) =>
  `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{id:'111',is_login:1},forum:{id:'2503486',name:'电子书资源'}};</script><a rel="noopener" href="#" onclick="return false" class="focus_btn ${liked ? "cancel_focus" : "islike_focus"}" id="j_head_focus_btn" style="display:block;width:80px;height:28px"></a><div id="signstar_wrapper"><a title="签到" class="j_signbtn sign_btn_bright j_cansign"><span>11月07日</span><span>漏签0天</span></a></div><div id="pagelet_aside/pagelet/my_tieba"><div id="user_info"><div class="user_score"><a class="score_num j_score_num">0</a></div></div>${liked ? '<div class="my_current_forum"><p class="title">我的本吧信息</p><div class="user_level"><div class="rank"><a>本吧牛人排行榜</a></div><a class="badge badge_lv1" title="本吧头衔1级，经验值1，点击进入本吧头衔说明页"><div class="badge_name">白丁</div><div class="badge_index">1</div></a></div><div class="exp"><a class="exp_bar"><div class="exp_num"><span class="exp_current_num">1</span><span>/5</span></div></a></div></div>' : ""}</div><div class="card_num"><span class="card_menNum">${liked ? "446" : "445"}</span><span class="card_infoNum">905</span></div><div class="thread_list_bottom"><div class="th_footer_l">共有主题数62个，贴子数905篇 会员数${liked ? "446" : "445"}</div></div><script>document.querySelector('#j_head_focus_btn').addEventListener('click',async event=>{event.preventDefault();const button=event.currentTarget;await fetch('/fixture-like',{method:'POST'});button.className='focus_btn cancel_focus';});</script>`;
let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
});
after(async () => {
  await browser?.close();
});
async function fixture(initial = true, broken = false) {
  const context = await browser.newContext();
  let liked = initial,
    posts = 0;
  await context.route("https://tieba.baidu.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture-like") {
      posts++;
      liked = true;
      await route.fulfill({ body: "ok" });
    } else
      await route.fulfill({
        contentType: "text/html;charset=utf-8",
        body:
          url.pathname === "/"
            ? tiebaHomeFixture("111")
            : url.pathname === "/i/i/forum"
              ? list(liked, broken)
              : pageHtml(liked),
      });
  });
  const original = await context.newPage();
  await original.setContent("<title>original tab</title>");
  const api = tiebaAutocareBrowser(async (_a, action) => action(context), {
    pageTimeoutMs: 200,
    resultTimeoutMs: 200,
  });
  return {
    context,
    api,
    get posts() {
      return posts;
    },
    async close() {
      assert.equal(context.pages().length, 1);
      assert.equal(context.pages()[0], original);
      assert.equal(await original.title(), "original tab");
      await context.close();
    },
  };
}
test("exact GBK table and current-bar badge structure yield one Chinese followed forum with level1/exp1", async () => {
  const f = await fixture();
  try {
    const rows = await f.api.listForums(account, "111");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "电子书资源");
    assert.equal(rows[0].forumId, "2503486");
    assert.equal(rows[0].followed, true);
    assert.equal(rows[0].level, 1);
    assert.equal(rows[0].experience, 1);
    assert.equal(f.posts, 0);
  } finally {
    await f.close();
  }
});
test("GBK membership confirms an existing relation without ever invoking the follow mutation gate", async () => {
  const f = await fixture();
  try {
    let gates = 0;
    const r = await f.api.followForum!(account, "111", forum, async () => {
      gates++;
      throw Error("must remain read-only");
    });
    assert.equal(r.status, "followed");
    assert.equal(r.reading.followed, true);
    assert.equal(r.reading.level, 1);
    assert.equal(gates, 0);
    assert.equal(f.posts, 0);
  } finally {
    await f.close();
  }
});
test("a single explicit follow is confirmed through the actual GBK list row, never from experience/count changes", async () => {
  const f = await fixture(false);
  try {
    let gates = 0;
    const r = await f.api.followForum!(account, "111", forum, async () => {
      gates++;
    });
    assert.equal(r.status, "followed");
    assert.equal(r.reading.followed, true);
    assert.deepEqual([r.reading.level, r.reading.experience], [1, 1]);
    assert.equal(gates, 1);
    assert.equal(f.posts, 1);
  } finally {
    await f.close();
  }
});
test("an undecodable official row prevents treating a partially readable list as a complete negative relation", async () => {
  const f = await fixture(true, true);
  try {
    const page = await f.context.newPage();
    try {
      await page.goto("https://tieba.baidu.com/i/i/forum?pn=1");
      const s = await page.evaluate<TiebaAutocarePageSnapshot>(
        tiebaAutocarePageScript,
      );
      assert.equal(s.links[0].levelText, "1");
      assert.throws(() => parseTiebaFollowedPage(s, "111"), {
        code: "TIEBA_FOLLOWED_UNRECOGNIZED",
      });
      assert.throws(() => parseTiebaFollowedStats(s, "111"), {
        code: "TIEBA_FOLLOWED_UNRECOGNIZED",
      });
    } finally {
      await page.close();
    }
    let gates = 0;
    await assert.rejects(
      f.api.followForum!(account, "111", forum, async () => {
        gates++;
      }),
    );
    assert.equal(gates, 0);
    assert.equal(f.posts, 0);
  } finally {
    await f.close();
  }
});
