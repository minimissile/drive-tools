import { withPageLifecycleFixture } from "./browser-page-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { BrowserContext } from "playwright-core";
import type { WebsiteAccount } from "../shared/website-accounts";
import type { JianshuPayload } from "../shared/jianshu";
import {
  checkJianshuArticle,
  jianshuArticleUrl,
  jianshuCurrentUser,
  jianshuEditorUrl,
  jianshuIdentityScript,
  jianshuSessionObservation,
  readJianshuArticle,
  unwrapJianshuLink,
  type JianshuArticleObservation,
} from "../core/jianshu/browser-state";
import { jianshuBrowser, verifyBitJianshu } from "../core/jianshu/browser";
import { findEnvironmentPage } from "../core/browser-pages";
import {
  websiteLoginSpecs,
  websiteNavigationAllowed,
} from "../desktop/website-session-policy";
const uid = "03f80ba6b743",
  url = "https://www.jianshu.com/p/783255fa1ea8",
  resourceUrl = "https://pan.quark.cn/s/ownresource",
  sourceUrl = "https://example.org/guide";
const payload: JianshuPayload = {
  id: "jianshu_test",
  title: "学习资料说明",
  text: `## 资料说明\n这是一份依据实际目录整理的学习资料。\n\n资料入口\n${resourceUrl}\n参考来源\n${sourceUrl}`,
  html: "<p>示例</p>",
  images: [],
  aiAssisted: false,
  resourceUrl,
  sourceUrls: [sourceUrl],
};
const article = (): JianshuArticleObservation => ({
  url,
  title: payload.title,
  text: payload.text.replace(/^## /gm, ""),
  authorIds: [uid, "30293973"],
  links: [
    resourceUrl,
    `https://links.jianshu.com/go?to=${encodeURIComponent(sourceUrl)}`,
  ],
  linkedTexts: [],
  imageCount: 0,
  published: true,
});
const account: WebsiteAccount = {
  id: "web_jianshu",
  provider: "jianshu",
  alias: "简书账号",
  uid,
  status: "connected",
  createdAt: "2026-11-23T00:00:00.000Z",
  updatedAt: "2026-11-23T00:00:00.000Z",
};
const runIdentity = (user: unknown, pathname = "/writer") =>
  vm.runInNewContext(jianshuIdentityScript(), {
    location: { origin: "https://www.jianshu.com", pathname },
    URL,
    AbortSignal,
    fetch: async (url: string) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(user),
    }),
    document: { querySelector: () => null },
  });

