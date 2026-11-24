import { AppError } from "../core/errors";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AccountBatches, type BatchAccount } from "../core/account-batches";
import { Database } from "../core/database";
import { fixture } from "./helpers";
import type { AccountBatch } from "../shared/account-batch";
import type { Account } from "../shared/types";
const input = {
  scope: "drive" as const,
  provider: "quark",
  action: "verify" as const,
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("scheduler timeout");
    await delay(5);
  }
}
async function setup(
  t: TestContext,
  accounts: BatchAccount[],
  perform: (id: string) => Promise<string | null>,
  available = (_id: string) => true,
  stagger = 20,
) {
  const dir = await mkdtemp(join(tmpdir(), "panxu-account-batch-"));
  const db = new Database(join(dir, "batch.db"));
  const map = new Map(accounts.map((a) => [a.id, a]));
  const service = new AccountBatches({
    db,
    changed: () => {},
    resolve: (_scope, id) => {
      const a = map.get(id);
      if (!a) throw Error("account removed");
      return a;
    },
    available,
    perform: (_input, id) => perform(id),
    stagger: () => stagger,
  });
  t.after(async () => {
    service.close();
    db.close();
    await rm(dir, { force: true, recursive: true });
  });
  return { service, db, map };
}
const account = (id: string, key = id): BatchAccount => ({
  id,
  alias: id,
  provider: "quark",
  providerName: "夸克",
  enabled: true,
  environmentId: key,
  key,
});

test("独立环境最多三路并发，启动错峰，共用环境不重叠且不阻塞后面的独立环境", async (t) => {
  const ids = ["a", "a-shared", "b", "c", "d"],
    gates = new Map(ids.map((id) => [id, gate()]));
  const starts: { id: string; time: number }[] = [];
  const active = new Set<string>();
  let peak = 0;
  const accounts = ids.map((id) => account(id, id === "a-shared" ? "a" : id));
  const f = await setup(t, accounts, async (id) => {
    const key = accounts.find((a) => a.id === id)!.key;
    assert.ok(!active.has(key));
    active.add(key);
    peak = Math.max(peak, active.size);
    starts.push({ id, time: Date.now() });
    await gates.get(id)!.promise;
    active.delete(key);
    return null;
  });
  f.service.start({ ...input, accountIds: ids });
  await until(() => starts.length === 3);
  assert.deepEqual(
    starts.map((s) => s.id),
    ["a", "b", "c"],
  );
  assert.equal(peak, 3);
  assert.ok(starts[1].time - starts[0].time >= 15);
  assert.ok(starts[2].time - starts[1].time >= 15);
  gates.get("a")!.resolve();
  await until(() => starts.length === 4);
  assert.equal(starts[3].id, "a-shared");
  for (const g of gates.values()) g.resolve();
  const batch = await f.service.settled();
  assert.equal(batch?.status, "completed");
  assert.ok(batch?.items.every((i) => i.status === "success"));
  assert.equal(peak, 3);
});

test("单个失败不影响其他账号；停止只取消未启动项，已启动操作完成后才释放忙状态", async (t) => {
  const first = gate();
  const starts: string[] = [];
  const f = await setup(
    t,
    [account("a"), account("b"), account("c")],
    async (id) => {
      starts.push(id);
      await first.promise;
      return null;
    },
    undefined,
    200,
  );
  const b = f.service.start({ ...input, accountIds: ["a", "b", "c"] });
  await until(() => starts.length === 1);
  f.service.stop(b.id);
  assert.equal(f.service.isBusy, true);
  assert.deepEqual(
    f.service.current()?.items.map((i) => i.status),
    ["running", "cancelled", "cancelled"],
  );
  first.resolve();
  const finished = await f.service.settled();
  assert.deepEqual(starts, ["a"]);
  assert.equal(finished?.status, "cancelled");
  assert.equal(f.service.isBusy, false);
  const other = await setup(
    t,
    [account("x"), account("y"), account("z")],
    async (id) => {
      if (id === "x") throw Error("fixture login expired");
      return id === "y" ? "会员暂未更新" : null;
    },
  );
  other.service.start({ ...input, accountIds: ["x", "y", "z"] });
  await other.service.settled();
  assert.deepEqual(
    other.service.current()?.items.map((i) => i.status),
    ["failed", "warning", "success"],
  );
});

test("等待外部占用环境时可先运行其他环境，排队账号变化后单独报错", async (t) => {
  let available = false;
  const starts: string[] = [];
  const f = await setup(
    t,
    [account("busy"), account("free")],
    async (id) => {
      starts.push(id);
      return null;
    },
    (id) => id !== "busy" || available,
  );
  f.service.start({ ...input, accountIds: ["busy", "free"] });
  await until(() => starts.includes("free"));
  assert.deepEqual(starts, ["free"]);
  f.map.delete("busy");
  const b = await f.service.settled();
  assert.equal(b?.items[0].status, "failed");
  assert.match(b?.items[0].message ?? "", /removed/);
});

