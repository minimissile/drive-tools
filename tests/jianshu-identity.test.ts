import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { jianshuIdentityScript } from "../core/jianshu/browser-state";

const endpoint = "https://www.jianshu.com/author/current_user";
const viewer = { id: 31508978, slug: "ad880a2adcd7", nickname: "跨过那山海" };
type Options = {
  body?: unknown;
  text?: string;
  status?: number;
  url?: string;
  contentType?: string;
  origin?: string;
  pathname?: string;
  reject?: boolean;
  signInForm?: boolean;
};
function fixture(options: Options = {}) {
  const calls: { url: string; options: RequestInit }[] = [];
  const run = () =>
    runInNewContext(jianshuIdentityScript(), {
      location: {
        origin: options.origin ?? "https://www.jianshu.com",
        pathname: options.pathname ?? "/writer",
      },
      // Neither a prior cached viewer nor an article author can authorize this call.
      window: {
        JS_ENV: { current_user: viewer, author: viewer },
        __INITIAL_STATE__: { currentUser: viewer },
      },
      document: { querySelector: () => (options.signInForm ? {} : null) },
      URL,
      AbortSignal,
      fetch: async (url: string, requestOptions: RequestInit) => {
        calls.push({ url, options: requestOptions });
        if (options.reject) throw Error("network or redirect failure");
        const status = options.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          url: options.url ?? endpoint,
          headers: {
            get: () => options.contentType ?? "application/json; charset=utf-8",
          },
          text: async () =>
            options.text ??
            JSON.stringify(options.body === undefined ? viewer : options.body),
        };
      },
    });
  return { run, calls };
}

test("首页模板无viewer也通过官网同会话current_user实时核验，旧缓存与作者数据不作授权", async () => {
  const f = fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(await f.run())), {
    uid: viewer.slug,
    nickname: viewer.nickname,
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, endpoint);
  assert.equal(f.calls[0].options.credentials, "same-origin");
  assert.equal(f.calls[0].options.cache, "no-store");
  assert.equal(f.calls[0].options.redirect, "error");
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);

  const changed = fixture({
    body: { id: 123, slug: "123456abcdef", nickname: "当前其他身份" },
  });
  assert.equal(
    (await changed.run()).uid,
    "123456abcdef",
    "返回实时身份以供账号层阻止错UID，不采用window缓存",
  );
});

test("明确未登录才返回null，未知网络、重定向与403不能伪装会话过期", async () => {
  for (const options of [
    { status: 401 },
    { body: null },
    { body: { is_login: false } },
    { body: { is_signed_in: false } },
  ])
    assert.equal(await fixture(options).run(), null);
  for (const options of [
    { status: 403 },
    { status: 500 },
    { reject: true },
    { body: {} },
    { body: { user: viewer } },
  ])
    await assert.rejects(fixture(options).run(), /身份/);
  assert.equal(
    await fixture({
      pathname: "/sign_in",
      signInForm: true,
      reject: true,
    }).run(),
    null,
  );
  await assert.rejects(
    fixture({ pathname: "/writer", signInForm: true, reject: true }).run(),
    /身份/,
  );
});

test("验证码HTML、错误JSON、过大响应与外站响应不信任页面上的旧身份", async () => {
  for (const options of [
    { contentType: "text/html", text: "<html>请完成验证</html>" },
    { text: "not JSON" },
    { text: " ".repeat(512001) },
    { url: "https://evil.test/author/current_user" },
    { url: "https://www.jianshu.com/author/current_user?profile=author" },
  ])
    await assert.rejects(fixture(options).run(), /身份/);
});

test("公开文章、作者主页、第三方登录页与外站不发送身份请求", async () => {
  for (const options of [
    { pathname: "/u/ad880a2adcd7" },
    { pathname: "/p/782f3ccc613b" },
    { origin: "https://graph.qq.com", pathname: "/oauth2.0/show" },
    { origin: "https://www.jianshu.com.evil.test" },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /身份页面已变化/);
    assert.equal(f.calls.length, 0);
  }
});
