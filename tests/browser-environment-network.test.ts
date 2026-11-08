import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../core/database";
import { SecretStore } from "../core/secrets";
import { BrowserEnvironments } from "../core/browser-environments";
import { WebsiteAccounts } from "../core/website-accounts";
import type { AppPorts } from "../core/ports";
import type { BrowserEnvironment } from "../shared/browser-environments";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "panxu-environment-network-"));
  const db = new Database(join(dir, "test.db"));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ips = new Map<string, string>();
  let failure = "";
  const network = async (id: string) => {
    if (failure) throw new Error(failure);
    return ips.get(id) ?? "203.0.113.10";
  };
  const ports = {
    browserEnvironments: {
      prepare: async () => {},
      assertIdle: async () => {},
      checkNetwork: async (env: BrowserEnvironment) => network(env.profileId),
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
    ports,
    dir,
    () => {},
  );
  db.setSetting("bitUrl", "http://127.0.0.1:54345");
  environments.setExternalConfigurationReader(async () => ({
    signature: "stable-fixture-config",
    proxy: "configured",
    stopWhileNetError: true,
  }));
  environments.setExternalNetworkChecker(network);
  const accounts = new WebsiteAccounts(db, ports, () => {}, environments);
  let sequence = 0;
  const add = async (engine: BrowserEnvironment["engine"] = "bitbrowser") => {
    const n = ++sequence;
    return environments.save({
      name: `环境 ${n}`,
      engine,
      ...(engine === "bitbrowser"
        ? { profileId: `network-profile-${n}` }
        : {
            proxy: {
              mode: "http" as const,
              host: "127.0.0.1",
              port: 18000 + n,
            },
          }),
      requireProxy: true,
    });
  };
  return {
    environments,
    accounts,
    ips,
    add,
    setFailure(message: string) {
      failure = message;
    },
  };
}

test("同一出口允许三个内置或比特环境，第四个停止且已有环境可重复核验", async (t) => {
  const f = await fixture(t);
  const envs = [
    await f.add("electron"),
    await f.add(),
    await f.add("electron"),
    await f.add(),
  ];
  for (const env of envs.slice(0, 3))
    assert.equal(
      (await f.environments.checkNetwork(env.id)).network?.ip,
      "203.0.113.10",
    );
  for (const env of envs.slice(0, 3)) await f.environments.checkNetwork(env.id);
  let ran = false;
  await assert.rejects(
    f.environments.runEnvironment(envs[3].id, "capacity", async () => {
      ran = true;
    }),
    {
      code: "ENVIRONMENT_IP_DUPLICATE",
      message: /已有 3 个浏览器环境使用，最多支持 3 个/,
    },
  );
  assert.equal(ran, false);
  assert.equal(f.environments.get(envs[3].id).network, undefined);
});

test("同一环境关联多个平台账号只占用一个出口名额", async (t) => {
  const f = await fixture(t);
  const shared = await f.add();
  f.accounts.add("tieba", "贴吧", shared.id);
  f.accounts.add("weibo", "微博", shared.id);
  f.accounts.add("zhihu", "知乎", shared.id);
  assert.equal(
    f.environments.list().find((e) => e.id === shared.id)?.accounts.length,
    3,
  );
  await f.environments.checkNetwork(shared.id);
  await f.environments.checkNetwork((await f.add()).id);
  await f.environments.checkNetwork((await f.add()).id);
  await assert.rejects(f.environments.checkNetwork((await f.add()).id), {
    code: "ENVIRONMENT_IP_DUPLICATE",
  });
});

test("四个环境并发检查同一出口时仅三个通过", async (t) => {
  const f = await fixture(t);
  const envs = await Promise.all(Array.from({ length: 4 }, () => f.add()));
  const results = await Promise.allSettled(
    envs.map((env) => f.environments.checkNetwork(env.id)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "ENVIRONMENT_IP_DUPLICATE");
  assert.equal(
    f.environments.list().filter((e) => e.network?.ip === "203.0.113.10")
      .length,
    3,
  );
});

test("更换出口或移除环境会释放旧出口名额", async (t) => {
  const f = await fixture(t);
  const envs = await Promise.all(Array.from({ length: 5 }, () => f.add()));
  for (const env of envs.slice(0, 3)) await f.environments.checkNetwork(env.id);
  f.ips.set(envs[0].profileId, "203.0.113.11");
  const moved = await f.environments.checkNetwork(envs[0].id);
  assert.equal(moved.network?.ip, "203.0.113.11");
  assert.equal(moved.network?.revision, moved.revision);
  await f.environments.checkNetwork(envs[3].id);
  await assert.rejects(f.environments.checkNetwork(envs[4].id), {
    code: "ENVIRONMENT_IP_DUPLICATE",
  });
  await f.environments.remove(envs[1].id);
  assert.equal(
    (await f.environments.checkNetwork(envs[4].id)).network?.ip,
    "203.0.113.10",
  );
});

test("被容量限制阻止的环境保留原出口记录，未知出口和代理失败仍停止操作", async (t) => {
  const f = await fixture(t);
  const envs = await Promise.all(Array.from({ length: 4 }, () => f.add()));
  for (const env of envs.slice(0, 3)) await f.environments.checkNetwork(env.id);
  f.ips.set(envs[3].profileId, "203.0.113.11");
  const previous = (await f.environments.checkNetwork(envs[3].id)).network;
  f.ips.set(envs[3].profileId, "203.0.113.10");
  await assert.rejects(f.environments.checkNetwork(envs[3].id), {
    code: "ENVIRONMENT_IP_DUPLICATE",
  });
  assert.deepEqual(f.environments.get(envs[3].id).network, previous);
  let actions = 0;
  f.ips.set(envs[3].profileId, "invalid-ip");
  await assert.rejects(
    f.environments.runEnvironment(envs[3].id, "read", async () => {
      actions++;
    }),
    { code: "ENVIRONMENT_NETWORK_UNKNOWN" },
  );
  f.setFailure("代理不可达");
  await assert.rejects(
    f.environments.runEnvironment(envs[0].id, "read", async () => {
      actions++;
    }),
    /代理不可达/,
  );
  assert.equal(actions, 0);
  assert.deepEqual(f.environments.get(envs[3].id).network, previous);
});
