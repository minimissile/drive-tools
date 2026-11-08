import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../core/database";
import { SecretStore } from "../core/secrets";
import { BrowserEnvironments } from "../core/browser-environments";
import { BrowserEnvironmentQueue } from "../core/browser-environment-queue";
import { WebsiteAccounts } from "../core/website-accounts";
import { createBrowserPlatformPorts } from "../core/browser-platform-ports";
import type { AppPorts } from "../core/ports";
import type { BitBrowser } from "../core/bitbrowser";
import type {
  WebsiteProvider,
  WebsiteSessionState,
} from "../shared/website-accounts";

async function fixture(provider: WebsiteProvider = "tieba") {
  const dir = await mkdtemp(join(tmpdir(), "website-session-cache-")),
    db = new Database(join(dir, "test.db"));
  const checkedAt = "2026-11-07T02:00:00.000Z";
  const known: WebsiteSessionState = {
    hasSession: true,
    uid: "111",
    nickname: "原账号",
    checkedAt,
    windowOpen: false,
    error: null,
  };
  const native = {
    browserEnvironments: {
      prepare: async () => {},
      assertIdle: async () => {},
      checkNetwork: async () => "203.0.113.10",
    },
    websiteSessions: {
      status: async () => ({ ...known }),
      verify: async () => ({ ...known }),
      login: async () => {},
      invalidate: async () => {},
      clear: async () => {},
      isOpen: () => false,
    },
  } as unknown as AppPorts;
  const secrets = new SecretStore(db, {
    available: () => true,
    encrypt: async (value) => value,
    decrypt: async (value) => value,
  });
  const environments = new BrowserEnvironments(
    db,
    secrets,
    native,
    dir,
    () => {},
  );
  environments.setExternalNetworkChecker(async () => "203.0.113.10");
  const queue = new BrowserEnvironmentQueue(db, environments, () => {});
  const environment = await environments.save({
    name: "冷启动会话环境",
    engine: "bitbrowser",
    profileId: "session-cache-fixture",
  });
  const previous = new WebsiteAccounts(
    db,
    native,
    () => {},
    environments,
    queue,
  );
  const account = previous.add(provider, "最后已核实账号", environment.id);
  await previous.verify(account.id);
  let profileCalls = 0;
  let cookieSession = false;
  const bit = {
    withProfile: async (
      _id: string,
      action: (context: unknown) => Promise<unknown>,
    ) => {
      profileCalls++;
      if (!cookieSession) throw Error("身份网络读取失败");
      return action({
        cookies: async () => [
          { name: "CPTK_3", value: "fixture-token" },
          { name: "CPID_3", value: "111" },
        ],
      });
    },
  } as unknown as BitBrowser;
  // Rebuilding these ports recreates the empty in-memory cache, just as a backend restart does.
  const ports = createBrowserPlatformPorts(native, environments, () => bit);
  const accounts = new WebsiteAccounts(
    db,
    ports,
    () => {},
    environments,
    queue,
  );
  return {
    db,
    ports,
    accounts,
    environments,
    queue,
    account,
    known,
    get profileCalls() {
      return profileCalls;
    },
    set cookieSession(value: boolean) {
      cookieSession = value;
    },
    async close() {
      queue.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("website冷启动：cache miss是未核实，普通list保留最后已知连接和时间且不请求网络", async () => {
  const f = await fixture();
  try {
    const before = f.accounts.get(f.account.id),
      stamp = f.environments.stamp({ kind: "website", id: f.account.id });
    const raw = await f.ports.websiteSessions!.status(before);
    assert.equal(raw.unverified, true);
    assert.equal(raw.hasSession, false);
    const view = (await f.accounts.list())[0];
    assert.equal(view.unverified, true);
    assert.equal(view.status, "connected");
    assert.equal(view.uid, "111");
    assert.equal(view.checkedAt, f.known.checkedAt);
    assert.match(view.message, /检查登录|核实/);
    assert.deepEqual(f.accounts.get(f.account.id), before);
    assert.deepEqual(
      f.environments.stamp({ kind: "website", id: f.account.id }),
      stamp,
    );
    assert.equal(f.profileCalls, 0);
  } finally {
    await f.close();
  }
});

test("website未核实不授予业务权限：即便保留connected，非fresh的use也必须拒绝", async () => {
  const f = await fixture("baidu-marketing");
  let used = false;
  try {
    await assert.rejects(
      f.accounts.use(f.account.id, "baidu-marketing", async () => {
        used = true;
      }),
      { code: "WEBSITE_LOGIN_REQUIRED" },
    );
    assert.equal(used, false);
    assert.equal(f.accounts.get(f.account.id).status, "connected");
    assert.equal(f.profileCalls, 0);
  } finally {
    await f.close();
  }
});

test("website明确失效：fresh verify的真实退出证据仍持久降级，保留原UID不换号", async () => {
  const f = await fixture();
  try {
    f.ports.websiteSessions!.verify = async () => ({
      hasSession: false,
      uid: null,
      expired: true,
      windowOpen: false,
      error: "官网当前未登录",
      checkedAt: "2026-11-07T02:10:00.000Z",
    });
    const result = await f.accounts.verify(f.account.id);
    assert.equal(result.status, "expired");
    assert.equal(result.unverified, undefined);
    assert.equal(f.accounts.get(f.account.id).status, "expired");
    assert.equal(result.uid, "111");
    assert.equal(result.checkedAt, "2026-11-07T02:10:00.000Z");
  } finally {
    await f.close();
  }
});

test("website身份不符：fresh或普通已观察到异UID都不能被unknown标记掩盖", async () => {
  for (const fresh of [true, false]) {
    const f = await fixture();
    try {
      const state = {
        hasSession: true,
        uid: "222",
        windowOpen: false,
        error: null,
        unverified: !fresh,
        checkedAt: "2026-11-07T02:10:00.000Z",
      };
      if (fresh) f.ports.websiteSessions!.verify = async () => state;
      else f.ports.websiteSessions!.status = async () => state;
      const result = fresh
        ? await f.accounts.verify(f.account.id)
        : (await f.accounts.list())[0];
      assert.equal(result.status, "disconnected");
      assert.equal(result.uid, "111");
      assert.equal(result.unverified, undefined);
      assert.match(result.message, /其他身份/);
      assert.equal(
        f.environments.link({ kind: "website", id: f.account.id }).uid,
        "111",
      );
    } finally {
      await f.close();
    }
  }
});

test("website已观察到退出的普通status仍降级，明确负证据不当成冷cache", async () => {
  const f = await fixture();
  try {
    f.ports.websiteSessions!.status = async () => ({
      hasSession: false,
      uid: null,
      windowOpen: false,
      error: "已退出",
    });
    assert.equal((await f.accounts.list())[0].status, "disconnected");
    assert.equal(f.accounts.get(f.account.id).status, "disconnected");
  } finally {
    await f.close();
  }
});

test("website环境修订变化只使缓存未核实，不污染缓存或冒充新的身份核验", async () => {
  const f = await fixture();
  try {
    const cached = { ...f.known };
    f.ports.websiteSessions!.status = async () => cached;
    f.environments.invalidateIdentity({ kind: "website", id: f.account.id });
    const before = f.accounts.get(f.account.id),
      view = (await f.accounts.list())[0];
    assert.equal(view.unverified, true);
    assert.equal(view.status, "connected");
    assert.equal(
      f.environments.identityCurrent({ kind: "website", id: f.account.id }),
      false,
    );
    assert.equal(cached.hasSession, true);
    assert.deepEqual(f.accounts.get(f.account.id), before);
    f.ports.websiteSessions!.verify = async () => ({
      ...f.known,
      checkedAt: "2026-11-07T02:10:00.000Z",
    });
    assert.equal((await f.accounts.verify(f.account.id)).status, "connected");
    assert.equal(
      f.environments.identityCurrent({ kind: "website", id: f.account.id }),
      true,
    );
  } finally {
    await f.close();
  }
});

test("website fresh verify返回未知不能伪造本次核验或新的写入资格", async () => {
  const f = await fixture();
  try {
    const before = f.accounts.get(f.account.id);
    f.ports.websiteSessions!.verify = async () => ({
      unverified: true,
      hasSession: false,
      uid: null,
      windowOpen: false,
      error: "身份读取尚未完成",
    });
    await assert.rejects(f.accounts.verify(f.account.id), {
      code: "WEBSITE_IDENTITY_UNVERIFIED",
    });
    assert.deepEqual(f.accounts.get(f.account.id), before);
  } finally {
    await f.close();
  }
});

test("website fresh核验异常清除旧正向cache，仅保留历史状态且不能继续非fresh业务", async () => {
  const f = await fixture("baidu-marketing");
  try {
    f.cookieSession = true;
    await f.accounts.verify(f.account.id);
    assert.equal((await f.accounts.list())[0].unverified, undefined);
    f.cookieSession = false;
    await assert.rejects(f.accounts.verify(f.account.id), /身份网络读取失败/);
    const view = (await f.accounts.list())[0];
    assert.equal(view.unverified, true);
    assert.equal(view.status, "connected");
    assert.equal(view.checkedAt, f.known.checkedAt);
    let used = false;
    await assert.rejects(
      f.accounts.use(f.account.id, "baidu-marketing", async () => {
        used = true;
      }),
      { code: "WEBSITE_LOGIN_REQUIRED" },
    );
    assert.equal(used, false);
  } finally {
    await f.close();
  }
});
