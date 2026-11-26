import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { parseTiebaLike, tiebaLikeBrowser } from "../core/tieba/like-browser";
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
const post = (liked = 0, author = 222) => ({
  error_code: 0,
  user: { id: 111, is_login: 1 },
  forum: { id: 101 },
  thread: {
    id: 901,
    title: "学习心得",
    author: { id: author },
    agree: { has_agree: liked },
  },
});
const account = {
  provider: "tieba",
  uid: "111",
  id: "web_fixture",
} as WebsiteAccount;
const forum = {
  forumId: "101",
  name: "资料",
  url: "https://tieba.baidu.com/f?kw=资料",
  level: 1,
  experience: 1,
  signed: false,
  canSign: true,
  message: null,
  checkedAt: new Date().toISOString(),
};

test("点赞解析只接收官网当前UID、原帖、作者及明确的已赞状态", () => {
  assert.equal(parseTiebaLike(post(), "111", "101", "901").liked, false);
  assert.equal(parseTiebaLike(post(1), "111", "101", "901").liked, true);
  for (const value of [
    { ...post(), error_code: 1 },
    { ...post(), user: { id: 333, is_login: 1 } },
    { ...post(), forum: { id: 102 } },
    { ...post(), thread: { ...post().thread, id: 902 } },
    { ...post(), thread: { ...post().thread, agree: {} } },
  ])
    assert.throws(() => parseTiebaLike(value, "111", "101", "901"));
});

test("普通点赞单击前保存原帖；重新读取同一帖子核实；不占用用户已有页面", async () => {
  const context = await browser.newContext();
  const userPage = await context.newPage();
  let liked = 0,
    writes = 0,
    checkpoints = 0,
    author = 222,
    duplicate = false;
  try {
    await context.route("https://tieba.baidu.com/**", async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/c/f/pb/page_pc")
        return route.fulfill({ json: post(liked, author) });
      if (u.pathname === "/agree/fixture") {
        assert.equal(checkpoints, 1);
        writes++;
        liked = 1;
        return route.fulfill({ json: { error_code: 0 } });
      }
      if (u.pathname === "/f/user/json_userinfo")
        return route.fulfill({
          json: {
            no: 0,
            data: { user_id: 111, is_login: true, user_name_show: "本人" },
          },
        });
      const icon =
        '<div class="action-item"><svg><use href="#agree_pb"></use></svg>点赞</div>';
      const body = u.pathname.startsWith("/p/")
        ? `${icon}${duplicate ? icon : ""}<script>fetch('/c/f/pb/page_pc');document.querySelector('.action-item').onclick=()=>fetch('/agree/fixture',{method:'POST'})</script>`
        : u.pathname === "/f"
          ? '<a href="/p/901">学习心得</a>'
          : '<script>window.PageData={user:{user_id:111,is_login:true,user_name_show:"本人"}}</script>';
      return route.fulfill({ contentType: "text/html; charset=utf-8", body });
    });
    const api = tiebaLikeBrowser(async (_a, action) => action(context));
    const result = await api.likePost!(
      account,
      "111",
      forum,
      ["111"],
      [],
      async (reading) => {
        assert.equal(reading.threadId, "901");
        assert.equal(reading.authorUid, "222");
        assert.equal(writes, 0);
        checkpoints++;
      },
    );
    assert.equal(result?.liked, true);
    assert.equal(writes, 1);
    assert.equal(checkpoints, 1);
    assert.deepEqual(context.pages(), [userPage]);
    // Already liked, own/managed authors and previously submitted threads do not click.
    for (const scenario of ["liked", "own", "managed", "submitted"]) {
      liked = scenario === "liked" ? 1 : 0;
      author = scenario === "own" ? 111 : scenario === "managed" ? 333 : 222;
      assert.equal(
        await api.likePost!(
          account,
          "111",
          forum,
          ["111", "333"],
          scenario === "submitted" ? ["901"] : [],
          async () => {
            assert.fail("不应提交");
          },
        ),
        null,
      );
    }
    assert.equal(writes, 1);
    author = 222;
    liked = 0;
    duplicate = true;
    await assert.rejects(
      () =>
        api.likePost!(account, "111", forum, [], [], async () => {
          assert.fail("控件不唯一时不应提交");
        }),
      { code: "TIEBA_LIKE_CONTROL" },
    );
    duplicate = false;
    const original = await api.readLike!(account, "111", forum, "901");
    assert.equal(original.threadId, "901");
    assert.equal(writes, 1);
    assert.deepEqual(context.pages(), [userPage]);
  } finally {
    await context.close();
  }
});