test("简书账号只接受官网当前用户接口，不从Cookie和访问主页推UID", async () => {
  assert.deepEqual(
    jianshuCurrentUser({ id: 30293973, slug: uid, nickname: "整理者" }),
    { uid, nickname: "整理者" },
  );
  assert.deepEqual(jianshuCurrentUser({ id: "30293973", nickname: "整理者" }), {
    uid: "30293973",
    nickname: "整理者",
  });
  for (const v of [
    null,
    {},
    [],
    { slug: uid },
    { nickname: "整理者", id: Number.MAX_SAFE_INTEGER + 5 },
    { id: "../1", nickname: "整理者" },
    { uid, nickname: "资料页作者" },
    { id: 1, nickname: " " },
    { id: 1, nickname: "访客", is_signed_in: false },
  ])
    assert.equal(jianshuCurrentUser(v), null);
  assert.equal(
    (await runIdentity({ id: 30293973, slug: uid, nickname: "整理者" })).uid,
    uid,
  );
  assert.equal(await runIdentity(null), null);
  await assert.rejects(
    () =>
      runIdentity({
        JS_ENV: { user: { id: 30293973, nickname: "非当前用户" } },
      }),
    /未能确认/,
  );
  await assert.rejects(
    () => runIdentity({ id: 30293973, nickname: "整理者" }, `/u/${uid}`),
    /身份页面已变化/,
  );
});
test("简书身份未知时保持未核验语义，明确访客才过期", () => {
  const cold = jianshuSessionObservation({
    hasSession: false,
    uid: null,
    windowOpen: false,
    error: "未核实",
  });
  assert.equal(cold.unverified, true);
  assert.equal(cold.expired, false);
  assert.equal(
    jianshuSessionObservation({
      ...cold,
      unverified: false,
      checkedAt: "2026-11-23T00:00:00.000Z",
    }).expired,
    true,
  );
});
test("简书URL拒绝外域、凭据、端口、主页、伪造后缀和非公开路径", () => {
  assert.equal(
    websiteLoginSpecs.jianshu.home,
    "https://www.jianshu.com/sign_in",
  );
  assert(websiteNavigationAllowed("jianshu", jianshuEditorUrl));
  assert.equal(
    websiteNavigationAllowed("jianshu", "https://www.jianshu.com.evil.test/"),
    false,
  );
  assert.equal(jianshuArticleUrl(url), url);
  assert.equal(jianshuArticleUrl("https://jianshu.com/p/783255fa1ea8/"), url);
  for (const v of [
    "http://www.jianshu.com/p/783255fa1ea8",
    "https://user:pass@www.jianshu.com/p/783255fa1ea8",
    "https://www.jianshu.com:444/p/783255fa1ea8",
    `${url}?preview=true`,
    `${url}#private`,
    `${url}/edit`,
    `https://www.jianshu.com/u/${uid}`,
    "https://www.jianshu.com.evil.test/p/783255fa1ea8",
  ])
    assert.equal(jianshuArticleUrl(v), null);
});
test("简书跳转只解析准确go目标，伪装域名不会被当作同一资源", () => {
  assert.equal(
    unwrapJianshuLink(
      `https://links.jianshu.com/go?to=${encodeURIComponent(resourceUrl)}`,
    ),
    resourceUrl,
  );
  for (const v of [
    "javascript:alert(1)",
    "https://links.jianshu.com/go?to=javascript:alert(1)",
    "https://links.jianshu.com/go?to=https%3A%2F%2Fuser%3Apass%40example.org",
    "http://example.org/",
    "https://links.jianshu.com/go",
  ])
    assert.equal(unwrapJianshuLink(v), null);
  assert.notEqual(
    unwrapJianshuLink(
      `https://links.jianshu.com.evil.test/go?to=${encodeURIComponent(resourceUrl)}`,
    ),
    resourceUrl,
  );
});
test("回执必须公开、作者匹配、标题和整篇正文对等且准确入口齐备", () => {
  assert.equal(
    checkJianshuArticle(article(), uid, url, payload).verified,
    true,
  );
  assert.equal(
    checkJianshuArticle(article(), "30293973", url, payload).verified,
    true,
  );
  for (const v of [
    null,
    { ...article(), published: false },
    { ...article(), url: "https://www.jianshu.com/p/aaaaaaaaaaaa" },
    { ...article(), authorIds: ["anotheruser"] },
    { ...article(), title: "同资料的其他版本" },
    { ...article(), text: `${article().text}\n额外内容` },
    { ...article(), text: article().text.slice(0, 12) },
  ])
    assert.equal(checkJianshuArticle(v, uid, url, payload).verified, false);
});
test("正文中的同名假链接不能靠锚文本通过", () => {
  const expected = {
    ...payload,
    text: "学习资料说明，点击获取资料查看，不含文字URL。",
    sourceUrls: [],
  };
  const observed = {
    ...article(),
    text: expected.text,
    links: ["https://pan.quark.cn/s/wrongresource"],
  };
  assert.equal(
    checkJianshuArticle(observed, uid, url, expected).verified,
    false,
  );
  assert.equal(
    checkJianshuArticle(
      {
        ...observed,
        links: [
          `https://links.jianshu.com/go?to=${encodeURIComponent(resourceUrl)}`,
        ],
      },
      uid,
      url,
      expected,
    ).verified,
    true,
  );
});
test("正文已核实与配图待人工检查分别记录，不按数量声明图文一致", () => {
  const image = {
    name: "封面",
    file: `${"a".repeat(64)}.png`,
    sha256: "a".repeat(64),
    storage: "content-assets" as const,
  };
  for (const actual of [0, 1, 3]) {
    const receipt = checkJianshuArticle(
      { ...article(), imageCount: actual },
      uid,
      url,
      { ...payload, images: [image] },
    );
    assert.equal(receipt.verified, true);
    assert.equal(receipt.imageReviewRequired, true);
    assert.match(receipt.reason, /配图待人工核对/);
  }
  const extra = checkJianshuArticle(
    { ...article(), imageCount: 1 },
    uid,
    url,
    payload,
  );
  assert.equal(extra.verified, true);
  assert.equal(extra.imageReviewRequired, true);
  const mismatch = checkJianshuArticle(
    { ...article(), authorIds: ["other"] },
    uid,
    url,
    { ...payload, images: [image] },
  );
  assert.equal(mismatch.verified, false);
});

