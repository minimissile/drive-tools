import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import type { WebsiteAccount } from "../shared/website-accounts";
import type { TiebaThreadCandidate } from "../shared/tieba-participation";
import { tiebaParticipationBrowser } from "../core/tieba/participation-browser";
import {
  assertTiebaParticipationPage,
  findTiebaReplyReceipt,
  parseTiebaThreadContext,
  parseTiebaThreadList,
  tiebaSafeThreadPage,
  tiebaThreadIdFromUrl,
  tiebaThreadUrl,
  type TiebaParticipationPageSnapshot,
} from "../core/tieba/participation-page";
import { tiebaHomeFixture } from "./tieba-autocare-browser-fixture";
import {
  contentDeclarationFixture,
  type DeclarationFixtureMode,
} from "./tieba-content-declaration-fixture";
import {
  fixtureReplyBody,
  fixtureThreadBody,
  participationForumFixture,
  participationPostFixture,
  participationThreadFixture,
  type TiebaParticipationFixtureMode,
} from "./tieba-participation-browser-fixture";

const account: WebsiteAccount = {
  id: "web_reply_fixture",
  provider: "tieba",
  alias: "回复专用测试",
  uid: "111",
  status: "connected",
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
};
const forum = {
  forumId: "100",
  name: "测试",
  url: "https://tieba.baidu.com/f?kw=测试",
  level: null,
  experience: null,
  signed: null,
  canSign: null,
  message: null,
  checkedAt: "2026-11-07T00:00:00Z",
};
const candidate: TiebaThreadCandidate = {
  threadId: "1000",
  forumId: "100",
  forumName: "测试",
  title: "如何整理本地开发任务",
  url: tiebaThreadUrl("1000"),
  authorUid: "333",
  replyCount: 2,
  lastActiveAt: null,
  discoveredAt: "2026-11-07T00:00:00Z",
};
const postData = (postId: string, authorUid = "333", floor = 1) => ({
  author: { user_id: authorUid },
  content: { post_id: postId, post_no: floor },
});
function sample(
  patch: Partial<TiebaParticipationPageSnapshot> = {},
): TiebaParticipationPageSnapshot {
  return {
    url: candidate.url,
    viewer: { user_id: "111", is_login: 1 },
    forum: { id: "100", name: "测试" },
    thread: { thread_id: "1000" },
    title: candidate.title,
    challenge: false,
    statusText: "",
    login: false,
    listRecognized: false,
    listEmpty: false,
    rows: [],
    posts: [
      {
        data: postData("10001"),
        text: fixtureThreadBody,
        truncated: false,
        authorName: "作者333",
      },
    ],
    activePage: "",
    lastHref: null,
    locked: false,
    editorCount: 1,
    editorText: "",
    editorDisabled: false,
    submitCount: 1,
    submitText: "发表",
    submitDisabled: false,
    submitHref: "javascript:;",
    ...patch,
  };
}
test("贴吧帖子URL仅接受官方HTTPS准确ID，回执分页不得切换作者或帖子", () => {
  assert.equal(tiebaThreadIdFromUrl("/p/1000?pn=2"), "1000");
  for (const url of [
    "http://tieba.baidu.com/p/1000",
    "https://user@tieba.baidu.com/p/1000",
    "https://tieba.baidu.com.evil.invalid/p/1000",
    "/p/0",
    "/p/1000/delete",
  ])
    assert.equal(tiebaThreadIdFromUrl(url), null);
  assert.equal(
    tiebaSafeThreadPage("/p/1000?pn=2&see_lz=1", "1000"),
    "https://tieba.baidu.com/p/1000?pn=2",
  );
  assert.equal(tiebaSafeThreadPage("/p/2000?pn=2", "1000"), null);
  assert.equal(tiebaSafeThreadPage("/p/1000?pn=bad", "1000"), null);
  assert.equal(tiebaSafeThreadPage("/p/1000?uid=222", "1000"), null);
});
test("贴吧上下文身份、吧与主题ID必须匹配，缺失首帖或非文字上下文保留不完整", () => {
  assert.equal(
    parseTiebaThreadContext(sample(), "111", candidate).truncated,
    false,
  );
  for (const patch of [
    { viewer: null },
    { viewer: { user_id: "222" } },
    { forum: { id: "200", name: "测试" } },
    { thread: { thread_id: "2000" } },
    { challenge: true },
    { statusText: "操作过于频繁" },
  ])
    assert.throws(() =>
      parseTiebaThreadContext(sample(patch), "111", candidate),
    );
  assert.equal(
    parseTiebaThreadContext(sample({ posts: [] }), "111", candidate).truncated,
    true,
  );
  assert.equal(
    parseTiebaThreadContext(
      sample({
        posts: [
          {
            data: postData("10001"),
            text: "图片信息无法由正文替代",
            truncated: true,
            authorName: "",
          },
        ],
      }),
      "111",
      candidate,
    ).truncated,
    true,
  );
  assert.equal(
    parseTiebaThreadContext(sample({ editorCount: 0 }), "111", candidate)
      .canReply,
    null,
  );
});
test("贴吧列表仅提取真实ID，不选择本人、置顶、锁定或重复帖子", () => {
  const row = (id: string, author: string, top = false) => ({
    data: { id, author_id: author, is_top: top },
    href: `/p/${id}`,
    title: "目标主题",
    closed: false,
  });
  const result = parseTiebaThreadList(
    sample({
      url: "https://tieba.baidu.com/f?kw=测试",
      listRecognized: true,
      rows: [
        row("1000", "333"),
        row("1000", "333"),
        row("2000", "111"),
        row("3000", "444", true),
        { ...row("4000", "444"), closed: true },
        { ...row("5000", "444"), href: "/p/6000" },
      ],
    }),
    "111",
    forum,
  );
  assert.deepEqual(
    result.map((row) => row.threadId),
    ["1000"],
  );
});
test("贴吧官网作者控件提供数值UID，冲突或多个作者控件不选为候选", () => {
  const row = (id: string, author: string) => ({
    data: { id },
    author: { user_id: author },
    href: `/p/${id}`,
    title: "目标主题",
    closed: false,
  });
  const result = parseTiebaThreadList(
    sample({
      url: "https://tieba.baidu.com/f?kw=测试",
      listRecognized: true,
      rows: [
        row("1000", "333"),
        row("2000", "111"),
        { ...row("3000", "333"), data: { id: "3000", author_id: "444" } },
        { ...row("4000", "333"), ambiguousAuthor: true },
      ],
    }),
    "111",
    forum,
  );
  assert.deepEqual(
    result.map(({ threadId, authorUid }) => ({ threadId, authorUid })),
    [{ threadId: "1000", authorUid: "333" }],
  );
});
test("贴吧回执必须精确匹配本人、正文、普通楼层和真实pid，歧义保持未知", () => {
  const thread = parseTiebaThreadContext(sample(), "111", candidate);
  const receiptPage = sample({
    posts: [
      {
        data: postData("10009", "111", 9),
        text: fixtureReplyBody,
        truncated: false,
        authorName: "本人",
      },
    ],
  });
  assert.equal(
    findTiebaReplyReceipt(receiptPage, "111", thread, fixtureReplyBody)?.postId,
    "10009",
  );
  assert.equal(
    findTiebaReplyReceipt(receiptPage, "111", thread, "与目标不同的一段正文"),
    null,
  );
  assert.equal(
    findTiebaReplyReceipt(
      { ...receiptPage, posts: [...receiptPage.posts, ...receiptPage.posts] },
      "111",
      thread,
      fixtureReplyBody,
    ),
    null,
  );
  assert.throws(() =>
    assertTiebaParticipationPage(
      sample({ url: "https://passport.baidu.com/" }),
      "111",
    ),
  );
});

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
async function fixture(
  mode: TiebaParticipationFixtureMode = "success",
  uid = "111",
) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const events: string[] = [];
  let active = mode,
    already = false,
    lastAlready = false,
    submitted = false,
    redirect = "";
  let declaration: DeclarationFixtureMode = "absent";
  await context.route("https://tieba.baidu.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      assert.equal(url.pathname, "/reply-fixture");
      events.push("submitted");
      submitted = true;
      await route.fulfill({
        contentType: "application/json",
        body: '{"ok":true}',
      });
      return;
    }
    if (redirect && url.pathname.startsWith("/p/")) {
      await route.fulfill({ status: 302, headers: { location: redirect } });
      return;
    }
    const html =
      url.pathname === "/"
        ? tiebaHomeFixture(uid)
        : url.pathname === "/f"
          ? participationForumFixture()
          : participationThreadFixture(
              active,
              already ||
                (url.searchParams.get("pn") === "2" &&
                  (lastAlready || submitted)),
              url.searchParams.get("pn") === "2",
            ).replace(
              "</body>",
              `${contentDeclarationFixture(declaration)}</body>`,
            );
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: html,
    });
  });
  const api = tiebaParticipationBrowser(
    <T>(
      _account: WebsiteAccount,
      action: (context: BrowserContext) => Promise<T>,
    ) => action(context),
    { pageTimeoutMs: 150, resultTimeoutMs: 150 },
  );
  return {
    context,
    api,
    events,
    set mode(value: TiebaParticipationFixtureMode) {
      active = value;
    },
    set already(value: boolean) {
      already = value;
    },
    set lastAlready(value: boolean) {
      lastAlready = value;
    },
    set redirect(value: string) {
      redirect = value;
    },
    set declaration(value: DeclarationFixtureMode) {
      declaration = value;
    },
  };
}
test("贴吧官网发现和读取保存完整首帖及必要回复，临时页全部关闭", async () => {
  const f = await fixture();
  try {
    const list = await f.api.listThreads(account, "111", forum);
    assert.deepEqual(
      list.map((t) => t.threadId),
      ["1000"],
    );
    assert.equal(list[0].authorUid, "333");
    const result = await f.api.readThread(account, "111", list[0]);
    assert.equal(result.body, fixtureThreadBody);
    assert.equal(result.authorUid, "333");
    assert.equal(result.truncated, false);
    assert.equal(result.canReply, true);
    assert.equal(result.replies.length, 1);
    assert.deepEqual(f.events, []);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});
test("贴吧首帖先于回复编辑器加载时，读取等待真实可回复控件", async () => {
  const f = await fixture("delayed-editor");
  try {
    const result = await f.api.readThread(account, "111", candidate);
    assert.equal(result.canReply, true);
    assert.equal(result.truncated, false);
    assert.equal(result.incompleteReason, null);
    assert.deepEqual(f.events, []);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});
test("贴吧含图片首帖保留已读文字并说明未读媒体，不能冒充完整上下文", async () => {
  const f = await fixture("truncated");
  try {
    const result = await f.api.readThread(account, "111", candidate);
    assert.equal(result.body, fixtureThreadBody);
    assert.equal(result.truncated, true);
    assert.match(result.incompleteReason!, /图片、视频或附件/);
    assert.deepEqual(f.events, []);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});
test("贴吧回复在检查点后只提交一次，并以官网匹配楼层作为成功证据", async () => {
  const f = await fixture();
  try {
    const thread = await f.api.readThread(account, "111", candidate);
    const result = await f.api.reply(
      account,
      "111",
      thread,
      fixtureReplyBody,
      async () => {
        f.events.push("checkpoint");
      },
    );
    assert.deepEqual(f.events, ["checkpoint", "submitted"]);
    assert.equal(result.status, "verified");
    assert.equal(result.postId, "10009");
    assert.equal(result.url, "https://tieba.baidu.com/p/1000?pid=10009#10009");
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});

test("贴吧AI回帖：声明确认在真实检查点前完成，不能确认时不提交", async () => {
  for (const mode of ["selectable", "unconfirmed"] as const) {
    const f = await fixture();
    f.declaration = mode;
    try {
      const thread = await f.api.readThread(account, "111", candidate);
      const action = () =>
        f.api.reply(
          account,
          "111",
          thread,
          fixtureReplyBody,
          async () => {
            const page = f.context
              .pages()
              .find((page) => page.url() === candidate.url)!;
            assert.equal(
              await page.locator(".ai-entrance-text").innerText(),
              "贴子含AI内容",
            );
            f.events.push("checkpoint");
          },
          { aiGenerated: true },
        );
      if (mode === "selectable") {
        assert.equal((await action()).status, "verified");
        assert.deepEqual(f.events, ["checkpoint", "submitted"]);
      } else {
        await assert.rejects(action(), {
          code: "TIEBA_AI_DECLARATION_UNCONFIRMED",
        });
        assert.deepEqual(f.events, []);
      }
    } finally {
      await f.context.close();
    }
  }
});

test("贴吧AI回帖：检查点后声明丢失仍不点击，保留未知边界", async () => {
  const f = await fixture();
  f.declaration = "selectable";
  try {
    const thread = await f.api.readThread(account, "111", candidate);
    await assert.rejects(
      f.api.reply(
        account,
        "111",
        thread,
        fixtureReplyBody,
        async () => {
          f.events.push("checkpoint");
          const page = f.context
            .pages()
            .find((page) => page.url() === candidate.url)!;
          await page.locator(".ai-entrance").evaluate((el) => el.remove());
        },
        { aiGenerated: true },
      ),
      { code: "TIEBA_AI_DECLARATION_UNCONFIRMED", uncertain: true },
    );
    assert.deepEqual(f.events, ["checkpoint"]);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});
test("贴吧缺失/图片首帖、锁帖、多编辑器及旧草稿均不提交", async () => {
  for (const mode of [
    "missing",
    "truncated",
    "locked",
    "ambiguous",
    "occupied",
  ] as const) {
    const f = await fixture(mode);
    try {
      const thread = await f.api.readThread(account, "111", candidate);
      await assert.rejects(
        Promise.resolve().then(() =>
          f.api.reply(account, "111", thread, fixtureReplyBody, async () => {
            f.events.push("checkpoint");
          }),
        ),
      );
      assert.deepEqual(f.events, []);
      assert.equal(f.context.pages().length, 0);
    } finally {
      await f.context.close();
    }
  }
});
test("贴吧提交前原帖改变、身份变化或业务检查点拒绝时不点击", async () => {
  const f = await fixture();
  try {
    const thread = await f.api.readThread(account, "111", candidate);
    f.mode = "changed";
    await assert.rejects(
      f.api.reply(account, "111", thread, fixtureReplyBody, async () => {}),
      { code: "TIEBA_CONTEXT_CHANGED" },
    );
    f.mode = "success";
    await assert.rejects(
      f.api.reply(account, "111", thread, fixtureReplyBody, async () => {
        throw Error("用户已关闭");
      }),
      /用户已关闭/,
    );
    assert.deepEqual(f.events, []);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
  const wrong = await fixture("success", "222");
  try {
    await assert.rejects(wrong.api.readThread(account, "111", candidate), {
      code: "TIEBA_IDENTITY_MISMATCH",
    });
    assert.deepEqual(wrong.events, []);
  } finally {
    await wrong.context.close();
  }
});
test("贴吧已有本人相同回复直接核验，不再次提交或消费提交检查点", async () => {
  const f = await fixture();
  try {
    const thread = await f.api.readThread(account, "111", candidate);
    f.already = true;
    const result = await f.api.reply(
      account,
      "111",
      thread,
      fixtureReplyBody,
      async () => {
        throw Error("不能调用");
      },
    );
    assert.equal(result.status, "verified");
    assert.deepEqual(f.events, []);
  } finally {
    await f.context.close();
  }
});
test("贴吧提交后缺回执或验证码均保留未知，不重发；补核仅查询官网", async () => {
  for (const mode of ["unknown", "challenge"] as const) {
    const f = await fixture(mode);
    try {
      const thread = await f.api.readThread(account, "111", candidate);
      if (mode === "unknown")
        assert.equal(
          (
            await f.api.reply(
              account,
              "111",
              thread,
              fixtureReplyBody,
              async () => {
                f.events.push("checkpoint");
              },
            )
          ).status,
          "uncertain",
        );
      else
        await assert.rejects(
          f.api.reply(account, "111", thread, fixtureReplyBody, async () => {
            f.events.push("checkpoint");
          }),
          (e: unknown) =>
            !!(e && typeof e === "object" && "uncertain" in e && e.uncertain),
        );
      assert.deepEqual(f.events, ["checkpoint", "submitted"]);
      f.mode = "success";
      f.already = true;
      const receipt = await f.api.reconcileReply(
        account,
        "111",
        thread,
        fixtureReplyBody,
        new Date().toISOString(),
      );
      assert.equal(receipt.status, "verified");
      assert.deepEqual(f.events, ["checkpoint", "submitted"]);
      assert.equal(f.context.pages().length, 0);
    } finally {
      await f.context.close();
    }
  }
});
test("贴吧回执可从官网尾页核验，跨站/HTTP重定向被阻断", async () => {
  const f = await fixture("last-page");
  try {
    const thread = await f.api.readThread(account, "111", candidate);
    const receipt = await f.api.reply(
      account,
      "111",
      thread,
      fixtureReplyBody,
      async () => {},
    );
    assert.equal(receipt.status, "verified");
    assert.equal(receipt.postId, "10009");
    assert.deepEqual(f.events, ["submitted"]);
    for (const target of [
      "http://tieba.baidu.com/p/1000",
      "https://passport.baidu.com/",
    ]) {
      f.redirect = target;
      await assert.rejects(f.api.readThread(account, "111", candidate), {
        code: "TIEBA_PAGE_REDIRECT",
      });
    }
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});

test("贴吧官网尾页已有相同本人回复时只读核验，首屏没有也不重复发出", async () => {
  const f = await fixture("last-page");
  try {
    const thread = await f.api.readThread(account, "111", candidate);
    f.lastAlready = true;
    const receipt = await f.api.reply(
      account,
      "111",
      thread,
      fixtureReplyBody,
      async () => {
        throw Error("不应再次请求提交");
      },
    );
    assert.equal(receipt.status, "verified");
    assert.deepEqual(f.events, []);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});

