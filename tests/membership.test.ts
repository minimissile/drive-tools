import { AppError } from "../core/errors";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import {
  baiduMembership,
  cmccMembership,
  guangyaMembership,
  membershipExpiry,
  pikpakMembership,
  quarkMembership,
  xunleiMembership,
} from "../core/providers/membership";
import { membershipStatus } from "../shared/drive-membership";
import { BaiduProvider } from "../core/providers/baidu";
import { QuarkProvider } from "../core/providers/quark";
import { UcProvider } from "../core/providers/uc";
import { XunleiProvider } from "../core/providers/xunlei";
import { PikPakProvider } from "../core/providers/pikpak";
import { GuangyaProvider } from "../core/providers/guangya";
import type { ProviderTransport } from "../core/providers/provider";
import type { Account } from "../shared/types";
const time = Date.parse("2026-11-23T12:00:00+08:00"),
  end = Date.parse("2026-12-10T00:00:00+08:00");

test("移动云盘仅使用会员有效期，账单和云空间期限不冒充会员期限", () => {
  const member = {
    memberLevel: 2,
    memberLvName: "超级会员",
    chargingPolicyList: [
      { prodName: "月付套餐", endTime: "2038-01-19 00:00:00" },
    ],
  };
  assert.deepEqual(cmccMembership({ userSubMemberList: [member] }, time), {
    status: "active",
    tier: "超级会员",
    expiresAt: null,
  });
  assert.equal(
    cmccMembership(
      {
        userSubMemberList: [
          { ...member, chargingPolicyList: [{ expiredTime: "2026-12-10" }] },
        ],
      },
      time,
    ).expiresAt,
    "2026-12-10T15:59:59.000Z",
  );
  assert.equal(
    cmccMembership(
      {
        userSubMemberList: [
          { ...member, chargingPolicyList: [{ expiredTime: "2026-11-01" }] },
        ],
      },
      time,
    ).status,
    "expired",
  );
  assert.equal(cmccMembership({ userSubMemberList: [] }, time).status, "none");
  assert.equal(
    cmccMembership({ userSubMemberList: [{ memberLevel: false }] }, time)
      .status,
    "unknown",
  );
  assert.throws(() => cmccMembership({}, time), {
    code: "MEMBERSHIP_UNAVAILABLE",
  });
});

test("移动云盘真实订购字段的14位北京时间不会按毫秒解释", () => {
  const now = Date.parse("2026-11-25T12:00:00+08:00");
  const member = {
    memberLevel: 1,
    memberLvName: "白银会员",
    chargingPolicyList: [
      {
        prodName: "白银会员",
        effectiveTime: "20261124235232",
        expiredTime: "20270224235232",
      },
    ],
  };
  assert.deepEqual(cmccMembership({ userSubMemberList: [member] }, now), {
    status: "active",
    tier: "白银会员",
    expiresAt: "2027-02-24T15:52:32.000Z",
  });
  for (const expiredTime of [
    "20270230235232",
    "20270224245232",
    "20270224236032",
    "永久",
    null,
  ]) {
    const row = { ...member, chargingPolicyList: [{ expiredTime }] };
    assert.equal(
      cmccMembership({ userSubMemberList: [row] }, now).expiresAt,
      null,
    );
  }
  const upcoming = {
    expiredTime: "20280324235232",
    effectiveTime: "20280301000000",
  };
  const both = {
    ...member,
    chargingPolicyList: [...member.chargingPolicyList, upcoming],
  };
  assert.equal(
    cmccMembership({ userSubMemberList: [both] }, now).expiresAt,
    "2027-02-24T15:52:32.000Z",
  );
});

test("会员到期时间支持秒、毫秒、带时区时间及国内日期；未知和坏日期不冒充永久", () => {
  for (const raw of [
    end,
    end / 1000,
    String(end),
    new Date(end).toISOString(),
    "2026-12-10 00:00:00",
  ])
    assert.equal(membershipExpiry(raw), new Date(end).toISOString());
  assert.equal(membershipExpiry("20261210"), "2026-12-10T15:59:59.000Z");
  for (const raw of [
    undefined,
    null,
    "",
    0,
    -1,
    true,
    "invalid",
    "20260230",
    "2026-02-30T12:00:00Z",
    "2026-02-30 12:00:00",
    Infinity,
    "永久",
    170,
  ])
    assert.equal(membershipExpiry(raw), null);
  assert.equal(
    membershipStatus(
      { status: "active", tier: "VIP", expiresAt: "2026-01-01T00:00:00Z" },
      time,
    ),
    "expired",
  );
});

