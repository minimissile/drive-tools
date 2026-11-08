import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import type { WebsiteAccount } from "../shared/website-accounts";
import { tiebaAutocareBrowser } from "../core/tieba/autocare-browser";
import {
  assertTiebaPage,
  parseTiebaFollowedPage,
  parseTiebaForum,
  tiebaAutocarePageScript,
  tiebaForumNameFromUrl,
  tiebaForumUrl,
  tiebaMetric,
  type TiebaAutocarePageSnapshot,
} from "../core/tieba/autocare-page";
import {
  tiebaHomeFixture,
  tiebaFollowedFixture,
  tiebaForumFixture,
  type TiebaFixtureMode,
} from "./tieba-autocare-browser-fixture";

const account: WebsiteAccount = {
  id: "web_tieba_fixture",
  provider: "tieba",
  alias: "专用测试",
  uid: "111",
  status: "connected",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
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
  checkedAt: "2026-11-07T00:00:00.000Z",
};
const emptySnapshot = (
  values: Partial<TiebaAutocarePageSnapshot> = {},
): TiebaAutocarePageSnapshot => ({
  url: forum.url,
  viewer: { user_id: "111", is_login: 1 },
  forum: { id: "100", name: "测试" },
  heading: "测试吧",
  challenge: false,
  login: false,
  statusText: "",
  signText: "",
  signButtons: 0,
  signButtonText: "",
  signButtonHref: null,
  signDisabled: false,
  signed: false,
  levelText: "",
  experienceText: "",
  listRecognized: false,
  listEmpty: false,
  links: [],
  nextHref: null,
  ...values,
});

test("forum URLs accept only exact official HTTPS pages and keep names bounded", () => {
  assert.equal(tiebaForumNameFromUrl("/f?kw=C%2B%2B&ie=utf-8"), "C++");
  for (const url of [
    "http://tieba.baidu.com/f?kw=测试",
    "https://tieba.baidu.com:8443/f?kw=测试",
    "https://x@tieba.baidu.com/f?kw=测试",
    "https://tieba.baidu.com.evil.invalid/f?kw=测试",
    "/p/100",
    "javascript:alert(1)",
  ])
    assert.equal(tiebaForumNameFromUrl(url), null);
  assert.throws(() => tiebaForumUrl("\n"), { code: "TIEBA_FORUM_INVALID" });
});

test("metrics preserve unknown values and parse earned experience rather than capacity", () => {
  assert.equal(tiebaMetric("Lv.4", "level"), 4);
  assert.equal(tiebaMetric("35 / 50", "experience"), 35);
  assert.equal(tiebaMetric("经验值：1,200", "experience"), 1200);
  for (const value of [
    "",
    "未知",
    undefined,
    {},
    Number.NaN,
    -1,
    "约1万",
    "35积分50经验",
  ])
    assert.equal(tiebaMetric(value, "experience"), null);
  const parsed = parseTiebaForum(emptySnapshot(), "111", forum);
  assert.equal(parsed.level, null);
  assert.equal(parsed.experience, null);
  assert.equal(parsed.signed, null);
  assert.equal(parsed.canSign, null);
});

test("target mismatch, unsafe IDs, account changes, verification and frequency errors fail closed", () => {
  for (const patch of [
    { forum: { id: "999", name: "测试" } },
    { forum: { id: Number.MAX_SAFE_INTEGER + 1, name: "测试" } },
    { forum: { id: "100", name: "其他" } },
    { url: "https://passport.baidu.com/" },
    { viewer: { user_id: "222" } },
    { viewer: { user_id: "111", is_login: 0 } },
    { challenge: true },
    { statusText: "操作过于频繁" },
  ])
    assert.throws(() => parseTiebaForum(emptySnapshot(patch), "111", forum));
  assert.throws(() => assertTiebaPage(emptySnapshot({ login: true }), "111"), {
    code: "TIEBA_LOGIN_REQUIRED",
  });
});

