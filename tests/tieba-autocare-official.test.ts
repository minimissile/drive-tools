import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { tiebaAutocareBrowser } from "../core/tieba/autocare-browser";
import { tiebaForumUrl } from "../core/tieba/autocare-page";
import { tiebaHomeFixture } from "./tieba-autocare-browser-fixture";
import type { WebsiteAccount } from "../shared/website-accounts";
const account: WebsiteAccount = {
  id: "web_official_fixture",
  provider: "tieba",
  alias: "官方结构离线测试",
  uid: "111",
  status: "connected",
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
};
const forum = {
  forumId: "100",
  name: "测试",
  url: tiebaForumUrl("测试"),
  level: null,
  experience: null,
  signed: null,
  canSign: null,
  message: null,
  checkedAt: "2026-11-07T00:00:00Z",
};
type Mode =
  | "observed"
  | "followed"
  | "delayed"
  | "unknown"
  | "ambiguous"
  | "paid"
  | "wrong-fid"
  | "missing-list"
  | "foreign-list"
  | "pagination"
  | "zero"
  | "wrong-header"
  | "signed-title"
  | "conflict";
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
async function fixture(mode: Mode = "observed") {
  const context = await browser.newContext();
  let liked = [
      "followed",
      "delayed",
      "pagination",
      "zero",
      "wrong-header",
      "conflict",
    ].includes(mode),
    uid = "111",
    posts = 0,
    lists = 0;
  const events: string[] = [];
  const table = (pn: number) => {
    const row = (name: string, exp: string, level: string) =>
      `<tr><td><a href="/f?kw=${encodeURIComponent(name)}">${name}</a></td><td>${exp}</td><td>${level}</td><td>取消关注</td></tr>`;
    return `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{id:'${mode === "foreign-list" ? "222" : uid}',is_login:1}};</script><div id="like_pagelet" ${mode === "missing-list" ? 'aria-busy="true"' : ""}><div class="forum_table"><table><tr><th>吧名</th><th>${mode === "wrong-header" ? "全局余额" : "经验值"}</th><th>等级</th><th>取消关注</th></tr>${mode === "pagination" && pn === 1 ? row("其他吧", "200", "6") : liked ? row("测试", mode === "delayed" ? "" : mode === "zero" ? "0" : "35", mode === "delayed" ? "" : mode === "zero" ? "0" : "4") : ""}</table></div>${mode === "pagination" && pn === 1 ? '<a href="/i/i/forum?pn=2">下一页</a>' : ""}</div>`;
  };
  const header = `<a id="j_head_focus_btn" class="focus_btn islike_focus" rel="noopener"${mode === "paid" ? ' href="/tbmall/tshow"' : ""} style="display:block;width:80px;height:30px"></a>`;
  const document = () =>
    `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{id:'${uid}',is_login:1},forum:{id:'${mode === "wrong-fid" ? "999" : "100"}',name:'测试'}};</script><div class="card_num"><span class="card_menNum">10</span><span class="card_infoNum">11</span></div>${header}${mode === "ambiguous" ? header : ""}<div id="signstar_wrapper"><a title="${mode === "signed-title" ? "已签到" : "签到"}" class="j_signbtn ${mode === "signed-title" ? "sign_btn_nonpoint" : "sign_btn_bright"}${mode === "delayed" || mode === "signed-title" ? "" : " j_cansign"}"><span class="sign_today_date">11月07日</span><span class="sign_month_lack_days">漏签<span class="j_sign_month_lack_days">0</span>天</span></a></div><div id="pagelet_aside/pagelet/my_tieba"><div id="user_info"><div class="user_score"><a class="orange_text score_num j_score_num"><i class="icon-tbean"></i>0</a><a>[获取]</a></div></div>${mode === "conflict" ? '<span class="user_level">Lv.6</span><span class="experience">99 / 100</span>' : ""}</div><div class="thread_list_bottom"><div class="th_footer_l">共有主题数<span class="red_text">5</span>个，贴子数<span class="red_text">11</span>篇 <a class="fans_name">会员</a>数<span class="red_text">10</span></div></div><script>${mode === "delayed" ? `setTimeout(()=>{document.querySelector('.j_signbtn').classList.add('j_cansign');const node=document.getElementById('pagelet_aside/pagelet/my_tieba');node.insertAdjacentHTML('beforeend','<span class="user_level">Lv.4</span><span class="experience">35 / 50</span>');},120);` : ""}document.querySelector('#j_head_focus_btn').onclick=async e=>{e.preventDefault();const button=e.currentTarget;await fetch('/fixture-follow',{method:'POST'});${mode === "unknown" ? "" : "button.className='focus_btn followed';button.textContent='已关注';"}};</script>`;
  await context.route("https://tieba.baidu.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture-follow") {
      posts++;
      events.push("post");
      if (mode !== "unknown") liked = true;
      await route.fulfill({ body: "ok" });
    } else if (url.pathname === "/i/i/forum") {
      lists++;
      await route.fulfill({
        contentType: "text/html",
        body: table(Number(url.searchParams.get("pn") ?? 1)),
      });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: url.pathname === "/" ? tiebaHomeFixture(uid) : document(),
      });
  });
  const old = await context.newPage();
  await old.setContent("<title>original user tab</title>");
  const api = tiebaAutocareBrowser(async (_a, action) => action(context), {
    pageTimeoutMs: 300,
    resultTimeoutMs: 150,
  });
  return {
    api,
    events,
    get counts() {
      return { posts, lists };
    },
    set uid(value: string) {
      uid = value;
    },
    async close() {
      assert.equal(context.pages().length, 1);
      assert.equal(context.pages()[0], old);
      assert.equal(await old.title(), "original user tab");
      await context.close();
    },
  };
}
test("real date-text/title-sign widget is read and global T-bean zero is never personal experience", async () => {
  const f = await fixture();
  try {
    const r = await f.api.resolveForum!(account, "111", "测试");
    assert.equal(r.followed, false);
    assert.equal(r.signed, false);
    assert.equal(r.canSign, true);
    assert.equal(r.level, null);
    assert.equal(r.experience, null);
    assert.match(r.personalStatsMessage ?? "", /尚未关注/);
    assert.deepEqual([r.memberCount, r.postCount, r.threadCount], [10, 11, 5]);
    assert.equal(f.counts.posts, 0);
  } finally {
    await f.close();
  }
});
test("official followed-table labelled numeric cells supply missing personal bar stats", async () => {
  const f = await fixture("followed");
  try {
    const r = await f.api.readForum(account, "111", forum);
    assert.equal(r.followed, true);
    assert.equal(r.level, 4);
    assert.equal(r.experience, 35);
    assert.equal(r.personalStatsMessage, null);
    assert.equal(f.counts.lists, 1);
    assert.equal(f.counts.posts, 0);
  } finally {
    await f.close();
  }
});
test("resolve waits beyond FID and date text for delayed current-account widgets", async () => {
  const f = await fixture("delayed");
  try {
    const r = await f.api.resolveForum!(account, "111", "测试");
    assert.equal(r.signed, false);
    assert.equal(r.canSign, true);
    assert.equal(r.level, 4);
    assert.equal(r.experience, 35);
  } finally {
    await f.close();
  }
});
test("only explicit labelled personal zeroes become zero; a non-personal column stays unavailable", async () => {
  for (const mode of ["zero", "wrong-header"] as const) {
    const f = await fixture(mode);
    try {
      const r = await f.api.readForum(account, "111", forum);
      assert.equal(r.followed, true);
      assert.equal(r.experience, mode === "zero" ? 0 : null);
      assert.equal(r.level, mode === "zero" ? 0 : null);
    } finally {
      await f.close();
    }
  }
});
test("a known signed widget can expose its signed label in title with date-only text", async () => {
  const f = await fixture("signed-title");
  try {
    const r = await f.api.readForum(account, "111", forum);
    assert.equal(r.signed, true);
    assert.equal(r.canSign, false);
    assert.equal(f.counts.posts, 0);
  } finally {
    await f.close();
  }
});
test("contradictory personal values from the list and current bar stay unresolved", async () => {
  const f = await fixture("conflict");
  try {
    const r = await f.api.readForum(account, "111", forum);
    assert.equal(r.followed, true);
    assert.equal(r.level, null);
    assert.equal(r.experience, null);
    assert.match(r.personalStatsMessage ?? "", /不一致/);
  } finally {
    await f.close();
  }
});
test("complete list pagination proves an existing relation without a mutation checkpoint", async () => {
  const f = await fixture("pagination");
  try {
    const r = await f.api.followForum!(account, "111", forum, async () => {
      throw Error("already followed must not checkpoint");
    });
    assert.equal(r.status, "followed");
    assert.equal(r.reading.followed, true);
    assert.equal(r.reading.experience, 35);
    assert.equal(f.counts.lists, 2);
    assert.equal(f.counts.posts, 0);
  } finally {
    await f.close();
  }
});
test("explicit ordinary follow checkpoints before exactly one click and verifies official list membership", async () => {
  const f = await fixture();
  try {
    const r = await f.api.followForum!(account, "111", forum, async () => {
      f.events.push("checkpoint");
    });
    assert.equal(r.status, "followed");
    assert.equal(r.uid, "111");
    assert.equal(r.reading.followed, true);
    assert.deepEqual([r.reading.level, r.reading.experience], [4, 35]);
    assert.deepEqual(f.events, ["checkpoint", "post"]);
    assert.equal(f.counts.posts, 1);
  } finally {
    await f.close();
  }
});
test("ambiguous, paid, wrong-target and incomplete/foreign lists never reach follow checkpoint", async () => {
  for (const mode of [
    "ambiguous",
    "paid",
    "wrong-fid",
    "missing-list",
    "foreign-list",
  ] as const) {
    const f = await fixture(mode);
    try {
      await assert.rejects(
        f.api.followForum!(account, "111", forum, async () => {
          f.events.push("checkpoint");
        }),
      );
      assert.equal(f.counts.posts, 0);
      assert.equal(f.events.length, 0);
    } finally {
      await f.close();
    }
  }
});
test("UID change after checkpoint prevents follow and retains an uncertain result", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.api.followForum!(account, "111", forum, async () => {
        f.events.push("checkpoint");
        f.uid = "222";
      }),
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "uncertain" in error &&
        error.uncertain === true,
    );
    assert.equal(f.counts.posts, 0);
    assert.deepEqual(f.events, ["checkpoint"]);
  } finally {
    await f.close();
  }
});
test("unconfirmed follow result stays uncertain; a subsequent read never clicks again", async () => {
  const f = await fixture("unknown");
  try {
    const r = await f.api.followForum!(account, "111", forum, async () => {
      f.events.push("checkpoint");
    });
    assert.equal(r.status, "uncertain");
    assert.equal(r.reading.followed, false);
    await f.api.readForum(account, "111", forum);
    assert.equal(f.counts.posts, 1);
    assert.deepEqual(f.events, ["checkpoint", "post"]);
  } finally {
    await f.close();
  }
});
