import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { BrowserContext } from "playwright-core";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";
import {
  bilibiliCurrentUser,
  bilibiliIdentityScript,
  bilibiliLoggedOut,
  bilibiliSessionObservation,
} from "../core/bilibili/identity";
import { verifyBitBilibili } from "../core/bilibili/account-browser";
import {
  websiteLoginSpecs,
  websiteNavigationAllowed,
} from "../desktop/website-session-policy";
import { fixture } from "./helpers";

const viewer = {
  code: 0,
  data: { isLogin: true, mid: 987654321, uname: "资料整理者" },
};
const runIdentity = (
  payload: unknown,
  origin = "https://api.bilibili.com",
  pathname = "/x/web-interface/nav",
) =>
  vm.runInNewContext(bilibiliIdentityScript(), {
    location: { origin, pathname },
    document: { body: { innerText: JSON.stringify(payload) } },
  });

test("B站身份仅接受成功的当前登录者响应，拒绝主页ID、Cookie式字段与不安全数字", () => {
  assert.deepEqual(bilibiliCurrentUser(viewer), {
    uid: "987654321",
    nickname: "资料整理者",
  });
  for (const value of [
    null,
    {},
    { code: -101, data: viewer.data },
    { code: 0, data: { ...viewer.data, isLogin: false } },
    { code: 0, data: { ...viewer.data, isLogin: "true" } },
    { code: 0, data: { mid: 987654321, uname: "访客主页" } },
    { code: 0, data: { ...viewer.data, mid: 0 } },
    { code: 0, data: { ...viewer.data, mid: Number.MAX_SAFE_INTEGER + 2 } },
    { code: 0, data: { ...viewer.data, mid: "../private" } },
    { code: 0, data: { ...viewer.data, uname: " " } },
    { DedeUserID: "987654321", SESSDATA: "present" },
  ])
    assert.equal(bilibiliCurrentUser(value), null);
});

test("B站身份脚本只在官方nav文档读取，登录导航限制在明确HTTPS域名", () => {
  assert.equal(runIdentity(viewer).uid, "987654321");
  assert.throws(
    () => runIdentity(viewer, "https://www.bilibili.com", "/987654321"),
    /页面已变化/,
  );
  assert.throws(
    () => runIdentity(viewer, "https://api.bilibili.com.attacker.test"),
    /页面已变化/,
  );
  assert.throws(
    () =>
      runIdentity(viewer, "https://api.bilibili.com", "/x/space/wbi/acc/info"),
    /页面已变化/,
  );
  assert.equal(runIdentity({ code: -101, data: { isLogin: false } }), null);
  assert.equal(
    websiteLoginSpecs.bilibili.home,
    "https://passport.bilibili.com/login",
  );
  for (const url of [
    "https://passport.bilibili.com/login",
    "https://member.bilibili.com/platform/home",
    "https://api.bilibili.com/x/web-interface/nav",
  ])
    assert(websiteNavigationAllowed("bilibili", url));
  for (const url of [
    "http://passport.bilibili.com/login",
    "https://member.bilibili.com.attacker.test/",
    "https://user:pass@www.bilibili.com/",
    "https://www.bilibili.com:8443/",
    "javascript:alert(1)",
  ])
    assert.equal(websiteNavigationAllowed("bilibili", url), false);
});

test("B站账号复用独立环境与明确身份检查，错号和重复UID不能借用原账号", async () => {
  const f = await fixture();
  let actualUid = "987654321",
    verifications = 0;
  const observed = new Map<string, WebsiteSessionState>();
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async () => {},
    clear: async () => {},
    invalidate: async () => {},
    status: async (account) =>
      observed.get(account.id) ?? {
        hasSession: false,
        uid: null,
        windowOpen: false,
        error: null,
      },
    verify: async (account) => {
      verifications++;
      const state: WebsiteSessionState = {
        hasSession: true,
        uid: actualUid,
        nickname: "资料整理者",
        windowOpen: false,
        checkedAt: new Date().toISOString(),
        error: null,
      };
      observed.set(account.id, state);
      return state;
    },
  };
  try {
    const a = (await f.app.invoke("websiteAccounts.add", {
      provider: "bilibili",
      uid: "spoofed",
    })) as WebsiteAccount;
    const b = (await f.app.invoke("websiteAccounts.add", {
      provider: "bilibili",
    })) as WebsiteAccount;
    assert.equal(a.uid, null);
    assert.equal(a.alias, "哔哩哔哩 1");
    assert.notEqual(a.environmentId, b.environmentId);
    assert.equal(
      f.app.environments.forAccount({ kind: "website", id: a.id }).engine,
      "electron",
    );
    const connected = await f.app.websiteAccounts.verify(a.id);
    assert.equal(connected.status, "connected");
    assert.equal(connected.uid, actualUid);
    const checksBeforeRead = verifications;
    await f.app.websiteAccounts.list();
    assert.equal(
      verifications,
      checksBeforeRead,
      "列表只复用检查结果，不重新访问身份接口",
    );
    await f.app.websiteAccounts.use(a.id, "bilibili", async (account) =>
      assert.equal(account.uid, actualUid),
    );
    const duplicate = await f.app.websiteAccounts.verify(b.id);
    assert.equal(duplicate.status, "disconnected");
    assert.match(duplicate.message, /已连接|重复|其他账号/);
    actualUid = "111111111";
    const mismatch = await f.app.websiteAccounts.verify(a.id);
    assert.equal(mismatch.uid, "987654321");
    assert.equal(mismatch.status, "disconnected");
    assert.match(mismatch.message, /其他身份|不一致/);
    let used = false;
    await assert.rejects(
      f.app.websiteAccounts.use(a.id, "bilibili", async () => {
        used = true;
      }),
      /其他身份|不一致/,
    );
    assert.equal(used, false);
  } finally {
    await f.cleanup();
  }
});

