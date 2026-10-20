import type { IpcMethod, IpcValue } from "../shared/ipc";
import test from "node:test";
import assert from "node:assert/strict";
import { baiduKeywordInputSchema } from "../shared/baidu-keywords";
import {
  buildBaiduKeywordRequest,
  parseBaiduKeywordResponse,
} from "../core/baidu-keywords";
import { fixture } from "./helpers";

const input = baiduKeywordInputSchema.parse({
  accountId: "web_test",
  seeds: ["网盘"],
});
const response = (
  items: unknown[] = [
    {
      keyword: "网盘备份",
      averageMonthPv: 1200,
      recommendPrice: 1.25,
      competition: 2,
    },
  ],
) => ({
  status: 200,
  userId: "123456",
  body: JSON.stringify({
    status: 0,
    data: { keywordRecommendItems: items, totalCount: items.length },
  }),
});
test("Baidu request uses verified source parameters and no credentials or manual identity", () => {
  const params = buildBaiduKeywordRequest({
    ...input,
    seeds: ["网盘", "网盘"],
  });
  assert.equal(params.source, "web");
  assert.equal(params.addFrom, 181);
  assert.equal(params.keyWordRecommendFilter.searchRegions, "9999999");
  assert.deepEqual(params.wordQuerys, ["网盘"]);
  assert.equal(params.pageSize, 3000);
  assert.equal("token" in params, false);
  assert.equal("userId" in params, false);
  assert.throws(() =>
    baiduKeywordInputSchema.parse({ userId: "123456", seeds: ["网盘"] }),
  );
  assert.throws(() =>
    buildBaiduKeywordRequest({ ...input, seeds: Array(11).fill("词") }),
  );
});
test("Baidu normalization preserves zero and missing values, deduplicates and drops sensitive fields", () => {
  const result = parseBaiduKeywordResponse(
    input,
    response([
      {
        keyword: "网盘",
        averageMonthPv: 0,
        click: null,
        token: "must-not-leak",
      },
      { keyword: "网盘" },
      { keyword: "备份", recommendPrice: 1.25, intention: "教程" },
    ]),
  );
  assert.equal(result.keywords.length, 2);
  assert.equal(result.accountUid, "123456");
  assert.equal(result.keywords[1].metrics.recommendPrice, 1.25);
  assert.equal(result.keywords[1].metrics.averageMonthPv, undefined);
  assert.ok(!JSON.stringify(result).includes("must-not-leak"));
  const zero = parseBaiduKeywordResponse(
    input,
    response([{ keyword: "零值", averageMonthPv: 0, click: null }]),
  );
  assert.equal(zero.keywords[0].metrics.averageMonthPv, 0);
  assert.equal(zero.keywords[0].metrics.click, null);
  assert.equal(zero.keywords[0].sourceUpdatedAt, null);
});
test("Baidu rejects auth/error/schema changes instead of fabricating empty results", () => {
  for (const value of [
    { status: 403, body: "denied" },
    { status: 200, body: JSON.stringify({ status: 700 }) },
    {
      status: 200,
      body: JSON.stringify({ status: 0, errors: [{ code: "99945" }] }),
    },
    {
      status: 200,
      body: JSON.stringify({
        status: 1,
        data: { keywordRecommendItems: [], totalCount: 0 },
      }),
    },
    { status: 200, body: JSON.stringify({ status: 0, data: {} }) },
    response([{ keyword: "错误字段", averageMonthPv: { changed: true } }]),
  ])
    assert.throws(() =>
      parseBaiduKeywordResponse(input, { userId: "123456", ...value }),
    );
  assert.deepEqual(parseBaiduKeywordResponse(input, response([])).keywords, []);
});
test("Baidu account cache is isolated, local reads never query, errors retain successful results", async () => {
  const f = await fixture();
  const invoke = <M extends IpcMethod>(method: M, args?: unknown) =>
    f.app.invoke(method, args) as Promise<IpcValue<M>>;
  let calls = 0,
    broken = false,
    uid = "123456",
    release: (() => void) | undefined,
    wait: Promise<void> | undefined,
    invalid = false;
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async () => {},
    clear: async () => {},
    invalidate: async () => {
      invalid = true;
    },
    status: async () => ({
      hasSession: !invalid,
      uid,
      windowOpen: false,
      error: null,
    }),
  };
  f.ports.baiduKeywords = {
    query: async (account, query) => {
      assert.equal(account.id, query.accountId);
      calls++;
      await wait;
      return broken
        ? { status: 200, userId: uid, body: "{}" }
        : { ...response(), userId: uid };
    },
  };
  try {
    const account = await invoke("websiteAccounts.add", {
      provider: "baidu-marketing",
    });
    const query = { ...input, accountId: account.id };
    assert.equal(
      await invoke("baiduKeywords.latest", { accountId: account.id }),
      null,
    );
    await invoke("websiteAccounts.list");
    assert.equal(calls, 0);
    await assert.rejects(
      invoke("baiduKeywords.query", { ...query, seeds: [] }),
    );
    assert.equal(calls, 0);
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = invoke("baiduKeywords.query", query);
    await assert.rejects(invoke("baiduKeywords.query", query), {
      code: "WEBSITE_ACCOUNT_BUSY",
    });
    await assert.rejects(
      invoke("websiteAccounts.remove", {
        id: account.id,
        confirmed: true,
      }),
      { code: "WEBSITE_ACCOUNT_BUSY" },
    );
    await assert.rejects(invoke("websiteAccounts.login", { id: account.id }), {
      code: "WEBSITE_ACCOUNT_BUSY",
    });
    release!();
    const result = await pending;
    assert.equal(calls, 1);
    assert.equal(
      (await invoke("baiduKeywords.latest", { accountId: account.id }))?.id,
      result.id,
    );
    const pool = await invoke("pool.save", {
      name: "百度词池",
      resourceId: null,
      keywords: result.keywords,
    });
    assert.equal(pool.keywords[0].metrics.recommendPrice, 1.25);
    broken = true;
    await assert.rejects(invoke("baiduKeywords.query", query), {
      code: "BAIDU_SCHEMA_CHANGED",
    });
    assert.equal(
      (await invoke("baiduKeywords.latest", { accountId: account.id }))?.id,
      result.id,
    );
    const second = await invoke("websiteAccounts.add", {
      provider: "baidu-marketing",
    });
    assert.equal(
      await invoke("baiduKeywords.latest", { accountId: second.id }),
      null,
    );
    uid = "654321";
    assert.equal(
      await invoke("baiduKeywords.latest", { accountId: account.id }),
      null,
    );
    uid = "123456";
    broken = false;
    const original = f.app.db.run.bind(f.app.db);
    f.app.db.run = (sql, ...values) => {
      if (sql.startsWith("INSERT INTO api_cache")) throw new Error("disk full");
      return original(sql, ...values);
    };
    try {
      const delivered = await invoke("baiduKeywords.query", query);
      assert.equal(delivered.keywords.length, 1);
      assert.match(delivered.warning!, /查询已成功/);
    } finally {
      f.app.db.run = original;
    }
    f.ports.baiduKeywords.query = async () => ({
      status: 403,
      userId: uid,
      body: "denied",
    });
    await assert.rejects(invoke("baiduKeywords.query", query), {
      code: "BAIDU_LOGIN_REQUIRED",
    });
    assert.equal(
      (await invoke("websiteAccounts.check", { id: account.id })).status,
      "expired",
    );
    assert.equal(
      (await invoke("baiduKeywords.latest", { accountId: account.id }))?.id,
      result.id,
    );
    await assert.rejects(invoke("baiduKeywords.query", query), {
      code: "WEBSITE_LOGIN_REQUIRED",
    });
    f.app.db.run(
      "UPDATE api_cache SET value=? WHERE key=?",
      '{"keywords":null}',
      `baidu-keywords:latest:${account.id}`,
    );
    await assert.rejects(
      invoke("baiduKeywords.latest", { accountId: account.id }),
      { code: "BAIDU_CACHE_INVALID" },
    );
    await invoke("websiteAccounts.remove", {
      id: account.id,
      confirmed: true,
    });
    assert.equal(
      f.app.db.get(
        "SELECT value FROM api_cache WHERE key=?",
        `baidu-keywords:latest:${account.id}`,
      ),
      undefined,
    );
  } finally {
    release?.();
    await f.cleanup();
  }
});
