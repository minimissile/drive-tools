import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture } from "./helpers";
import { Database } from "../core/database";
import { Repository } from "../core/repository";
import { AppError } from "../core/errors";
import { normalizeCapacity } from "../core/providers/capacity";
import { QuarkProvider } from "../core/providers/quark";
import { UcProvider } from "../core/providers/uc";
import { BaiduProvider } from "../core/providers/baidu";
import { XunleiProvider } from "../core/providers/xunlei";
import { capacitySummary, formatCapacity } from "../shared/drive-capacity";
import { providerApiAllowed } from "../shared/providers";
import type { Account } from "../shared/types";
import type { ProviderTransport } from "../core/providers/provider";

test("容量支持整数字节与数字字符串，未知不冒充0，超额仍保留实值", () => {
  assert.deepEqual(normalizeCapacity("1099511627776", "0"), {
    totalBytes: 2 ** 40,
    usedBytes: 0,
  });
  for (const bad of [
    undefined,
    null,
    "",
    "-1",
    -1,
    true,
    "1.2",
    1.2,
    Infinity,
    "NaN",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => normalizeCapacity(bad, 0), /容量/);
    assert.throws(() => normalizeCapacity(1, bad), /容量/);
  }
  assert.deepEqual(capacitySummary(normalizeCapacity(100, 120)), {
    remainingBytes: 0,
    percent: 100,
    full: true,
    overLimit: true,
  });
  assert.equal(capacitySummary(normalizeCapacity(0, 0)).percent, 0);
  assert.equal(formatCapacity(0), "0 B");
  assert.equal(formatCapacity(1024 ** 4), "1 TB");
});

test("四家网盘使用各自官方容量字段、隔离账号及只读请求", async () => {
  const calls: { accountId: string; url: URL; method: string }[] = [];
  const transport: ProviderTransport = {
    async text() {
      return "";
    },
    async authHeaders() {
      return { authorization: "Bearer fixture-only" };
    },
    async json(accountId, url, init) {
      const u = new URL(url);
      calls.push({ accountId, url: u, method: init?.method ?? "GET" });
      if (u.pathname.endsWith("/member"))
        return {
          code: 0,
          status: 200,
          data: {
            total_capacity: "2199023255552",
            use_capacity: "1073741824",
            secret_use_capacity: 999,
          },
        };
      if (u.pathname === "/api/quota")
        return { errno: 0, total: 2199023255552, used: 1073741824 };
      if (u.pathname.endsWith("/about"))
        return { quota: { limit: "2199023255552", usage: "1073741824" } };
      throw new Error(`Unexpected request: ${u.pathname}`);
    },
  };
  for (const p of [
    new QuarkProvider(transport),
    new UcProvider(transport),
    new BaiduProvider(transport),
    new XunleiProvider(transport),
  ]) {
    const a = { id: `account-${p.id}`, provider: p.id } as Account;
    assert.deepEqual(await p.capacity(a), {
      totalBytes: 2 ** 41,
      usedBytes: 2 ** 30,
    });
    const call = calls.at(-1)!;
    assert.equal(call.accountId, a.id);
    assert.equal(call.method, "GET");
    assert.ok(providerApiAllowed(p.id, call.url.href));
  }
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url.hostname, "drive-pc.quark.cn");
  assert.equal(calls[1].url.hostname, "pc-api.uc.cn");
});

test("容量读取持久化、同账号并发合并；断网保留上次数据和登录状态", async () => {
  const f = await fixture();
  try {
    let count = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = Object.assign(f.provider, {
      async capacity() {
        count++;
        await gate;
        return { totalBytes: 1000, usedBytes: 200 };
      },
    });
    const pending = [
      f.app.invoke("account.capacity", { id: f.account.id }),
      f.app.invoke("account.capacity", { id: f.account.id }),
    ];
    release();
    const [a, b] = (await Promise.all(pending)) as Account[];
    assert.equal(count, 1);
    assert.deepEqual(a.capacity, b.capacity);
    assert.equal(a.capacity?.value?.usedBytes, 200);
    const db = new Database(join(f.dir, "panxu.db"));
    try {
      assert.deepEqual(
        new Repository(db).getAccount(f.account.id).capacity,
        a.capacity,
      );
    } finally {
      db.close();
    }
    provider.capacity = async () => {
      throw new Error("网络暂不可用");
    };
    const failed = (await f.app.invoke("account.capacity", {
      id: f.account.id,
    })) as Account;
    assert.equal(failed.status, "connected");
    assert.deepEqual(failed.capacity?.value, a.capacity?.value);
    assert.equal(failed.capacity?.updatedAt, a.capacity?.updatedAt);
    assert.match(failed.capacity?.error ?? "", /网络暂不可用/);
    provider.identity = async () => {
      throw new Error("身份接口连接中断");
    };
    await assert.rejects(
      f.app.invoke("account.capacity", { id: f.account.id }),
      /连接中断/,
    );
    const disconnected = f.app.repo.getAccount(f.account.id);
    assert.equal(disconnected.status, "connected");
    assert.deepEqual(disconnected.capacity?.value, a.capacity?.value);
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
  } finally {
    await f.cleanup();
  }
});