test("夸克与UC按当前会员类型读取：取消续费仍在有效期内，不据容量或订阅开关猜测", () => {
  const m = quarkMembership(
    {
      member_type: "SUPER_VIP",
      super_vip_exp_at: end,
      subscribe_status: 0,
      member_status: { SUPER_VIP: "MONTH_SUBSCRIBE_CANCEL_IN_MEM" },
    },
    time,
  );
  assert.equal(m.status, "active");
  assert.equal(m.tier, "超级会员");
  assert.equal(m.expiresAt, new Date(end).toISOString());
  assert.equal(
    quarkMembership({ member_type: "VIP", exp_at: time - 1 }, time).status,
    "expired",
  );
  assert.equal(
    quarkMembership({ member_type: "NORMAL", total_capacity: 2 ** 45 }, time)
      .status,
    "none",
  );
  assert.equal(
    quarkMembership({ total_capacity: 2 ** 45 }, time).status,
    "unknown",
  );
  assert.equal(quarkMembership({ member_type: "VIP" }, time).expiresAt, null);
});

test("百度忽略扩容包，多个产品选择当前有效会员，保留过期会员日期", () => {
  const active = baiduMembership(
    {
      product_infos: [
        { product_name: "容量扩容VIP包", end_time: end / 1000 + 10000 },
        { product_name: "vip", start_time: 0, end_time: end / 1000 + 1000 },
        {
          product_name: "svip",
          start_time: time / 1000 - 1,
          end_time: end / 1000,
        },
        {
          product_name: "svip",
          start_time: end / 1000 + 100,
          end_time: end / 1000 + 5000,
        },
      ],
    },
    time,
  );
  assert.equal(active.tier, "超级会员");
  assert.equal(active.expiresAt, new Date(end).toISOString());
  assert.equal(baiduMembership({ product_infos: [] }, time).status, "none");
  assert.equal(baiduMembership({}, time).status, "unknown");
  assert.equal(
    baiduMembership(
      { product_infos: [{ product_name: "svip", end_time: time / 1000 - 1 }] },
      time,
    ).status,
    "expired",
  );
  assert.equal(
    baiduMembership({ product_infos: [{ product_name: "svip" }] }, time).status,
    "unknown",
  );
});

test("光鸭使用官方2有效3过期枚举，PikPak核对用户，迅雷区分云盘与无关会员", () => {
  assert.equal(
    guangyaMembership(
      { vipStatus: 2, svipStatus: 0, vipExpireTime: end / 1000 },
      time,
    ).status,
    "active",
  );
  assert.equal(
    guangyaMembership({ vipStatus: 3, vipExpireTime: time / 1000 - 1 }, time)
      .status,
    "expired",
  );
  assert.equal(guangyaMembership({}, time).status, "unknown");
  assert.equal(
    guangyaMembership(
      { vipStatus: 2, svipStatus: 3, vipExpireTime: end / 1000 },
      time,
    ).tier,
    "VIP会员",
  );
  assert.equal(
    pikpakMembership(
      {
        result: "ACCEPTED",
        data: {
          type: "platinum",
          status: "ok",
          user_id: "u",
          expire: new Date(end).toISOString(),
        },
      },
      "u",
      time,
    ).status,
    "active",
  );
  assert.throws(
    () =>
      pikpakMembership(
        { result: "ACCEPTED", data: { user_id: "other" } },
        "u",
        time,
      ),
    { code: "ACCOUNT_UID_MISMATCH" },
  );
  assert.equal(
    pikpakMembership({ result: "ACCEPTED", data: { type: "novip" } }, "u", time)
      .status,
    "none",
  );
  assert.equal(
    xunleiMembership(
      { vip_info: [{ user_vas: 313, vas_type: 5, is_vip: 1 }] },
      time,
    ).status,
    "none",
  );
  const x = xunleiMembership(
    {
      vip_info: [
        {
          user_vas: "306",
          vas_type: "5",
          is_vip: "1",
          expire_date: "20261210",
        },
      ],
    },
    time,
  );
  assert.equal(x.status, "active");
  assert.equal(x.tier, "云盘会员");
  assert.equal(x.expiresAt, "2026-12-10T15:59:59.000Z");
  assert.equal(xunleiMembership({}, time).status, "unknown");
  assert.equal(xunleiMembership({ vip_info: [{}] }, time).status, "unknown");
  assert.equal(
    xunleiMembership(
      { vip_info: [{ user_vas: 306, vas_type: 5, expire_date: "20200101" }] },
      time,
    ).status,
    "unknown",
  );
});

