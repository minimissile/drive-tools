import { withPageLifecycleFixture } from "./browser-page-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Page } from "playwright-core";
import type { BitBrowser } from "../core/bitbrowser";
import type { BrowserEnvironments } from "../core/browser-environments";
import { DriveBrowserSessions } from "../core/drive-browser-sessions";
import { fixture } from "./helpers";
import type { EnvironmentStamp } from "../shared/browser-environments";

test("20条同批请求只连接一次比特并读取一次身份；退出批次后不复用缓存，环境变化即阻止发送", async () => {
  const f = await fixture();
  const accountId = "scope-account",
    envId = "scope-env";
  let connections = 0,
    prepares = 0,
    identities = 0,
    posts = 0,
    revision = 1;
  const env = {
    id: envId,
    engine: "bitbrowser",
    profileId: "profile",
    requireProxy: true,
    externalSignature: "fixed",
    network: { ip: "127.0.0.2" },
  };
  const stamp = (): EnvironmentStamp => ({
    environmentId: envId,
    revision,
    identityId: "identity",
    identityRevision: 1,
  });
  const page = {
    url: () => "https://pan.baidu.com/disk/main",
    isClosed: () => false,
    evaluate: async (_fn: unknown, arg: unknown) => {
      if (typeof arg === "string") return true;
      const input = arg as { url: string };
      if (new URL(input.url).pathname === "/api/gettemplatevariable") {
        identities++;
        return {
          status: 200,
          body: JSON.stringify({
            errno: 0,
            result: {
              uk: "777",
              bdstoken: "fixture-only",
              username: "资料账号",
            },
          }),
        };
      }
      posts++;
      return {
        status: 200,
        body: JSON.stringify({
          errno: 0,
          shareid: posts,
          link: `https://pan.baidu.com/s/variant${posts}`,
        }),
      };
    },
  } as unknown as Page;
  const context = withPageLifecycleFixture({ pages: () => [page] } as unknown as BrowserContext);
  try {
    f.app.db.run(
      "INSERT INTO accounts(id,provider,alias,uid,status,created_at,updated_at) VALUES(?,'baidu','资料账号','777','connected',datetime('now'),datetime('now'))",
      accountId,
    );
    f.app.db.setSetting(`drive-browser-mode:${accountId}`, "bitbrowser");
    f.app.db.setSetting(`drive-browser:${accountId}`, {
      environmentId: envId,
      profileId: "profile",
      uid: "777",
      connectorKey: f.app.db.setting("bitUrl", ""),
      signature: "fixed",
      exitIp: "127.0.0.2",
      requireProxy: true,
    });
    const sessions = new DriveBrowserSessions({
      repo: f.app.repo,
      bit: {
        withDriveProfile: async (
          _id: string,
          headful: boolean,
          action: (c: BrowserContext) => unknown,
        ) => {
          assert.equal(headful, false);
          connections++;
          return action(context);
        },
      } as unknown as BitBrowser,
      environments: {
        forAccount: () => env,
        get: () => env,
        runEnvironment: async (
          _id: string,
          _owner: string,
          action: () => unknown,
        ) => {
          prepares++;
          return action();
        },
        confirm: () => {},
        stamp,
        assertStamp: (_ref: unknown, expected: EnvironmentStamp) =>
          assert.deepEqual(stamp(), expected, "环境印记变化应被阻止"),
      } as unknown as BrowserEnvironments,
      locked: async (_id, action) => action(),
      assertIdle: () => {},
      changed: () => {},
    });
    const identity =
      "https://pan.baidu.com/api/gettemplatevariable?fields=%5B%22uk%22%2C%22bdstoken%22%2C%22username%22%5D";
    await sessions.withRequestSession(accountId, async () => {
      for (let i = 0; i < 20; i++) {
        await sessions.request(accountId, identity);
        await sessions.request(accountId, identity);
        await sessions.request(accountId, "https://pan.baidu.com/share/set", {
          method: "POST",
          body: "fid_list=[1]",
        });
      }
      await assert.rejects(
        () => sessions.request("different-account", identity),
        /不能切换/,
      );
    });
    assert.equal(connections, 1);
    assert.equal(prepares, 1);
    assert.equal(identities, 1);
    assert.equal(posts, 20);
    await sessions.withRequestSession(accountId, async () => {
      revision++;
      await assert.rejects(
        () =>
          sessions.request(accountId, "https://pan.baidu.com/share/set", {
            method: "POST",
          }),
        /环境印记变化/,
      );
    });
    assert.equal(connections, 2);
    assert.equal(identities, 2);
    assert.equal(posts, 20);
    await sessions.request(accountId, identity);
    assert.equal(connections, 3);
    assert.equal(identities, 4, "未持有批次时必须重新核实身份");
  } finally {
    await f.cleanup();
  }
});
