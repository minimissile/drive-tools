import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { tiebaAutocareBrowser } from "../core/tieba/autocare-browser";
import {
  discoveryForumName,
  discoveryCount,
  tiebaForumDiscoverySearchUrl,
  tiebaForumDiscoveryPageScript,
  type TiebaForumDiscoverySnapshot,
} from "../core/tieba/forum-discovery-page";
import { tiebaForumKeywordSchema } from "../shared/tieba-forum-discovery";
import { tiebaHomeFixture } from "./tieba-autocare-browser-fixture";
import type { WebsiteAccount } from "../shared/website-accounts";
const account: WebsiteAccount = {
  id: "web_discovery_fixture",
  provider: "tieba",
  uid: "111",
  alias: "找吧专用离线",
  status: "connected",
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
};
test("query normalization and observed official route cannot inject another navigation", () => {
  assert.equal(
    tiebaForumKeywordSchema.parse("  ｅｐｕｂ   电子书  "),
    "epub 电子书",
  );
  const u = new URL(
    tiebaForumDiscoverySearchUrl("电子书&kw=https://other.invalid"),
  );
  assert.equal(u.origin, "https://tieba.baidu.com");
  assert.equal(u.searchParams.has("kw"), false);
  assert.equal(u.searchParams.get("qw"), "电子书&kw=https://other.invalid");
  for (const v of ["", "x".repeat(81), "电子\n书"])
    assert.throws(() => tiebaForumKeywordSchema.parse(v));
});
test("result links accept one observed extra encoding layer only when the unique displayed name matches", () => {
  const href =
    "https://tieba.baidu.com/f?kw=" +
    encodeURIComponent(encodeURIComponent("电子书"));
  assert.equal(discoveryForumName(href, "电子书"), "电子书");
  const longName = "电子书资料分享与目录整理专题讨论";
  assert.equal(
    discoveryForumName(
      "https://tieba.baidu.com/f?kw=" +
        encodeURIComponent(encodeURIComponent(longName)),
      longName,
    ),
    longName,
  );
  assert.equal(
    discoveryForumName("/f?kw=%B5%E7%D7%D3%CA%E9%D7%CA%D4%B4", "电子书资源"),
    "电子书资源",
  );
  for (const h of [
    href,
    "http://tieba.baidu.com/f?kw=电子书",
    "https://x@tieba.baidu.com/f?kw=电子书",
    "https://example.invalid/f?kw=电子书",
    "/f?kw=电子书&kw=其他",
  ])
    assert.equal(discoveryForumName(h, "其他"), null);
  assert.equal(
    discoveryForumName(
      "https://tieba.baidu.com/f?kw=" +
        encodeURIComponent(encodeURIComponent(encodeURIComponent("电子书"))),
      "电子书",
    ),
    null,
  );
  assert.equal(discoveryCount("16.4W"), null);
  assert.equal(discoveryCount("1,000"), 1000);
  assert.equal(discoveryCount("12,3"), null);
  assert.equal(
    discoveryForumName(
      "https://tieba.baidu.com/f?kw=" + encodeURIComponent("电子书&kw=其他%41"),
      "电子书",
    ),
    null,
  );
});
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
type Mode =
  | "valid"
  | "many"
  | "partial"
  | "wrong-tab"
  | "wrong-query"
  | "empty"
  | "side-only"
  | "captcha"
  | "uid-change"
  | "hydrate"
  | "wrong-detail"
  | "unknown-counts"
  | "narrow"
  | "query-more"
  | "related-only"
  | "recommend-only";