test("六家网盘接入已有隔离传输，会员仅执行官方只读请求", async () => {
  const calls: { id: string; url: URL; init?: RequestInit }[] = [];
  const transport: ProviderTransport = {
    text: async () => "",
    authHeaders: async () => ({ authorization: "Bearer fixture" }),
    json: async (id, address, init) => {
      const url = new URL(address);
      calls.push({ id, url, init });
      if (url.pathname.endsWith("/member"))
        return {
          code: 0,
          data: { member_type: "SUPER_VIP", super_vip_exp_at: end },
        };
      if (url.pathname === "/api/gettemplatevariable")
        return { errno: 0, result: { is_vip: 1, is_svip: 1 } };
      if (url.pathname === "/rest/2.0/membership/user")
        return {
          errno: 0,
          product_infos: [{ product_name: "svip", end_time: end / 1000 }],
        };
      if (url.pathname.endsWith("/privilege/vip"))
        return {
          result: "ACCEPTED",
          data: {
            type: "platinum",
            status: "ok",
            expire: new Date(end).toISOString(),
            user_id: "uid",
          },
        };
      if (url.pathname === "/v1/user/me")
        return {
          sub: "uid",
          vip_info: [
            { user_vas: 306, vas_type: 5, is_vip: 1, expire_date: "20261210" },
          ],
        };
      if (url.pathname === "/assets/v1/get_assets")
        return { code: 0, data: { vipStatus: 2, vipExpireTime: end / 1000 } };
      throw Error(`unexpected ${url.pathname}`);
    },
  };
  for (const p of [
    new QuarkProvider(transport),
    new UcProvider(transport),
    new BaiduProvider(transport),
    new XunleiProvider(transport),
    new PikPakProvider(transport),
    new GuangyaProvider(transport),
  ]) {
    const account = { id: p.id, provider: p.id, uid: "uid" } as Account;
    const value = await p.membership(account);
    assert.ok(value.status !== "unknown");
    assert.equal(calls.at(-1)?.id, p.id);
    assert.equal(
      calls.at(-1)?.init?.method ?? "GET",
      p.id === "guangya" ? "POST" : "GET",
    );
  }
  assert.equal(calls.length, 7);
});

test("会员随核验/刷新持久化：网络失败保留记录，不影响容量与身份，错UID缓存不展示", async () => {
  const f = await fixture();
  try {
    const p = Object.assign(f.provider, {
      capacity: async () => ({ totalBytes: 100, usedBytes: 10 }),
      membership: async () => ({
        status: "active" as const,
        tier: "超级会员",
        expiresAt: new Date(end).toISOString(),
      }),
    });
    const a = (await f.app.invoke("account.check", {
      id: f.account.id,
    })) as Account;
    assert.equal(a.membership?.value?.status, "active");
    assert.equal(a.capacity?.value?.totalBytes, 100);
    const stored = a.membership;
    p.membership = async () => {
      throw Error("会员接口暂不可用");
    };
    const b = (await f.app.invoke("account.capacity", {
      id: f.account.id,
    })) as Account;
    assert.equal(b.status, "connected");
    assert.deepEqual(b.membership?.value, stored?.value);
    assert.equal(b.membership?.updatedAt, stored?.updatedAt);
    assert.match(b.membership?.error ?? "", /暂不可用/);
    assert.equal(b.capacity?.error, null);
    f.app.db.setSetting(`account:membership:${f.account.id}`, {
      ...stored,
      ownerUid: "another-uid",
    });
    assert.equal(f.app.repo.getAccount(f.account.id).membership, null);
    assert.equal(f.provider.shares, 0);
    assert.equal(f.provider.transfers, 0);
  } finally {
    await f.cleanup();
  }
});

test("删除临时账号同步清理会员缓存，保留其他账号缓存", async () => {
  const f = await fixture();
  try {
    f.app.db.setSetting(`account:membership:${f.account.id}`, {
      ownerUid: f.account.uid,
      value: { status: "none", tier: null, expiresAt: null },
      updatedAt: null,
      attemptedAt: new Date().toISOString(),
      error: null,
    });
    f.app.db.setSetting("account:membership:other-account", {
      untouched: true,
    });
    const preview = (await f.app.invoke("account.deletePreview", {
      id: f.account.id,
    })) as { token: string; blockers: string[] };
    assert.deepEqual(preview.blockers, []);
    await f.app.invoke("account.remove", { token: preview.token });
    assert.equal(
      f.app.db.setting(`account:membership:${f.account.id}`, null),
      null,
    );
    assert.deepEqual(
      f.app.db.setting("account:membership:other-account", null),
      { untouched: true },
    );
  } finally {
    await f.cleanup();
  }
});

