import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { tiebaPostStatsBrowser } from "../core/tieba/post-stats-browser";
import { participationPostFixture } from "./tieba-participation-browser-fixture";
import { tiebaHomeFixture } from "./tieba-autocare-browser-fixture";
import type { WebsiteAccount } from "../shared/website-accounts";

let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    executablePath:
      process.env.PANXU_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
});
after(async () => {
  await browser?.close();
});
const account: WebsiteAccount = {
  id: "web_stats",
  provider: "tieba",
  uid: "111",
  alias: "统计测试",
  status: "connected",
  createdAt: "",
  updatedAt: "",
};
type Mode =
  | "empty"
  | "success"
  | "foreign"
  | "bodyless"
  | "no-link"
  | "folded"
  | "unknown-counts"
  | "conflict-replies"
  | "wrong-list-owner"
  | "missing-list"
  | "wrong-next";
async function fixture(mode: Mode) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const initial = await context.newPage();
  await initial.setContent("原有标签");
  const posts = (body: string) =>
    participationPostFixture(
      "10001",
      mode === "foreign" ? "222" : "111",
      1,
      body,
    );
  const baseBody =
    "本人整理的办公资料目录，包含常用表格和学习笔记，资源地址 https://pan.baidu.com/s/1abc?pwd=1234";
  await context.route("https://tieba.baidu.com/**", async (route) => {
    if (route.request().method() !== "GET")
      throw new Error("统计不应发起远端写入");
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        body: tiebaHomeFixture("111"),
      });
      return;
    }
    if (url.pathname === "/i/i/my_tie") {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{id:'111',is_login:1},itieba:{creator:{id:'${mode === "wrong-list-owner" ? "222" : "111"}',user_id:'111'},ithreads_num:${mode === "empty" ? 0 : 1}}};</script><div id="content">${mode === "missing-list" ? "" : `<div class="simple_block_container"><ul>${mode === "empty" ? "" : '<li><a href="/p/1000">办公资料</a></li>'}</ul></div>`}<div class="j_pager">${mode === "empty" ? "" : `<a href="${mode === "wrong-next" ? "/i/i/my_tie?pn=2&un=other" : "/i/i/my_tie?pn=2"}">下一页</a>`}</div></div>`,
      });
      return;
    }
    const body =
      mode === "no-link"
        ? "首帖是普通办公文字，没有网盘分享链接。标题和他人回复中的链接不属于首帖。"
        : baseBody;
    let first = mode === "bodyless" ? "" : posts(body);
    if (mode === "folded")
      first = first.replace(
        'class="l_post"',
        'class="l_post" data-truncated="true"',
      );
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{id:'111',is_login:1},forum:{id:'100',name:'办公技巧'},thread:{thread_id:'1000',reply_num:5${mode === "unknown-counts" ? "" : ",view_num:120,agree_num:3"}}};</script><h3 class="core_title_txt">办公资料 https://pan.quark.cn/s/title</h3><div id="pb_content"><div id="j_p_postlist">${first}${participationPostFixture("10002", "222", 2, "回复有他人的链接 https://pan.quark.cn/s/reply")}</div></div><div id="thread_theme_5"><li class="l_reply_num">4回复贴，共1页</li></div><div id="thread_theme_7"><li class="l_reply_num">${mode === "conflict-replies" ? 6 : 4}回复贴，共1页</li></div>`,
    });
  });
  const api = tiebaPostStatsBrowser(
    async (_account, action) => action(context),
    { pageTimeoutMs: 120 },
  );
  return {
    api,
    context,
    initial,
    async close() {
      assert.equal(initial.isClosed(), false);
      assert.equal(context.pages().length, 1);
      await context.close();
    },
  };
}
test("真实空列表结构须当前UID和明确ithreads_num=0，不把缺失容器当空", async () => {
  for (const mode of ["empty", "wrong-list-owner", "missing-list"] as const) {
    const f = await fixture(mode);
    try {
      if (mode === "empty")
        assert.deepEqual(await f.api.listOwnThreads(account, "111", 1), {
          threadIds: [],
          nextPage: null,
        });
      else
        await assert.rejects(
          f.api.listOwnThreads(account, "111", 1),
          /无法核实|未完整显示/,
        );
    } finally {
      await f.close();
    }
  }
});
test("本人列表保留准确主题ID和下一页，其他账号/附加身份参数不能翻页", async () => {
  for (const mode of ["success", "wrong-next"] as const) {
    const f = await fixture(mode);
    try {
      if (mode === "success")
        assert.deepEqual(await f.api.listOwnThreads(account, "111", 1), {
          threadIds: ["1000"],
          nextPage: 2,
        });
      else
        await assert.rejects(f.api.listOwnThreads(account, "111", 1), /下一页/);
    } finally {
      await f.close();
    }
  }
});
test("仅本人首帖正文网盘链接计入；PageData.reply_num不当作回复贴数", async () => {
  const f = await fixture("success");
  try {
    const result = await f.api.readThread(account, "111", "1000");
    assert.deepEqual(result.links, ["https://pan.baidu.com/s/1abc"]);
    assert.equal(result.views, 120);
    assert.equal(result.replies, 4);
    assert.equal(result.likes, 3);
  } finally {
    await f.close();
  }
});
test("标题和楼层链接不扩大范围，官网缺失读数或矛盾回复数保持null", async () => {
  for (const mode of [
    "no-link",
    "unknown-counts",
    "conflict-replies",
  ] as const) {
    const f = await fixture(mode);
    try {
      const result = await f.api.readThread(account, "111", "1000");
      if (mode === "no-link") assert.deepEqual(result.links, []);
      if (mode === "unknown-counts") {
        assert.equal(result.views, null);
        assert.equal(result.likes, null);
        assert.equal(result.replies, 4);
      }
      if (mode === "conflict-replies") assert.equal(result.replies, null);
    } finally {
      await f.close();
    }
  }
});
test("非本人、缺失首帖或折叠正文不能纳入本人资源帖", async () => {
  for (const mode of ["foreign", "bodyless", "folded"] as const) {
    const f = await fixture(mode);
    try {
      await assert.rejects(
        f.api.readThread(account, "111", "1000"),
        /当前账号|正文|完整/,
      );
    } finally {
      await f.close();
    }
  }
});