test("同类型校验、去重、并行批次冲突与重启恢复不自动重发", async (t) => {
  const wait = gate();
  const f = await setup(
    t,
    [
      account("a"),
      { ...account("other"), provider: "baidu" },
      { ...account("disabled"), enabled: false },
    ],
    async () => {
      await wait.promise;
      return null;
    },
  );
  assert.throws(
    () => f.service.start({ ...input, accountIds: ["a", "other"] }),
    { code: "ACCOUNT_BATCH_PROVIDER" },
  );
  assert.throws(() => f.service.start({ ...input, accountIds: ["disabled"] }), {
    code: "ACCOUNT_DISABLED",
  });
  assert.throws(
    () =>
      f.service.start({
        ...input,
        scope: "other",
        action: "refresh",
        accountIds: ["a"],
      }),
    { code: "ACCOUNT_BATCH_ACTION" },
  );
  const b = f.service.start({ ...input, accountIds: ["a", "a"] });
  assert.equal(b.items.length, 1);
  assert.throws(() => f.service.start({ ...input, accountIds: ["a"] }), {
    code: "ACCOUNT_BATCH_BUSY",
  });
  wait.resolve();
  await f.service.settled();
  f.db.setSetting("account-batch:current", {
    ...b,
    status: "running",
    items: b.items.map((i) => ({ ...i, status: "running" })),
  });
  let reruns = 0;
  const recovered = new AccountBatches({
    db: f.db,
    resolve: () => account("a"),
    available: () => true,
    perform: async () => {
      reruns++;
      return null;
    },
    changed: () => {},
  });
  assert.equal(recovered.current()?.status, "interrupted");
  assert.equal(recovered.current()?.items[0].status, "cancelled");
  assert.equal(reruns, 0);
  recovered.close();
});

test("真实应用IPC批量调用原网盘核验接口，账号身份独立、容量会员结果持久化", async () => {
  const f = await fixture();
  try {
    const second = (await f.app.invoke("account.add", {
      provider: "quark",
      alias: "第二夸克",
    })) as Account;
    const starts: string[] = [];
    let active = 0,
      peak = 0;
    Object.assign(f.provider, {
      identity: async (a: Account) => ({
        uid: a.id === f.account.id ? "owner-1" : a.id,
        nickname: a.alias,
      }),
      capacity: async (a: Account) => {
        starts.push(a.id);
        active++;
        peak = Math.max(peak, active);
        await delay(1250);
        active--;
        return { totalBytes: 1000, usedBytes: 10 };
      },
      membership: async () => ({ status: "none", tier: null, expiresAt: null }),
    });
    const batch = (await f.app.invoke("accountBatch.start", {
      ...input,
      accountIds: [f.account.id, second.id],
    })) as AccountBatch;
    assert.equal(batch.items.length, 2);
    assert.equal(f.app.accountBatches.isBusy, true);
    const result = await f.app.accountBatches.settled();
    assert.equal(peak, 2);
    assert.equal(starts.length, 2);
    assert.ok(result?.items.every((i) => i.status === "success"));
    assert.equal(
      f.app.repo.getAccount(second.id).membership?.value?.status,
      "none",
    );
    Object.assign(f.provider, {
      capacity: async () => {
        throw new AppError("AUTH_EXPIRED", "fixture容量接口登录失效");
      },
    });
    await f.app.invoke("accountBatch.start", {
      ...input,
      action: "refresh",
      accountIds: [f.account.id],
    });
    const expired = await f.app.accountBatches.settled();
    assert.equal(expired?.items[0].status, "failed");
    assert.match(expired?.items[0].message ?? "", /登录失效/);
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
  } finally {
    await f.cleanup();
  }
});

test("其他账号批次按平台走原核验入口，网站与知道都返回逐项结果", async () => {
  const f = await fixture();
  try {
    const websites = [
      f.app.websiteAccounts.add("tieba", "贴吧一"),
      f.app.websiteAccounts.add("tieba", "贴吧二"),
    ];
    const checked: string[] = [];
    Object.assign(f.app.websiteAccounts, {
      verify: async (id: string) => {
        checked.push(id);
        return {
          ...f.app.websiteAccounts.get(id),
          status: "connected",
          unverified: false,
        };
      },
    });
    await f.app.invoke("accountBatch.start", {
      scope: "other",
      provider: "tieba",
      action: "verify",
      accountIds: websites.map((a) => a.id),
    });
    const done = await f.app.accountBatches.settled();
    assert.ok(done?.items.every((i) => i.status === "success"));
    assert.equal(checked.length, 2);
    const z = (await f.app.invoke("zhidao.account.add", {
      alias: "知道一",
    })) as { id: string };
    let checkedZ = false;
    Object.assign(f.app.zhidao, {
      check: async (id: string) => {
        assert.equal(id, z.id);
        checkedZ = true;
        return { ...f.app.zhidao.store.account(id), status: "connected" };
      },
    });
    await f.app.invoke("accountBatch.start", {
      scope: "other",
      provider: "baidu-zhidao",
      action: "verify",
      accountIds: [z.id],
    });
    assert.equal(
      (await f.app.accountBatches.settled())?.items[0].status,
      "success",
    );
    assert.equal(checkedZ, true);
  } finally {
    await f.cleanup();
  }
});