test("历史账号首次读取被身份核验阻止时也保存明确失败，不把未尝试会员接口记成未知", async () => {
  for (const auth of [false, true]) {
    const f = await fixture();
    try {
      f.app.db.run(
        "DELETE FROM settings WHERE key=?",
        `account:membership:${f.account.id}`,
      );
      let reads = 0;
      Object.assign(f.provider, {
        identity: async () => {
          throw auth
            ? new AppError("AUTH_EXPIRED", "登录已失效")
            : new Error("browserContext.newPage: Target crashed");
        },
        membership: async () => {
          reads++;
          return { status: "active", tier: "VIP会员", expiresAt: null };
        },
      });
      await assert.rejects(
        f.app.invoke("account.capacity", { id: f.account.id }),
      );
      const account = f.app.repo.getAccount(f.account.id);
      assert.equal(reads, 0);
      assert.equal(account.membership?.value, null);
      assert.equal(account.membership?.updatedAt, null);
      assert.ok(account.membership?.attemptedAt);
      assert.match(
        account.membership?.error ?? "",
        auth ? /登录已失效/ : /Target crashed/,
      );
      assert.equal(account.status, auth ? "expired" : "connected");
    } finally {
      await f.cleanup();
    }
  }
});

test("百度真实 vip0 基础权益不冒充会员，2038/2106 占位日期不作为到期时间", () => {
  const raw = {
    product_infos: [
      {
        product_name: "knowledge_default_answer",
        cluster: "netdisk_common_knowledge",
        start_time: 1793424600,
        end_time: 4294967295,
        status: 0,
      },
      {
        product_name: "vip0",
        cluster: "vip",
        detail_cluster: "vip",
        start_time: 1793462400,
        end_time: 2147483648,
        status: 0,
      },
    ],
  };
  assert.deepEqual(
    baiduMembership(raw, time, { is_vip: 0, is_svip: 0, vip_type: 1 }),
    { status: "none", tier: null, expiresAt: null },
  );
  assert.deepEqual(baiduMembership(raw, time), {
    status: "none",
    tier: null,
    expiresAt: null,
  });
  for (const end_time of [2147483647, 2147483648, 4294967295, 2147483648000]) {
    const value = baiduMembership(
      { product_infos: [{ product_name: "svip2", cluster: "vip", end_time }] },
      time,
      { is_vip: 0, is_svip: 1 },
    );
    assert.equal(value.status, "active");
    assert.equal(value.tier, "超级会员");
    assert.equal(value.expiresAt, null);
  }
});

test("百度以本人会员标志确认等级，只使用当前等级的真实有效期", () => {
  const result = {
    product_infos: [
      { product_name: "vip1", cluster: "vip", end_time: end / 1000 + 1000 },
      { product_name: "svip2", cluster: "vip", end_time: end / 1000 },
    ],
  };
  assert.deepEqual(baiduMembership(result, time, { is_vip: 1, is_svip: 0 }), {
    status: "active",
    tier: "VIP会员",
    expiresAt: new Date(end + 1000000).toISOString(),
  });
  assert.deepEqual(
    baiduMembership(result, time, { is_vip: "0", is_svip: "1" }),
    {
      status: "active",
      tier: "超级会员",
      expiresAt: new Date(end).toISOString(),
    },
  );
  assert.equal(
    baiduMembership(result, time, { is_vip: 0, is_svip: 0 }).status,
    "none",
  );
  assert.equal(
    baiduMembership(
      {
        product_infos: [
          { product_name: "vip1", cluster: "vip", end_time: end / 1000 },
        ],
      },
      time,
      { is_vip: 1, is_svip: 1 },
    ).expiresAt,
    null,
  );
});

test("百度旧识别结果立即失效，刷新写入新版结果，刷新失败保留新版缓存", async () => {
  const f = await fixture();
  try {
    const account = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "会员缓存账号",
    })) as Account;
    const p = Object.assign(f.provider, {
      capacity: async () => ({ usedBytes: 1, totalBytes: 100 }),
      membership: async () => ({ status: "none", tier: null, expiresAt: null }),
    });
    await f.app.invoke("account.check", { id: account.id });
    const uid = f.app.repo.getAccount(account.id).uid;
    f.app.db.setSetting(`account:membership:${account.id}`, {
      ownerUid: uid,
      value: {
        status: "active",
        tier: "VIP会员",
        expiresAt: "2038-01-19T03:14:08.000Z",
      },
      updatedAt: new Date().toISOString(),
      attemptedAt: new Date().toISOString(),
      error: null,
    });
    assert.equal(f.app.repo.getAccount(account.id).membership?.value, null);
    const refreshed = (await f.app.invoke("account.capacity", {
      id: account.id,
    })) as Account;
    assert.equal(refreshed.membership?.value?.status, "none");
    assert.equal(refreshed.membership?.parserRevision, 2);
    p.membership = async () => {
      throw Error("会员接口暂不可用");
    };
    const failed = (await f.app.invoke("account.capacity", {
      id: account.id,
    })) as Account;
    assert.equal(failed.membership?.value?.status, "none");
    assert.equal(failed.membership?.parserRevision, 2);
    assert.match(failed.membership?.error ?? "", /暂不可用/);
  } finally {
    await f.cleanup();
  }
});
