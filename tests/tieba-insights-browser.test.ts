import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import {
  parseTiebaVisibility,
  tiebaInsightsBrowser,
} from "../core/tieba/insights-browser";
import type { TiebaPublicationRef } from "../shared/tieba-insights";
import type { TiebaParticipationPageSnapshot } from "../core/tieba/participation-page";
import type { WebsiteAccount } from "../shared/website-accounts";
import { tiebaHomeFixture } from "./tieba-autocare-browser-fixture";

const publication: TiebaPublicationRef = {
  id: "tiebareply_visibility",
  kind: "reply",
  accountId: "web_visibility",
  uid: "111",
  forumId: "100",
  forumName: "测试",
  threadId: "1000",
  postId: "10002",
  title: "资料如何整理",
  url: "https://tieba.baidu.com/p/1000?pid=10002#10002",
  body: "按使用场景整理资料，保留原始文件，建立可以持续维护的主题索引。",
  submittedAt: "2026-11-07T02:00:00Z",
  submissionStatus: "verified",
};
const account: WebsiteAccount = {
  id: publication.accountId,
  provider: "tieba",
  alias: "可见性只读测试",
  uid: "111",
  status: "connected",
  createdAt: "",
  updatedAt: "",
};
const post = (pid = "10002", uid = "111", floor = 2) => ({
  data: { author: { user_id: uid }, content: { post_id: pid, post_no: floor } },
  text: publication.body,
  truncated: false,
  authorName: "原作者",
});
function sample(
  patch: Partial<TiebaParticipationPageSnapshot> = {},
): TiebaParticipationPageSnapshot {
  return {
    url: publication.url!,
    viewer: { user_id: "111", is_login: 1 },
    forum: { id: "100", name: "测试" },
    thread: { thread_id: "1000" },
    title: publication.title,
    challenge: false,
    statusText: "",
    login: false,
    listRecognized: false,
    listEmpty: false,
    rows: [],
    posts: [post()],
    activePage: "",
    lastHref: null,
    locked: false,
    editorCount: 0,
    editorText: "",
    editorDisabled: false,
    submitCount: 0,
    submitText: "",
    submitDisabled: false,
    submitHref: null,
    ...patch,
  };
}
test("贴吧可见性只认准确作者/主题/楼层/正文，不把空白与缺失当删除", () => {
  assert.equal(
    parseTiebaVisibility(sample(), "111", publication).visibility,
    "visible",
  );
  for (const snapshot of [
    sample({ posts: [] }),
    sample({ posts: [post("10003")] }),
    sample({ posts: [post("10002", "222")] }),
    sample({ posts: [{ ...post(), text: "其他正文" }] }),
    sample({ posts: [post(), post()] }),
  ])
    assert.equal(
      parseTiebaVisibility(snapshot, "111", publication).visibility,
      "unknown",
    );
  assert.equal(
    parseTiebaVisibility(
      sample({
        posts: [{ ...post(), text: "\n" + publication.body + "  \n" }],
      }),
      "111",
      publication,
    ).visibility,
    "visible",
  );
});
test("贴吧主题可见性要求完整首帖作者与标题，审核只认准确主题的官网提示", () => {
  const topic = { ...publication, kind: "topic" as const, postId: "10001" };
  assert.equal(
    parseTiebaVisibility(
      sample({ posts: [post("10001", "111", 1)] }),
      "111",
      topic,
    ).visibility,
    "visible",
  );
  assert.equal(
    parseTiebaVisibility(
      sample({ posts: [post("10001", "111", 1)], title: "其他标题" }),
      "111",
      topic,
    ).visibility,
    "unknown",
  );
  assert.equal(
    parseTiebaVisibility(
      sample({
        posts: [],
        thread: { thread_id: "1000", author_id: "111" },
        statusText: "该帖子正在审核中",
      }),
      "111",
      topic,
    ).visibility,
    "pending_review",
  );
  assert.equal(
    parseTiebaVisibility(
      sample({ posts: [], statusText: "该帖子正在审核中" }),
      "111",
      topic,
    ).visibility,
    "unknown",
  );
  assert.equal(
    parseTiebaVisibility(
      sample({
        posts: [],
        thread: { thread_id: "1000", author_id: "111" },
        statusText: "该帖子正在审核中",
      }),
      "111",
      publication,
    ).visibility,
    "unknown",
  );
  assert.equal(
    parseTiebaVisibility(
      sample({ posts: [], statusText: "文章说明如何理解帖子审核中这句话" }),
      "111",
      topic,
    ).visibility,
    "unknown",
  );
});
test("贴吧可见性拒绝换号、验证、跨站及其他主题，缺少原主题ID不访问", () => {
  for (const snapshot of [
    sample({ viewer: { user_id: "222", is_login: 1 } }),
    sample({ challenge: true }),
    sample({ url: "https://example.com/p/1000" }),
    sample({ thread: { thread_id: "2000" } }),
  ])
    assert.throws(() => parseTiebaVisibility(snapshot, "111", publication));
  let environments = 0;
  const api = tiebaInsightsBrowser(async () => {
    environments++;
    throw Error("不应开环境");
  });
  assert.throws(() =>
    api.readVisibility(account, "111", {
      ...publication,
      threadId: null,
      url: null,
    }),
  );
  assert.equal(environments, 0);
});

