import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import type { WebsiteAccount } from "../shared/website-accounts";
import { tiebaAutocareBrowser } from "../core/tieba/autocare-browser";
import {
  parseTiebaForum,
  tiebaForumUrl,
  type TiebaAutocarePageSnapshot,
} from "../core/tieba/autocare-page";
import { tiebaHomeFixture } from "./tieba-autocare-browser-fixture";

const account: WebsiteAccount = {
  id: "web_resolve_fixture",
  provider: "tieba",
  alias: "候选吧只读测试",
  uid: "111",
  status: "connected",
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
};
function reading(
  name = "Office技巧",
  urlName = "office技巧",
): TiebaAutocarePageSnapshot {
  return {
    url: tiebaForumUrl(urlName),
    viewer: { user_id: "111", is_login: 1 },
    forum: { id: "100", name },
    heading: `${name}吧`,
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
  };
}

test("候选吧解析仅归一名称空白/NFKC/拉丁大小写，保留官网名称及未知读数", () => {
  const result = parseTiebaForum(reading(), "111", {
    name: "office技巧",
    canonicalName: true,
  });
  assert.equal(result.forumId, "100");
  assert.equal(result.name, "Office技巧");
  assert.equal(result.url, tiebaForumUrl("Office技巧"));
  assert.equal(result.level, null);
  assert.equal(result.experience, null);
  assert.equal(result.signed, null);
  assert.equal(result.canSign, null);
  assert.throws(
    () => parseTiebaForum(reading(), "111", { name: "office技巧" }),
    "原有签到和已关注吧解析默认仍严格匹配名称",
  );
  assert.equal(
    parseTiebaForum(reading("ＡＢＣ  交流", "ABC 交流"), "111", {
      name: "abc 交流",
      canonicalName: true,
    }).name,
    "ＡＢＣ  交流",
  );
});

test("候选吧解析不接受别名跳转、末尾吧字变更、空ID或不一致的网址", () => {
  const cases = [
    reading("Office技巧吧"),
    reading("其他名字"),
    { ...reading(), forum: { id: 0, name: "Office技巧" } },
    reading("Office技巧", "其他名字"),
  ];
  for (const value of cases)
    assert.throws(() =>
      parseTiebaForum(value, "111", {
        name: "office技巧",
        canonicalName: true,
      }),
    );
});

test("候选吧入口在任何环境使用前拒绝URL、控制字符和无效名称", () => {
  let profiles = 0;
  const api = tiebaAutocareBrowser(async () => {
    profiles++;
    throw Error("不应打开环境");
  });
  for (const name of [
    "",
    " ",
    "测试\n吧",
    "测试\u0000吧",
    "https://tieba.baidu.com/f?kw=测试",
    "http://example.invalid/",
    "www.example.invalid",
    "../测试",
    "x".repeat(101),
  ]) {
    assert.throws(() => api.resolveForum!(account, "111", name));
  }
  assert.equal(profiles, 0);
});

describe("候选吧官方只读适配器", () => {
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
    mode:
      | "valid"
      | "unknown"
      | "missing"
      | "wrong-name"
      | "page-uid"
      | "after-uid"
      | "redirect"
      | "cross-site"
      | "http-error" = "valid",
  ) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const requests: { method: string; url: string }[] = [];
    let homes = 0;
    await context.route("https://tieba.baidu.com/**", async (route) => {
      const url = new URL(route.request().url());
      requests.push({ method: route.request().method(), url: url.href });
      if (url.pathname === "/") {
        homes++;
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: tiebaHomeFixture(
            mode === "after-uid" && homes > 1 ? "222" : "111",
          ),
        });
        return;
      }
      if (mode === "redirect" || mode === "cross-site") {
        await route.fulfill({
          status: 302,
          headers: {
            location:
              mode === "redirect"
                ? "http://tieba.baidu.com/f?kw=测试"
                : "https://passport.baidu.com/",
          },
        });
        return;
      }
      if (mode === "http-error") {
        await route.fulfill({ status: 404, body: "该吧不存在" });
        return;
      }
      const name = mode === "wrong-name" ? "另一个贴吧" : "Office技巧";
      const forum = mode === "missing" ? {} : { id: "100", name };
      const html = `<!doctype html><html><meta charset="utf-8"><body><script>window.PageData=${JSON.stringify({ user: { user_id: mode === "page-uid" ? "222" : "111", is_login: 1 }, forum })};</script><a class="card_title_fname">${name}吧</a>${mode === "unknown" ? "" : '<div id="signstar_wrapper"><a href="#" class="j_signbtn j_cansign">关注后签到</a></div>'}</body></html>`;
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: html,
      });
    });
    const api = tiebaAutocareBrowser(
      <T>(
        _account: WebsiteAccount,
        action: (context: BrowserContext) => Promise<T>,
      ) => action(context),
      { pageTimeoutMs: 100 },
    );
    return { context, requests, api };
  }

  test("未关注吧只读解析真实FID，规范输入保留官网大小写且不关注或签到", async () => {
    const f = await fixture();
    try {
      const result = await f.api.resolveForum!(
        account,
        "111",
        "  ｏｆｆｉｃｅ技巧  ",
      );
      assert.equal(result.forumId, "100");
      assert.equal(result.name, "Office技巧");
      assert.equal(result.signed, null);
      assert.equal(result.canSign, null);
      assert.equal(result.level, null);
      assert.equal(result.experience, null);
      const pages = f.requests.filter(
        (row) => new URL(row.url).pathname === "/f",
      );
      assert.equal(pages.length, 1);
      assert.equal(new URL(pages[0].url).searchParams.get("kw"), "office技巧");
      assert.ok(f.requests.every((row) => row.method === "GET"));
      assert.equal(f.context.pages().length, 0);
    } finally {
      await f.context.close();
    }
  });

  test("无签到/等级控件仍能只读解析吧身份，未知字段不补0或未签到", async () => {
    const f = await fixture("unknown");
    try {
      const result = await f.api.resolveForum!(account, "111", "office技巧");
      assert.equal(result.forumId, "100");
      for (const key of ["level", "experience", "signed", "canSign"] as const)
        assert.equal(result[key], null);
      assert.equal(f.context.pages().length, 0);
    } finally {
      await f.context.close();
    }
  });

  test("不存在、HTTP错误、名称不符、页面换号和读取后换号均拒绝并清理临时页", async () => {
    for (const mode of [
      "missing",
      "http-error",
      "wrong-name",
      "page-uid",
      "after-uid",
    ] as const) {
      const f = await fixture(mode);
      try {
        await assert.rejects(f.api.resolveForum!(account, "111", "office技巧"));
        assert.ok(f.requests.every((row) => row.method === "GET"));
        assert.equal(f.context.pages().length, 0);
      } finally {
        await f.context.close();
      }
    }
  });

  test("只读候选解析阻止HTTPS降级与跨站导航", async () => {
    for (const mode of ["redirect", "cross-site"] as const) {
      const f = await fixture(mode);
      try {
        await assert.rejects(
          f.api.resolveForum!(account, "111", "office技巧"),
          { code: "TIEBA_PAGE_REDIRECT" },
        );
        assert.ok(
          f.requests.every(
            (row) => new URL(row.url).origin === "https://tieba.baidu.com",
          ),
        );
        assert.equal(f.context.pages().length, 0);
      } finally {
        await f.context.close();
      }
    }
  });
});