const runReader = (
  note: unknown,
  options: { currentUser?: unknown; ld?: unknown; location?: string } = {},
) => {
  const href = options.location ?? url;
  const data = JSON.stringify({
    props: {
      initialState: { note: { data: note }, currentUser: options.currentUser },
    },
  });
  const body = {
    innerText: article().text,
    querySelectorAll: (s: string) =>
      s === "a[href]" ? article().links.map((href) => ({ href })) : [],
  };
  return vm.runInNewContext(
    `(() => { const __name = fn => fn; return (${readJianshuArticle.toString()})(); })()`,
    {
      URL,
      location: {
        href,
        pathname: new URL(href).pathname,
        origin: new URL(href).origin,
      },
      document: {
        querySelector: (s: string) =>
          s === "script#__NEXT_DATA__"
            ? { textContent: data }
            : s.includes(".show-content")
              ? body
              : s === "h1"
                ? { textContent: payload.title }
                : null,
        querySelectorAll: () =>
          options.ld ? [{ textContent: JSON.stringify(options.ld) }] : [],
      },
    },
  );
};
test("官网作者读取只使用精确文章，不拿当前浏览者或推荐作者冒充", () => {
  const note = {
    slug: "783255fa1ea8",
    public: true,
    user: { slug: uid, id: 30293973 },
  };
  assert(runReader(note)?.authorIds.includes(uid));
  assert.equal(
    runReader(
      { ...note, user: null },
      { currentUser: { slug: uid, id: 30293973 } },
    ),
    null,
  );
  assert.equal(runReader({ ...note, slug: "aaaaaaaaaaaa" }), null);
  assert.equal(runReader({ ...note, public: false })?.published, false);
  assert.equal(runReader({ ...note, public: undefined })?.published, false);
  assert.equal(
    runReader(note, { location: `https://www.jianshu.com/u/${uid}` }),
    null,
  );
});
test("JSON-LD作者只能来自该篇公开Article", () => {
  const ld = {
    "@type": "BlogPosting",
    url,
    author: { "@type": "Person", url: `https://www.jianshu.com/u/${uid}` },
    datePublished: "2026-11-23T00:00:00.000Z",
  };
  assert(runReader(null, { ld })?.authorIds.includes(uid));
  assert.equal(
    runReader(null, {
      ld: { ...ld, url: "https://www.jianshu.com/p/aaaaaaaaaaaa" },
    }),
    null,
  );
  assert.equal(
    runReader(null, {
      ld: { ...ld, author: { url: `https://evil.test/u/${uid}` } },
    }),
    null,
  );
});
function mockContext(failed = false) {
  let opens = 0,
    closes = 0,
    evaluations = 0;
  const page = {
    url: () => url,
    route: async () => {},
    goto: async () => ({ ok: () => !failed }),
    close: async () => {
      closes++;
    },
    evaluate: async () => {
      evaluations++;
      return article();
    },
  };
  return {
    context: {
      newPage: async () => {
        opens++;
        return page;
      },
    } as unknown as BrowserContext,
    counters: () => ({ opens, closes, evaluations }),
  };
}
test("指纹回执读取只打开独立读者页面并总是关闭，不调用提交动作", async () => {
  const f = mockContext(),
    port = jianshuBrowser((_account, action) => action(withPageLifecycleFixture(f.context)));
  assert.equal((await port.checkResult(account, url, payload)).verified, true);
  assert.deepEqual(f.counters(), { opens: 1, closes: 1, evaluations: 1 });
  const bad = mockContext(true),
    blocked = jianshuBrowser((_account, action) => action(withPageLifecycleFixture(bad.context)));
  assert.equal(
    (await blocked.checkResult(account, url, payload)).verified,
    false,
  );
  assert.deepEqual(bad.counters(), { opens: 1, closes: 1, evaluations: 0 });
});
test("指纹身份网络失败是未核验，不伪装退出或读取Cookie中的UID", async () => {
  const f = mockContext(true),
    state = await verifyBitJianshu(withPageLifecycleFixture(f.context));
  assert.equal(state.unverified, true);
  assert.equal(state.uid, null);
  assert.equal(state.expired, undefined);
  assert.equal(f.counters().closes, 1);
});