let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
});
after(async () => {
  await browser?.close();
});
const pageHtml = (tail = false) =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.PageData={user:{user_id:'111',is_login:1},forum:{id:'100',name:'测试'},thread:{thread_id:'1000'}};</script><div id="pb_content"><h3 class="core_title_txt">资料如何整理</h3><div id="j_p_postlist">${tail ? `<div class="l_post" data-field='${JSON.stringify(post().data)}'><div class="d_post_content">${publication.body}</div></div>` : ""}</div><div class="l_posts_num"><a href="/p/1000?pn=2">尾页</a></div></div></body></html>`;
test("贴吧可见性浏览器只读尾页准确核实，不点击或提交，临时页清理", async () => {
  const context = await browser.newContext();
  const visits: string[] = [];
  try {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!route.request().isNavigationRequest()) {
        await route.abort();
        return;
      }
      visits.push(url.pathname + url.search);
      await route.fulfill({
        contentType: "text/html",
        body:
          url.pathname === "/"
            ? tiebaHomeFixture("111")
            : pageHtml(url.searchParams.get("pn") === "2"),
      });
    });
    const api = tiebaInsightsBrowser(
      async (_account, action) => action(context),
      { pageTimeoutMs: 100 },
    );
    const result = await api.readVisibility(account, "111", publication);
    assert.equal(result.visibility, "visible");
    assert.ok(visits.includes("/p/1000?pn=2"));
    assert.equal(context.pages().length, 0);
  } finally {
    await context.close();
  }
});
test("贴吧可见性浏览器遇404保留不可访问状态，重定向不伪造删除，保留原页面", async () => {
  const context = await browser.newContext();
  const original = await context.newPage();
  let redirect = false;
  try {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        await route.fulfill({
          contentType: "text/html",
          body: tiebaHomeFixture("111"),
        });
        return;
      }
      if (redirect)
        await route.fulfill({
          status: 302,
          headers: { location: "https://example.com/verification" },
        });
      else
        await route.fulfill({
          status: 404,
          contentType: "text/html",
          body: "暂不可访问",
        });
    });
    const api = tiebaInsightsBrowser(
      async (_account, action) => action(context),
      { pageTimeoutMs: 100 },
    );
    assert.equal(
      (await api.readVisibility(account, "111", publication)).visibility,
      "unavailable",
    );
    redirect = true;
    await assert.rejects(api.readVisibility(account, "111", publication), {
      code: "TIEBA_PAGE_REDIRECT",
    });
    assert.equal(original.isClosed(), false);
    assert.equal(context.pages().length, 1);
  } finally {
    await context.close();
  }
});