test("B站指纹身份检查使用一次性同环境nav页面，失败或未登录均清理检查页", async () => {
  let closed = 0,
    routeInstalled = false,
    currentUrl = "",
    payload: unknown = viewer;
  const page = {
    route: async () => {
      routeInstalled = true;
    },
    goto: async (url: string) => {
      currentUrl = url;
      return { ok: () => true };
    },
    url: () => currentUrl,
    evaluate: async () => runIdentity(payload),
    close: async () => {
      closed++;
    },
  };
  const context = { newPage: async () => page } as unknown as BrowserContext;
  const connected = await verifyBitBilibili(context);
  assert(routeInstalled);
  assert.equal(connected.uid, "987654321");
  assert.equal(connected.hasSession, true);
  assert.equal(currentUrl, "https://api.bilibili.com/x/web-interface/nav");
  payload = { code: -101, data: { isLogin: false } };
  const loggedOut = await verifyBitBilibili(context);
  assert.equal(loggedOut.hasSession, false);
  assert.equal(loggedOut.expired, true);
  assert.equal(loggedOut.uid, null);
  assert.equal(closed, 2);
});

test("B站仅明确未登录证据才失效，HTTP200风控或未知结构保持待核实", async () => {
  for (const value of [{ code: -101 }, { code: 0, data: { isLogin: false } }]) {
    assert.equal(bilibiliLoggedOut(value), true);
    assert.equal(runIdentity(value), null);
  }
  for (const value of [
    { code: -352 },
    { code: -509 },
    {},
    { code: 0, data: {} },
    { code: 0, data: { ...viewer.data, mid: 0 } },
  ]) {
    assert.equal(bilibiliLoggedOut(value), false);
    assert.throws(() => runIdentity(value), /尚未核实|响应已变化/);
  }
  let mode: "risk" | "network" | "http" = "risk",
    closed = 0;
  const page = {
    route: async () => {},
    goto: async () => {
      if (mode === "network") throw new Error("timeout");
      return { ok: () => mode !== "http" };
    },
    url: () => "https://api.bilibili.com/x/web-interface/nav",
    evaluate: async () => runIdentity({ code: -352 }),
    close: async () => {
      closed++;
    },
  };
  for (const next of ["risk", "network", "http"] as const) {
    mode = next;
    const state = await verifyBitBilibili({
      newPage: async () => page,
    } as unknown as BrowserContext);
    assert.equal(state.unverified, true);
    assert.equal(state.hasSession, false);
    assert.notEqual(state.expired, true);
    assert.equal(state.checkedAt, undefined);
  }
  assert.equal(closed, 3);
});

test("B站原生未完成观测不会把上次身份当失效，明确退出才标expired", () => {
  for (const state of [
    { hasSession: false, uid: null, windowOpen: false, error: "网络异常" },
    {
      hasSession: false,
      uid: null,
      windowOpen: false,
      expired: true,
      error: "Cookie已变化",
    },
  ]) {
    const observed = bilibiliSessionObservation(state);
    assert.equal(observed.unverified, true);
    assert.equal(observed.expired, false);
  }
  const logout = bilibiliSessionObservation({
    hasSession: false,
    uid: null,
    windowOpen: false,
    checkedAt: new Date().toISOString(),
    error: "未登录",
  });
  assert.equal(logout.expired, true);
  assert.notEqual(logout.unverified, true);
});

test("B站临时核验失败保留最后已知UID与连接状态，使用入口仍阻止待核实账号", async () => {
  const f = await fixture();
  let observed: WebsiteSessionState = {
    hasSession: true,
    uid: "987654321",
    nickname: "资料整理者",
    windowOpen: false,
    error: null,
    checkedAt: "2026-11-08T01:00:00.000Z",
  };
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async () => {},
    clear: async () => {},
    invalidate: async () => {},
    status: async () => observed,
    verify: async () => observed,
  };
  try {
    const a = f.app.websiteAccounts.add("bilibili");
    await f.app.websiteAccounts.verify(a.id);
    const before = f.app.websiteAccounts.get(a.id);
    observed = bilibiliSessionObservation({
      hasSession: false,
      uid: null,
      windowOpen: false,
      error: "身份接口受限，请稍后重试",
    });
    const retained = await f.app.websiteAccounts.check(a.id);
    assert.equal(retained.status, "connected");
    assert.equal(retained.uid, before.uid);
    assert.equal(retained.checkedAt, before.checkedAt);
    assert.equal(retained.unverified, true);
    let used = false;
    await assert.rejects(
      f.app.websiteAccounts.use(a.id, "bilibili", async () => {
        used = true;
      }),
      /受限|核实/,
    );
    assert.equal(used, false);
    assert.equal(f.app.websiteAccounts.get(a.id).uid, before.uid);
    assert.equal(f.app.websiteAccounts.get(a.id).status, "connected");
    observed = bilibiliSessionObservation({
      hasSession: false,
      uid: null,
      windowOpen: false,
      checkedAt: "2026-11-08T01:01:00.000Z",
      error: "未登录",
    });
    const expired = await f.app.websiteAccounts.verify(a.id);
    assert.equal(expired.status, "expired");
    assert.equal(expired.uid, before.uid);
  } finally {
    await f.cleanup();
  }
});