test("资源URL作为锚文本但指向其他地址时不得借纯文本回退通过", () => {
  const observed = {
    ...article(),
    links: ["https://pan.quark.cn/s/wrongresource", sourceUrl],
    linkedTexts: [
      { text: resourceUrl, url: "https://pan.quark.cn/s/wrongresource" },
    ],
  };
  assert.equal(
    checkJianshuArticle(observed, uid, url, payload).verified,
    false,
  );
  assert.match(
    checkJianshuArticle(observed, uid, url, payload).reason,
    /实际跳转地址/,
  );
});

test("自动填写拒绝身份待核验的账号，不创建或改写远端草稿", async () => {
  const existingUrl = "https://www.jianshu.com/writer#/notebooks/12/notes/99";
  let opened = 0;
  const context = {
    pages: () => [
      {
        url: () => existingUrl,
        isClosed: () => false,
        evaluate: async () => true,
        bringToFront: async () => {
          opened++;
        },
      },
    ],
    newPage: async () => {
      throw Error("不应新建远端编辑器");
    },
  } as unknown as BrowserContext;
  const port = jianshuBrowser((_account, action) => action(context));
  await assert.rejects(
    () =>
      port.prepare({ ...account, uid: null, status: "disconnected" }, payload),
    /已核实身份/,
  );
  assert.equal(opened, 0);
});

test("指纹草稿窗口已切到别稿时保留现场，准确原稿可另开并继续复用", async () => {
  const savedUrl = "https://www.jianshu.com/writer#/notebooks/12/notes/99";
  const otherUrl = "https://www.jianshu.com/writer#/notebooks/12/notes/100";
  const pages: any[] = [];
  let created = 0;
  const old = {
    url: () => otherUrl,
    isClosed: () => false,
    evaluate: async () => true,
    goto: async () => {
      throw Error("不允许导航用户的别稿窗口");
    },
    close: async () => {
      throw Error("不允许关闭用户窗口");
    },
  };
  pages.push(old);
  const context = {
    pages: () => pages,
    newPage: async () => {
      created++;
      let url = "about:blank";
      const page = {
        url: () => url,
        isClosed: () => false,
        evaluate: async () => true,
        goto: async (value: string) => {
          url = value;
        },
        close: async () => {},
      };
      pages.push(page);
      return page;
    },
  } as unknown as BrowserContext;
  const accepts = (page: { url(): string }) => page.url() === savedUrl;
  withPageLifecycleFixture(context);
  const current = await findEnvironmentPage(
    context,
    "panxu:jianshu:article",
    savedUrl,
    accepts,
  );
  assert.notEqual(current, old);
  assert.equal(current.url(), savedUrl);
  assert.equal(old.url(), otherUrl);
  assert.equal(created, 1);
  assert.equal(
    await findEnvironmentPage(
      context,
      "panxu:jianshu:article",
      savedUrl,
      accepts,
    ),
    current,
  );
  assert.equal(created, 1, "再次查看应复用准确原稿，不重复开窗");
});

test("回执读者阻止顶层跳往其他文章或站点，只对本次独立页面设置导航保护", async () => {
  let guard: ((route: any) => Promise<void>) | undefined;
  let aborted = 0,
    fallback = 0;
  const frame = {};
  const page = {
    mainFrame: () => frame,
    url: () => url,
    route: async (
      _pattern: string,
      callback: (route: any) => Promise<void>,
    ) => {
      guard = callback;
    },
    goto: async () => ({ ok: () => true }),
    evaluate: async () => article(),
    close: async () => {},
  };
  const context = withPageLifecycleFixture({ newPage: async () => page } as unknown as BrowserContext);
  const port = jianshuBrowser((_account, action) => action(context));
  assert.equal((await port.checkResult(account, url, payload)).verified, true);
  assert(guard);
  const run = async (target: string, navigation: boolean) =>
    guard!({
      request: () => ({
        isNavigationRequest: () => navigation,
        frame: () => frame,
        url: () => target,
      }),
      abort: async () => {
        aborted++;
      },
      fallback: async () => {
        fallback++;
      },
    });
  await run("https://evil.example/collect", true);
  await run("https://www.jianshu.com/p/aaaaaaaaaaaa", true);
  await run(url, true);
  await run("https://cdn.example/image.png", false);
  assert.equal(aborted, 2);
  assert.equal(fallback, 2);
});
