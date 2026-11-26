import test from "node:test";
import assert from "node:assert/strict";
import { BitBrowser } from "../core/bitbrowser";
import { AppError, ServiceHttpError } from "../core/errors";

test("比特本地服务断连与超时给出明确连接原因，不暴露凭据，不自动重发", async () => {
  for (const failure of [
    new TypeError("fetch failed"),
    Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
  ]) {
    let calls = 0;
    const bit = new BitBrowser(
      async () => ({ url: "http://127.0.0.1:54345", key: "fixture-secret" }),
      async () => {
        calls++;
        throw failure;
      },
    );
    await assert.rejects(
      () => bit.health(),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "BIT_CONNECTION_UNAVAILABLE");
        assert.match(error.message, /启动比特客户端并开启本地 API/);
        assert.ok(!error.message.includes("fixture-secret"));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});
test("比特服务已返回的明确HTTP拒绝保留原错误，不误报连接失败", async () => {
  const failure = new ServiceHttpError(403, "比特API无访问权限");
  const bit = new BitBrowser(
    async () => ({ url: "http://127.0.0.1:54345", key: null }),
    async () => {
      throw failure;
    },
  );
  await assert.rejects(
    () => bit.health(),
    (error) => error === failure,
  );
});

test("已打开的精确配置复用已证明端点，不调用打开API或改变浏览器默认设置", async (t) => {
  const { chromium } = await import("playwright-core");
  let opens = 0,
    disconnects = 0,
    actions = 0;
  const endpoint = "ws://127.0.0.1:52236/devtools/browser/fixture";
  const browser = {
    newBrowserCDPSession: async () => ({
      send: async () => ({ arguments: [] }),
      detach: async () => {},
    }),
    contexts: () => [context],
    close: async () => {
      disconnects++;
    },
  };
  const context = { browser: () => browser, pages: () => [] };
  t.mock.method(
    chromium,
    "connectOverCDP",
    async (actual: string, options: { noDefaults?: boolean }) => {
      assert.equal(actual, endpoint);
      assert.equal(options.noDefaults, true);
      return browser;
    },
  );
  const bit = new BitBrowser(
    async () => ({ url: "http://127.0.0.1:54345", key: "fixture-secret" }),
    async () => {
      opens++;
      throw new TypeError("fetch failed");
    },
    undefined,
    async (id) => {
      assert.equal(id, "profile-fixture");
      return endpoint;
    },
  );
  const result = await bit.withProfile("profile-fixture", async (c) => {
    actions++;
    assert.equal(c, context);
    return "read-or-authorized-action";
  });
  assert.equal(result, "read-or-authorized-action");
  assert.equal(opens, 0);
  assert.equal(actions, 1);
  assert.equal(disconnects, 1);
  assert.equal(
    bit.lifecycle.info(
      bit.lifecycle.key("http://127.0.0.1:54345", "profile-fixture"),
    ).owner,
    "retained",
  );
});

test("复用现有配置仍拒绝变更或非本地连接；无存活配置时保留API启动及连接失败", async (t) => {
  const { chromium } = await import("playwright-core");
  let lookups = 0,
    requests = 0,
    connected = 0;
  t.mock.method(chromium, "connectOverCDP", async () => {
    connected++;
    assert.fail("不应连接");
  });
  for (const url of [
    "http://example.com:54345",
    "http://127.0.0.1:54345/path",
  ]) {
    const bit = new BitBrowser(
      async () => ({ url, key: null }),
      async () => {
        requests++;
        return {};
      },
      undefined,
      async () => {
        lookups++;
        return null;
      },
    );
    await assert.rejects(() =>
      bit.withProfile("profile-fixture", async () => {}),
    );
  }
  const bit = new BitBrowser(
    async () => ({ url: "http://127.0.0.1:54345", key: null }),
    async () => {
      requests++;
      throw new TypeError("fetch failed");
    },
    undefined,
    async () => {
      lookups++;
      return null;
    },
  );
  await assert.rejects(
    () =>
      bit.withProfile(
        "profile-fixture",
        async () => {},
        "http://127.0.0.1:1234",
      ),
    { code: "BIT_CONNECTION_CHANGED" },
  );
  assert.equal(lookups, 0);
  assert.equal(requests, 0);
  await assert.rejects(
    () => bit.withProfile("profile-fixture", async () => {}),
    { code: "BIT_CONNECTION_UNAVAILABLE" },
  );
  assert.equal(lookups, 1);
  assert.equal(requests, 1);
  assert.equal(connected, 0);
});