test("核验登录顺带更新容量，容量接口失败不阻止身份核验，身份变化禁止读取", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const p = Object.assign(f.provider, {
      async capacity() {
        reads++;
        return { totalBytes: 100, usedBytes: 10 };
      },
    });
    const checked = (await f.app.invoke("account.check", {
      id: f.account.id,
    })) as Account;
    assert.equal(checked.capacity?.value?.totalBytes, 100);
    p.capacity = async () => {
      reads++;
      throw new AppError("CAPACITY_UNAVAILABLE", "暂未返回容量");
    };
    const partial = (await f.app.invoke("account.check", {
      id: f.account.id,
    })) as Account;
    assert.equal(partial.status, "connected");
    assert.equal(partial.capacity?.value?.totalBytes, 100);
    assert.match(partial.capacity?.error ?? "", /暂未返回/);
    p.uid = "different-user";
    await assert.rejects(
      f.app.invoke("account.capacity", { id: f.account.id }),
      /UID与原账号不同/,
    );
    assert.equal(reads, 2);
    assert.equal(
      f.app.repo.getAccount(f.account.id).capacity?.ownerUid,
      "owner-1",
    );
    assert.equal(f.app.repo.getAccount(f.account.id).status, "expired");
    // Mismatched or damaged cached values can never be shown on another UID.
    f.app.db.setSetting(`account:capacity:${f.account.id}`, {
      ...checked.capacity,
      ownerUid: "different-user",
    });
    assert.equal(f.app.repo.getAccount(f.account.id).capacity, null);
    f.app.db.setSetting(`account:capacity:${f.account.id}`, {
      ...checked.capacity,
      value: { totalBytes: null, usedBytes: 0 },
    });
    assert.equal(f.app.repo.getAccount(f.account.id).capacity, null);
  } finally {
    await f.cleanup();
  }
});

test("容量认证过期明确失效，停用账号不查询；不同账号不混用容量", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const p = Object.assign(f.provider, {
      async capacity(a: Account) {
        reads++;
        return { totalBytes: 200, usedBytes: a.id === f.account.id ? 20 : 30 };
      },
    });
    await f.app.invoke("account.capacity", { id: f.account.id });
    const second = (await f.app.invoke("account.add", {
      provider: "quark",
      alias: "另一个账号",
    })) as Account;
    p.identity = async (a) => ({
      uid: a.id === second.id ? "owner-2" : "owner-1",
      nickname: "",
    });
    const secondResult = (await f.app.invoke("account.check", {
      id: second.id,
    })) as Account;
    assert.equal(secondResult.capacity?.value?.usedBytes, 30);
    assert.equal(
      f.app.repo.getAccount(f.account.id).capacity?.value?.usedBytes,
      20,
    );
    p.capacity = async () => {
      throw new AppError("AUTH_EXPIRED", "网盘会话已过期");
    };
    const expired = (await f.app.invoke("account.capacity", {
      id: f.account.id,
    })) as Account;
    assert.equal(expired.status, "expired");
    assert.equal(expired.capacity?.value?.usedBytes, 20);
    assert.match(expired.capacity?.error ?? "", /会话已过期/);
    await f.app.invoke("account.update", {
      id: second.id,
      alias: second.alias,
      defaultDirectory: "/盘序资源",
      enabled: false,
    });
    await assert.rejects(
      f.app.invoke("account.capacity", { id: second.id }),
      /停用/,
    );
    assert.equal(reads, 2);
  } finally {
    await f.cleanup();
  }
});

test("账号副本数覆盖超过500份资源，不随加载上限和当前选择改变", async () => {
  const f = await fixture();
  try {
    const ids = [];
    for (let i = 0; i < 503; i++)
      ids.push(
        (
          await f.add(false, {
            sourceText: `https://pan.quark.cn/s/fixture${i}`,
            title: `资料${i}`,
          })
        ).resourceId,
      );
    const first = f.app.snapshot(ids[0]),
      second = f.app.snapshot(ids.at(-1));
    assert.ok(first.resources.length < 503);
    assert.equal(first.accounts[0].resourceCopies, 503);
    assert.equal(second.accounts[0].resourceCopies, 503);
  } finally {
    await f.cleanup();
  }
});
