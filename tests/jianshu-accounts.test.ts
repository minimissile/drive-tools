import { withPageLifecycleFixture } from "./browser-page-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserContext, Page } from "playwright-core";
import { Database } from "../core/database";
import { SecretStore } from "../core/secrets";
import { BrowserEnvironments } from "../core/browser-environments";
import { BrowserEnvironmentQueue } from "../core/browser-environment-queue";
import { WebsiteAccounts } from "../core/website-accounts";
import { createBrowserPlatformPorts } from "../core/browser-platform-ports";
import {
  jianshuIdentityScript,
  jianshuSessionObservation,
} from "../core/jianshu/browser-state";
import {
  defaultOtherAccountBrowser,
  otherProviderItems,
} from "../src/accounts/useOtherAccounts";
import { websiteProviderSchema } from "../shared/website-accounts";
import {
  websiteLoginSpecs,
  websiteNavigationAllowed,
} from "../desktop/website-session-policy";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";
import type { AppPorts } from "../core/ports";
import type { BitBrowser } from "../core/bitbrowser";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "jianshu-accounts-"));
  const db = new Database(join(dir, "test.db"));
  const secrets = new SecretStore(db, {
    available: () => true,
    encrypt: async (v) => v,
    decrypt: async (v) => v,
  });
  let nativeReads = 0,
    bitReads = 0,
    closed = 0;
  const launches: string[] = [],
    urls: string[] = [];
  let nativeState: WebsiteSessionState = {
    hasSession: true,
    uid: "123456789abc",
    nickname: "内置简书用户",
    checkedAt: new Date().toISOString(),
    windowOpen: false,
    error: null,
  };
  const bitState: { user: any; fail: boolean; http: number } = {
    user: { slug: "abcdef123456", nickname: "指纹简书用户" },
    fail: false,
    http: 200,
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected unrelated port");
  };
  const native: AppPorts = {
    login: unexpected,
    clearSession: unexpected,
    closeAccountWindow: unexpected,
    chooseDirectory: unexpected,
    readText: unexpected,
    activateDataPath: unexpected,
    normalizeCover: unexpected,
    openPath: unexpected,
    openAccountPage: unexpected,
    openExternal: unexpected,
    copyText: unexpected,
    saveFile: unexpected,
    websiteSessions: {
      isOpen: () => false,
      login: async (a: WebsiteAccount) => {
        launches.push(a.id);
      },
      status: async () => nativeState,
      verify: async () => {
        nativeReads++;
        return nativeState;
      },
      clear: async () => {
        throw Error("should not clear sessions");
      },
      invalidate: async () => {},
    },
  } as unknown as AppPorts;
  const environments = new BrowserEnvironments(
    db,
    secrets,
    native,
    dir,
    () => {},
  );
  environments.setExternalConfigurationReader(async () => ({
    signature: "fixed",
    proxy: "direct",
    stopWhileNetError: false,
  }));
  environments.setExternalNetworkChecker(async () => "203.0.113.50");
  const queue = new BrowserEnvironmentQueue(db, environments, () => {});
  const context = {
    pages: () => [],
    newPage: async () => {
      let address = "about:blank";
      return {
        route: async () => {},
        goto: async (url: string) => {
          address = url;
          urls.push(url);
          if (bitState.fail) throw Error("offline");
          return { ok: () => bitState.http === 200, status: () => bitState.http };
        },
        url: () => address,
        evaluate: async (fn: any, arg: any) => {
          if (typeof fn !== "string") return undefined; // window-name tag only
          bitReads++;
          return runInNewContext(fn, {
            location: {
              origin: new URL(address).origin,
              pathname: new URL(address).pathname,
            },
            URL, AbortSignal,
            fetch: async (url: string) => ({
              ok: bitState.http === 200, status: bitState.http, url,
              headers: { get: () => "application/json" },
              text: async () => JSON.stringify(bitState.user),
            }),
            document: {
              querySelector: (selector: string) =>
                selector.includes("sign_in") && bitState.user === null
                  ? {}
                  : null,
            },
          });
        },
        bringToFront: async () => {},
        close: async () => {
          closed++;
        },
        isClosed: () => false,
      } as unknown as Page;
    },
  } as unknown as BrowserContext;
  withPageLifecycleFixture(context);
  const bit = {
    keepWindow: async () => {},
    withProfile: async <T>(
      profileId: string,
      action: (ctx: BrowserContext) => Promise<T>,
    ) => {
      assert.equal(profileId, "jianshu-profile");
      return action(context);
    },
  } as unknown as BitBrowser;
  const ports = createBrowserPlatformPorts(native, environments, () => bit);
  const accounts = new WebsiteAccounts(
    db,
    ports,
    () => {},
    environments,
    queue,
  );
  const env = await environments.save({
    name: "简书专用指纹环境",
    engine: "bitbrowser",
    profileId: "jianshu-profile",
  });
  return {
    db,
    ports,
    accounts,
    environments,
    env,
    bitState,
    launches,
    urls,
    get nativeReads() {
      return nativeReads;
    },
    get bitReads() {
      return bitReads;
    },
    get closed() {
      return closed;
    },
    setNative(s: WebsiteSessionState) {
      nativeState = s;
    },
    async close() {
      queue.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("指纹账号查看简书原稿经过真实账号分流，重新核验身份且不回退系统或内置浏览器", async () => {
  const f = await fixture();
  const noteUrl = "https://www.jianshu.com/writer#/notebooks/12/notes/99";
  try {
    const account = f.accounts.add("jianshu", "资料整理", f.env.id);
    assert.deepEqual(await f.accounts.openDocument(account.id, noteUrl), { opened: true, url: noteUrl });
    assert.equal(f.accounts.get(account.id).uid, "abcdef123456");
    assert.equal(f.bitReads, 1, "只读打开也必须fresh核验指纹环境身份");
    assert.equal(f.closed, 1, "身份读者关闭，原稿窗口保留");
    assert.equal(f.urls.filter((url) => url === noteUrl).length, 1);
    assert.equal(f.nativeReads, 0, "不得错误回退到内置文档平台会话");
    f.bitState.user = { slug: "111111aaaaaa", nickname: "其他身份" };
    await assert.rejects(f.accounts.openDocument(account.id, noteUrl), /身份|登录/);
    assert.equal(f.urls.filter((url) => url === noteUrl).length, 1, "错误身份不得再次打开原稿");
    assert.equal(f.nativeReads, 0);
  } finally { await f.close(); }
});

test("简书账号平台可选，默认指纹，官方登录白名单拒绝相似站点与非HTTPS", () => {
  assert.equal(websiteProviderSchema.parse("jianshu"), "jianshu");
  assert.ok(
    otherProviderItems.some((p) => p.value === "jianshu" && p.label === "简书"),
  );
  assert.equal(defaultOtherAccountBrowser("jianshu").fingerprint, true);
  assert.equal(
    websiteLoginSpecs.jianshu.home,
    "https://www.jianshu.com/sign_in",
  );
  for (const url of ["https://www.jianshu.com/sign_in", "https://jianshu.com/"])
    assert.ok(websiteNavigationAllowed("jianshu", url));
  for (const url of [
    "http://www.jianshu.com/",
    "https://www.jianshu.com.evil.test/",
    "https://user:pass@www.jianshu.com/",
    "https://www.jianshu.com:444/",
  ])
    assert.equal(websiteNavigationAllowed("jianshu", url), false);
});

test("简书内置与指纹登录分流：各自读取身份，使用独立环境，查询页按ID关闭", async () => {
  const f = await fixture();
  try {
    const native = f.accounts.add("jianshu", "内置账号");
    const bit = f.accounts.add("jianshu", "指纹账号", f.env.id);
    assert.equal(
      f.environments.forAccount({ kind: "website", id: native.id }).engine,
      "electron",
    );
    assert.equal(
      f.environments.forAccount({ kind: "website", id: bit.id }).profileId,
      "jianshu-profile",
    );
    await f.accounts.login(native.id);
    assert.deepEqual(f.launches, [native.id]);
    const a = await f.accounts.verify(native.id);
    assert.equal(a.uid, "123456789abc");
    assert.equal(a.nickname, "内置简书用户");
    await f.accounts.login(bit.id);
    assert.ok(f.urls.includes("https://www.jianshu.com/sign_in"));
    const b = await f.accounts.verify(bit.id);
    assert.equal(b.uid, "abcdef123456");
    assert.equal(b.nickname, "指纹简书用户");
    assert.equal(b.status, "connected");
    assert.equal(f.nativeReads, 1);
    assert.equal(f.bitReads, 1);
    assert.equal(f.closed, 1);
    assert.equal(f.accounts.get(native.id).uid, a.uid);
  } finally {
    await f.close();
  }
});

test("指纹网络或未知页面不会回退内置/改号；明确退出与错UID阻止后续使用", async () => {
  const f = await fixture();
  try {
    const account = f.accounts.add("jianshu", "指纹账号", f.env.id);
    await f.accounts.verify(account.id);
    f.bitState.fail = true;
    await assert.rejects(f.accounts.verify(account.id), {
      code: "WEBSITE_IDENTITY_UNVERIFIED",
    });
    assert.equal(f.accounts.get(account.id).uid, "abcdef123456");
    assert.equal(f.accounts.get(account.id).unverified, true);
    assert.equal(f.nativeReads, 0);
    await assert.rejects(
      f.accounts.use(account.id, "jianshu", async () => true),
      /未核|登录|身份/,
    );
    f.bitState.fail = false;
    f.bitState.user = undefined;
    await assert.rejects(f.accounts.verify(account.id), {
      code: "WEBSITE_IDENTITY_UNVERIFIED",
    });
    assert.equal(f.accounts.get(account.id).uid, "abcdef123456");
    f.bitState.user = { slug: "123456abcdef", nickname: "其他用户" };
    const wrong = await f.accounts.verify(account.id);
    assert.notEqual(wrong.status, "connected");
    assert.equal(wrong.uid, "abcdef123456");
    assert.match(wrong.message, /其他身份/);
    f.bitState.user = null;
    const loggedOut = await f.accounts.verify(account.id);
    assert.equal(loggedOut.status, "expired");
    assert.equal(loggedOut.uid, "abcdef123456");
    f.bitState.user = { slug: "abcdef123456", nickname: "重登昵称" };
    const again = await f.accounts.verify(account.id);
    assert.equal(again.status, "connected");
    assert.equal(again.nickname, "重登昵称");
    assert.equal(f.nativeReads, 0);
  } finally {
    await f.close();
  }
});

test("显式简书失效观察保留失效状态；作者数据和未知页面不能当登录身份", async () => {
  const expired = {
    hasSession: false,
    uid: null,
    windowOpen: false,
    expired: true,
    error: "重新登录",
  };
  assert.equal(jianshuSessionObservation(expired).expired, true);
  const script = jianshuIdentityScript();
  await assert.rejects(
    () =>
      runInNewContext(script, {
        location: { origin: "https://www.jianshu.com", pathname: "/" },
        window: {
          JS_ENV: { author: { slug: "abcdef123456", nickname: "作者" } },
        },
        URL, AbortSignal,
        fetch: async (url: string) => ({ ok: true, status: 200, url, headers: { get: () => "application/json" }, text: async () => "{}" }),
        document: { querySelector: () => null },
      }),
    /未能确认/,
  );
  await assert.rejects(
    () =>
      runInNewContext(script, {
        location: {
          origin: "https://www.jianshu.com",
          pathname: "/p/abcdef123456",
        },
        window: {
          JS_ENV: { current_user: { slug: "abcdef123456", nickname: "作者" } },
        },
        document: { querySelector: () => null },
      }),
    /身份页面已变化/,
  );
});

test("简书指纹身份查询返回副本，调用者修改观察结果不会污染缓存", async () => {
  const f = await fixture();
  try {
    const account = f.accounts.add("jianshu", "缓存检查", f.env.id);
    const observed = await f.ports.websiteSessions!.verify!(account);
    observed.uid = "caller-mutated";
    observed.hasSession = false;
    const cached = await f.ports.websiteSessions!.status(account);
    assert.equal(cached.uid, "abcdef123456");
    assert.equal(cached.hasSession, true);
    cached.uid = "changed-again";
    assert.equal(
      (await f.ports.websiteSessions!.status(account)).uid,
      "abcdef123456",
    );
  } finally {
    await f.close();
  }
});