async function fixture(mode: Mode = "valid") {
  const context = await browser.newContext();
  let uid = "111";
  const requests: { path: string; method: string }[] = [];
  const names =
    mode === "many"
      ? Array.from({ length: 12 }, (_, i) => `电子书${i + 1}`)
      : mode === "narrow"
        ? ["电子书资源"]
        : mode === "related-only"
          ? ["结果", "zxq", "无结果"]
          : ["电子书", "电子书下载", "kindle"];
  const keyword =
    mode === "narrow"
      ? "电子书资源"
      : mode === "related-only"
        ? "盘序无结果验证ZXQ731948"
        : "电子书";
  const card = (name: string) =>
    `<a class="relevant-forum relevant-forum-item-wrapper" href="https://tieba.baidu.com/f?kw=${encodeURIComponent(encodeURIComponent(name))}"><div class="forum-item"><div class="name-wrapper"><span>${name}</span><span>吧</span></div><div class="forum-des">公开的阅读资料交流简介</div><div class="forum-info">关注 16.4W 贴子 79.9W</div><div class="post-btn concern">关注</div></div></a>`;
  const relatedNames = mode === "related-only" ? names : names.slice(1);
  const queryMarkup = `<div class="forum-jinzhun-jiucuo ${mode === "related-only" || mode === "recommend-only" ? "jiucuo-bg" : "jinzhun-bg"}">${mode === "related-only" || mode === "recommend-only" ? "" : card(names[0])}</div>${relatedNames.length && mode !== "recommend-only" ? `<div class="tb-simple-list" id="relevantwrap"><a class="linecard-component ignore"><div class="content ignore"><span class="line-card-font-weight">相关吧</span></div></a><div class="forum-list">${relatedNames.map(card).join("")}${mode === "query-more" ? '<div class="list-load-more">查看更多</div>' : ""}</div></div>` : ""}`;
  const recommendations = `<div class="recommend-forums"><a class="linecard-component ignore">您可能会感兴趣</a><div class="forum-list">${card("爱情")}${card("电子书热门推荐")}</div><div class="list-load-more">查看更多</div><div>没有找到相关贴吧</div></div>`;
  const query =
    mode === "empty"
      ? '<div class="forum-jinzhun-jiucuo jiucuo-bg">没有找到相关贴吧</div>'
      : mode === "side-only" || mode === "hydrate"
        ? ""
        : queryMarkup;
  const search = () =>
    `<!doctype html><meta charset="utf-8"><input type="search" class="search-box" value="${mode === "wrong-query" ? "其他" : keyword}"><a class="tab-item active" href="https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(keyword)}&tab=${mode === "wrong-tab" ? "thread" : "forum"}">${mode === "wrong-tab" ? "贴" : "吧"}</a><div class="list-container-wrapper-nav">${card("侧栏推荐")}</div><div class="forum-content"><div class="forum-content" id="fixture-query-region">${query}${recommendations}</div></div>${mode === "captcha" ? '<div id="captcha">安全验证</div>' : ""}<script>document.querySelectorAll('.post-btn').forEach(n=>n.onclick=()=>fetch('/fixture-forbidden-follow',{method:'POST'}));${mode === "hydrate" ? `setTimeout(()=>{document.querySelector('#fixture-query-region').innerHTML=${JSON.stringify(queryMarkup + recommendations)};},80);` : ""}</script>`;
  const detail = (name: string) => {
    const n = names.indexOf(name),
      id = String(100 + n);
    const rows = Array.from(
      { length: 35 },
      (_, i) =>
        `<li class="j_thread_list" data-field='${JSON.stringify({ id: 10000 + i, reply_num: i % 2, is_top: i === 0 ? 1 : 0 })}'><a class="j_th_tit" href="/p/${10000 + i}">主题标题</a><span class="threadlist_reply_date">${i === 1 ? "11-07" : "10:20"}</span></li>`,
    ).join("");
    return `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{id:'${mode === "uid-change" ? "222" : "111"}',is_login:1},forum:{id:'${id}',name:${JSON.stringify(mode === "wrong-detail" ? "另一个贴吧" : name)}}};</script><div class="card_slogan">公开论坛说明</div><div class="card_num"><span class="card_menNum">${mode === "unknown-counts" ? "16.4W" : "1000"}</span><span class="card_infoNum">${mode === "unknown-counts" ? "79.9W" : "2000"}</span></div>${mode === "unknown-counts" ? "" : '<div class="thread_list_bottom"><div class="th_footer_l">共有主题数100个，贴子数2000篇 会员数1000</div></div>'}<ul id="thread_list">${rows}</ul>`;
  };
  await context.route("https://tieba.baidu.com/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push({ path: url.pathname, method: route.request().method() });
    if (url.pathname === "/")
      await route.fulfill({
        contentType: "text/html",
        body: tiebaHomeFixture(uid),
      });
    else if (url.pathname === "/f/search/res")
      await route.fulfill({ contentType: "text/html", body: search() });
    else if (url.pathname === "/f") {
      const name = url.searchParams.get("kw") ?? "";
      if (mode === "partial" && name === names[1])
        await route.fulfill({ status: 503, body: "稍后再试" });
      else
        await route.fulfill({ contentType: "text/html", body: detail(name) });
    } else await route.fulfill({ status: 500, body: "forbidden" });
  });
  const old = await context.newPage();
  await old.setContent("<title>original user tab</title>");
  const api = tiebaAutocareBrowser(async (_a, action) => action(context), {
    pageTimeoutMs: 200,
  });
  return {
    context,
    api,
    requests,
    names,
    keyword,
    async close() {
      assert.equal(context.pages().length, 1);
      assert.equal(context.pages()[0], old);
      assert.equal(await old.title(), "original user tab");
      assert.ok(requests.every((r) => r.method === "GET"));
      assert.equal(
        requests.some((r) => r.path === "/fixture-forbidden-follow"),
        false,
      );
      assert.equal(
        requests.some((r) => r.path.startsWith("/p/")),
        false,
      );
      await context.close();
    },
  };
}
test("official forum-tab results exclude sidebar and sample only bounded homepage metadata with raw dates", async () => {
  const f = await fixture();
  try {
    const r = await f.api.findForums!(account, "111", "电子书");
    assert.equal(r.accountId, account.id);
    assert.equal(r.keyword, "电子书");
    assert.deepEqual(
      r.items.map((i) => i.name),
      f.names,
    );
    for (const item of r.items) {
      assert.ok(item.forumId);
      assert.deepEqual(
        [item.memberCount, item.postCount, item.threadCount],
        [1000, 2000, 100],
      );
      assert.equal(item.sampledThreads, 29);
      assert.equal(item.zeroReplyThreads, 14);
      assert.equal(item.latestActiveLabel, "11-07");
      assert.equal(item.description, "公开论坛说明");
    }
    assert.match(r.message, /不代表全站完整/);
    assert.equal(
      r.truncated,
      false,
      "recommendation load-more and row count are outside the query result",
    );
  } finally {
    await f.close();
  }
});
test("exact narrow query returns its precise section only, excluding even recommendations that contain the keyword", async () => {
  const f = await fixture("narrow");
  try {
    const probe = await f.context.newPage();
    try {
      await probe.goto(tiebaForumDiscoverySearchUrl(f.keyword));
      const s = await probe.evaluate<TiebaForumDiscoverySnapshot>(
        tiebaForumDiscoveryPageScript,
      );
      assert.equal(s.searchRowCount, 1);
      assert.equal(s.searchExcludedRecommendations, 2);
      assert.equal(s.searchMore, false);
      assert.equal(s.searchEmpty, false);
    } finally {
      await probe.close();
    }
    const r = await f.api.findForums!(account, "111", f.keyword);
    assert.deepEqual(
      r.items.map((i) => i.name),
      ["电子书资源"],
    );
    assert.equal(r.truncated, false);
    assert.equal(f.requests.filter((v) => v.path === "/f").length, 1);
  } finally {
    await f.close();
  }
});
test("only query-owned load-more marks a short result as truncated", async () => {
  const f = await fixture("query-more");
  try {
    const r = await f.api.findForums!(account, "111", f.keyword);
    assert.equal(r.items.length, 3);
    assert.equal(r.truncated, true);
  } finally {
    await f.close();
  }
});
test("official related-forum section is retained without a keyword substring rule", async () => {
  const f = await fixture("related-only");
  try {
    const r = await f.api.findForums!(account, "111", f.keyword);
    assert.deepEqual(
      r.items.map((i) => i.name),
      ["结果", "zxq", "无结果"],
    );
    assert.equal(r.truncated, false);
  } finally {
    await f.close();
  }
});
test("a recommendation-only page has neither query rows nor a fabricated empty search", async () => {
  const f = await fixture("recommend-only");
  try {
    await assert.rejects(f.api.findForums!(account, "111", f.keyword));
    assert.equal(f.requests.filter((v) => v.path === "/f").length, 0);
  } finally {
    await f.close();
  }
});
test("query returns at most eight real candidates and never visits result or homepage pagination", async () => {
  const f = await fixture("many");
  try {
    const r = await f.api.findForums!(account, "111", "电子书");
    assert.equal(r.items.length, 8);
    assert.equal(r.truncated, true);
    assert.equal(f.requests.filter((v) => v.path === "/f").length, 8);
    assert.equal(
      f.requests.filter((v) => v.path === "/f/search/res").length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("one failed homepage preserves all search candidates and already read public metadata", async () => {
  const f = await fixture("partial");
  try {
    const r = await f.api.findForums!(account, "111", "电子书");
    assert.equal(r.items.length, 3);
    assert.equal(r.items[0].forumId, "100");
    assert.equal(r.items[1].forumId, null);
    assert.equal(r.items[1].sampledThreads, 0);
    assert.match(r.items[1].message ?? "", /未完成/);
    assert.equal(r.items[2].forumId, "102");
    assert.equal(r.truncated, true);
  } finally {
    await f.close();
  }
});
test("abbreviated counts remain null and a wrong forum detail cannot borrow another FID", async () => {
  for (const mode of ["unknown-counts", "wrong-detail"] as const) {
    const f = await fixture(mode);
    try {
      const r = await f.api.findForums!(account, "111", "电子书");
      assert.equal(r.items[0].memberCount, null);
      assert.equal(r.items[0].postCount, null);
      assert.equal(r.items[0].threadCount, null);
      if (mode === "wrong-detail") {
        assert.equal(r.items[0].forumId, null);
        assert.equal(r.items[0].sampledThreads, 0);
      }
    } finally {
      await f.close();
    }
  }
});
test("wrong keyword/tab, sidebar-only structure, captcha and identity changes fail closed", async () => {
  for (const mode of [
    "wrong-query",
    "wrong-tab",
    "side-only",
    "captcha",
    "uid-change",
  ] as const) {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.api.findForums!(account, "111", "电子书"));
    } finally {
      await f.close();
    }
  }
});
test("hydration is awaited and explicit empty search result stays separate from an unrecognized page", async () => {
  for (const mode of ["hydrate", "empty"] as const) {
    const f = await fixture(mode);
    try {
      const r = await f.api.findForums!(account, "111", "电子书");
      assert.equal(r.items.length, mode === "empty" ? 0 : 3);
      if (mode === "empty")
        assert.equal(f.requests.filter((v) => v.path === "/f").length, 0);
    } finally {
      await f.close();
    }
  }
});