test("a recognized empty followed list differs from loading, pagination loops and profile pages", () => {
  const own = emptySnapshot({
    url: "https://tieba.baidu.com/i/i/forum?pn=1",
    listRecognized: true,
    listEmpty: true,
  });
  assert.deepEqual(parseTiebaFollowedPage(own, "111"), {
    names: [],
    next: null,
  });
  for (const patch of [
    { listEmpty: false },
    { listRecognized: false },
    { url: "https://tieba.baidu.com/i/i/forum?uid=222" },
    { nextHref: "http://tieba.baidu.com/i/i/forum?pn=2" },
    { nextHref: "https://tieba.baidu.com/i/i/forum?pn=2&un=other" },
    { nextHref: "/i/i/forum?pn=NaN" },
  ])
    assert.throws(() => parseTiebaFollowedPage({ ...own, ...patch }, "111"));
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

/** Dedicated offline browser context: only fixture business documents are fulfilled. */
async function fixture(mode: TiebaFixtureMode = "success", uid = "111") {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const events: string[] = [];
  await context.route("https://tieba.baidu.com/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === "POST") {
      assert.equal(url.pathname, "/sign/add");
      events.push("submitted");
      await route.fulfill({
        contentType: "application/json",
        body: '{"ok":true}',
      });
      return;
    }
    const body =
      url.pathname === "/"
        ? tiebaHomeFixture(uid)
        : url.pathname === "/i/i/forum"
          ? tiebaFollowedFixture(url.searchParams.get("pn") === "2")
          : url.pathname === "/f"
            ? tiebaForumFixture(url.searchParams.get("kw") ?? "测试", mode)
            : "<!doctype html><html><body>未知测试页面</body></html>";
    await route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  const api = tiebaAutocareBrowser(
    <T>(
      _account: WebsiteAccount,
      action: (value: BrowserContext) => Promise<T>,
    ) => action(context),
    { resultTimeoutMs: 250, pageTimeoutMs: 250 },
  );
  return { context, events, api };
}

test("followed forums resolve real IDs, deduplicate names and close disposable pages", async () => {
  const f = await fixture();
  try {
    const result = await f.api.listForums(account, "111");
    assert.deepEqual(
      result.map(({ forumId, name }) => ({ forumId, name })),
      [
        { forumId: "100", name: "测试" },
        { forumId: "200", name: "第二个" },
      ],
    );
    assert.equal(result[0].level, 4);
    assert.equal(result[0].experience, 35);
    assert.equal(result[0].signed, false);
    assert.equal(f.events.length, 0);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});

test("live PC header-only followed table is empty only after loading completes and without data rows", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route("https://tieba.baidu.com/**", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body><script>window.PageData={user:{user_id:'111',is_login:1}};</script><div id="like_pagelet"><div class="forum_table"><table><tbody><tr><th>吧名</th><th>经验值</th><th>等级</th><th>取消关注</th></tr></tbody></table></div></div></body></html>`,
    }));
    await page.goto("https://tieba.baidu.com/i/i/forum?pn=1");
    const read = () => page.evaluate<TiebaAutocarePageSnapshot>(tiebaAutocarePageScript);
    assert.deepEqual(parseTiebaFollowedPage(await read(), "111"), { names: [], next: null });
    await page.evaluate(() => document.querySelector(".forum_table")!.setAttribute("aria-busy", "true"));
    assert.equal((await read()).listEmpty, false);
    await page.evaluate(() => {
      document.querySelector(".forum_table")!.removeAttribute("aria-busy");
      document.querySelector("table")!.insertRow().insertCell().textContent = "尚在加载的记录";
    });
    assert.equal((await read()).listEmpty, false);
  } finally { await context.close(); }
});

test("check-in saves the checkpoint before exactly one mutation and requires visible signed evidence", async () => {
  const f = await fixture();
  try {
    const result = await f.api.checkIn(account, "111", forum, async () => {
      f.events.push("checkpoint");
    });
    assert.deepEqual(f.events, ["checkpoint", "submitted"]);
    assert.equal(result.signed, true);
    assert.equal(result.canSign, false);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});

test("already signed is read-only and never consumes a submit checkpoint", async () => {
  const f = await fixture("signed");
  try {
    const result = await f.api.checkIn(account, "111", forum, async () => {
      throw Error("should not be called");
    });
    assert.equal(result.signed, true);
    assert.equal(f.events.length, 0);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});

test("unknown, paid or ambiguous controls cannot submit", async () => {
  for (const mode of ["missing", "paid", "ambiguous"] as const) {
    const f = await fixture(mode);
    try {
      await assert.rejects(
        f.api.checkIn(account, "111", forum, async () => {
          f.events.push("checkpoint");
        }),
        { code: "TIEBA_SIGN_UNAVAILABLE" },
      );
      assert.deepEqual(f.events, []);
      assert.equal(f.context.pages().length, 0);
    } finally {
      await f.context.close();
    }
  }
});

test("expired scope or changed account prevents the click", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.api.checkIn(account, "111", forum, async () => {
        throw Error("本轮已关闭");
      }),
      /本轮已关闭/,
    );
    assert.deepEqual(f.events, []);
    await assert.rejects(
      f.api.checkIn(account, "111", forum, async () => {
        const page = f.context
          .pages()
          .find((page) => new URL(page.url()).pathname === "/f");
        assert.ok(page);
        await page.evaluate("window.PageData.user.user_id='222'");
      }),
      { code: "TIEBA_IDENTITY_MISMATCH", uncertain: true },
    );
    assert.deepEqual(f.events, []);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});

test("a lost receipt or challenge after submit is uncertain and never clicks again", async () => {
  for (const mode of ["unknown", "challenge"] as const) {
    const f = await fixture(mode);
    try {
      await assert.rejects(
        f.api.checkIn(account, "111", forum, async () => {
          f.events.push("checkpoint");
        }),
        { uncertain: true },
      );
      assert.deepEqual(f.events, ["checkpoint", "submitted"]);
      assert.equal(f.context.pages().length, 0);
    } finally {
      await f.context.close();
    }
  }
});

test("identity mismatch is rejected before any business page mutation", async () => {
  const f = await fixture("success", "222");
  try {
    await assert.rejects(
      f.api.checkIn(account, "111", forum, async () => {
        f.events.push("checkpoint");
      }),
      { code: "TIEBA_IDENTITY_MISMATCH" },
    );
    assert.deepEqual(f.events, []);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.context.close();
  }
});

test("asynchronous sign widgets are read after hydration", async () => {
  const f = await fixture("missing");
  try {
    await f.context.route("https://tieba.baidu.com/f?**", async (route) => {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `${tiebaForumFixture("测试", "missing")}<script>setTimeout(()=>{document.querySelector('#signstar_wrapper').innerHTML='<a class="j_signbtn j_cansign" href="javascript:;">签到</a>';},40);</script>`,
      });
    });
    const result = await f.api.readForum(account, "111", forum);
    assert.equal(result.signed, false);
    assert.equal(result.canSign, true);
    assert.deepEqual(f.events, []);
  } finally {
    await f.context.close();
  }
});

test("cross-origin and HTTP redirects are stopped within the disposable page", async () => {
  for (const target of [
    "http://tieba.baidu.com/f?kw=测试",
    "https://passport.baidu.com/fixture-login",
  ]) {
    const f = await fixture();
    try {
      await f.context.route("https://tieba.baidu.com/f?**", async (route) => {
        await route.fulfill({ status: 302, headers: { location: target } });
      });
      await assert.rejects(f.api.readForum(account, "111", forum), {
        code: "TIEBA_PAGE_REDIRECT",
      });
      assert.deepEqual(f.events, []);
      assert.equal(f.context.pages().length, 0);
    } finally {
      await f.context.close();
    }
  }
});

test("status words inside post content do not become signed or verification evidence", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent(
      `${tiebaForumFixture("测试", "missing")}<article>已签到 连续30天 操作太频繁 验证码</article>`,
    );
    const result = await page.evaluate<TiebaAutocarePageSnapshot>(
      tiebaAutocarePageScript,
    );
    assert.equal(result.signed, false);
    assert.equal(result.challenge, false);
    assert.equal(result.statusText, "");
  } finally {
    await context.close();
  }
});
