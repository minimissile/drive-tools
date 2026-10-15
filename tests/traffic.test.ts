import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { TrafficService, budgetDayStart } from "../core/traffic";
async function enabled(
  f: Awaited<ReturnType<typeof fixture>>,
  endpoint: string,
  units = 100,
) {
  await f.app.secrets.set(`5118:${endpoint}`, "test-key");
  f.app.db.run(
    "UPDATE api_plans SET enabled=1,unit_price_micros=20000,daily_units=? WHERE endpoint=?",
    units,
    endpoint,
  );
}
test("长尾词按页预留费用，缓存0请求且保留原获取时间", async () => {
  const f = await fixture();
  try {
    await enabled(f, "longtail");
    let requests = 0;
    const traffic = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async () => {
        requests++;
        return {
          errcode: 0,
          data: {
            page_count: 1,
            word: [{ keyword: "AI办公清单", index: 123 }],
          },
        };
      },
    );
    const query = {
      endpoint: "longtail" as const,
      seeds: ["AI办公"],
      pages: 1,
      useCache: true,
    };
    const result = await traffic.query(query),
      again = await traffic.query(query);
    assert.equal(requests, 1);
    assert.equal(again.fromCache, true);
    assert.equal(result.keywords[0].fetchedAt, again.keywords[0].fetchedAt);
    const calls = f.app.repo.calls();
    assert.equal(
      calls.reduce((n, c) => n + c.requestCount, 0),
      1,
    );
    assert.equal(
      calls.find((c) => c.status === "success")?.estimatedMicros,
      20000,
    );
    assert.equal(calls[0].confirmedMicros, null);
  } finally {
    await f.cleanup();
  }
});
test("批量中途失败后保留成功页，超时保留预算，预算不足不发请求", async () => {
  const f = await fixture();
  try {
    await enabled(f, "longtail", 3);
    let requests = 0,
      failed = false;
    const traffic = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async (_url, init) => {
        requests++;
        const page = new URLSearchParams(String(init?.body)).get("page_index");
        if (page === "2" && !failed) {
          failed = true;
          throw new Error("timeout");
        }
        return {
          errcode: 0,
          data: { page_count: 2, word: [{ keyword: `关键词页${page}` }] },
        };
      },
    );
    const query = {
      endpoint: "longtail" as const,
      seeds: ["关键词"],
      pages: 2,
      useCache: true,
    };
    await assert.rejects(traffic.query(query));
    assert.equal(
      f.app.repo.calls().filter((c) => c.status === "uncertain").length,
      1,
    );
    const result = await traffic.query(query);
    assert.equal(requests, 3);
    assert.equal(result.keywords.length, 2);
    await assert.rejects(
      traffic.query({ ...query, seeds: ["另一词"], pages: 1 }),
      { code: "API_BUDGET_EXCEEDED" },
    );
    assert.equal(requests, 3);
  } finally {
    await f.cleanup();
  }
});
test("搜索量按关键词计费，轮询至少60秒，未明确轮询费用保持待核", async () => {
  const f = await fixture();
  try {
    await enabled(f, "metrics");
    let requests = 0;
    const traffic = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async () => {
        requests++;
        return requests === 1
          ? { errcode: 0, data: { taskid: "task-m" } }
          : {
              errcode: 0,
              data: { keyword_param: [{ keyword: "办公", bidword_pcpv: 20 }] },
            };
      },
    );
    const q = {
      endpoint: "metrics" as const,
      seeds: ["办公", "会议"],
      pages: 1,
      useCache: true,
    };
    const result = await traffic.query(q);
    assert.equal(result.taskId, "task-m");
    assert.equal(f.app.repo.calls()[0].units, 2);
    await assert.rejects(traffic.query({ ...q, taskId: "task-m" }), {
      code: "POLL_TOO_EARLY",
    });
    assert.equal(requests, 1);
    f.app.db.run(
      "UPDATE async_queries SET created_at=?",
      new Date(Date.now() - 61000).toISOString(),
    );
    assert.equal(
      (await traffic.query({ ...q, taskId: "task-m" })).keywords[0].word,
      "办公",
    );
    assert.equal(
      f.app.repo.calls().find((c) => c.phase === "poll")?.status,
      "uncertain",
    );
  } finally {
    await f.cleanup();
  }
});
test("每日预算以北京时间日界线计算", () => {
  assert.equal(
    budgetDayStart(new Date("2026-10-14T17:00:00Z")),
    "2026-10-14T16:00:00.000Z",
  );
});
test("搜索量响应丢失保留提交检查点，重启与关键词换序均不能重复扣费", async () => {
  const f = await fixture();
  try {
    await enabled(f, "metrics");
    let requests = 0;
    const request = async () => {
      requests++;
      throw new Error("timeout");
    };
    const traffic = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      request,
    );
    const query = {
      endpoint: "metrics" as const,
      seeds: ["办公", "会议"],
      pages: 1,
      useCache: true,
    };
    await assert.rejects(traffic.query(query), /timeout/);
    const task = f.app.snapshot().asyncQueries[0];
    assert.equal(task.status, "uncertain");
    const reopened = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      request,
    );
    await assert.rejects(
      reopened.query({ ...query, seeds: ["会议", "办公"] }),
      { code: "UNCERTAIN_QUERY_RESULT" },
    );
    await assert.rejects(reopened.query({ ...query, taskId: task.taskId }), {
      code: "UNCERTAIN_QUERY_RESULT",
    });
    assert.equal(requests, 1);
    await f.app.invoke("traffic.releaseSubmission", { taskId: task.taskId });
    await assert.rejects(reopened.query(query), /timeout/);
    assert.equal(requests, 2);
    assert.equal(
      f.app.repo.calls().filter((c) => c.status === "uncertain").length,
      2,
    );
  } finally {
    await f.cleanup();
  }
});
test("同时提交相同关键词只发送一个请求；不完整成功响应不缓存为空结果", async () => {
  const f = await fixture();
  try {
    await enabled(f, "metrics");
    await enabled(f, "longtail");
    let requests = 0;
    const traffic = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async (url) => {
        requests++;
        return url.endsWith("/keywordparam/v2")
          ? { errcode: 0, data: { taskid: "one-task" } }
          : { errcode: 0, data: {} };
      },
    );
    const query = {
      endpoint: "metrics" as const,
      seeds: ["办公", "会议"],
      pages: 1,
      useCache: true,
    };
    const [first, second] = await Promise.all([
      traffic.query(query),
      traffic.query({ ...query, seeds: ["会议", "办公"] }),
    ]);
    assert.equal(first.taskId, second.taskId);
    assert.equal(requests, 1);
    await assert.rejects(
      traffic.query({ ...query, endpoint: "longtail", seeds: ["办公"] }),
      { code: "REMOTE_SCHEMA_CHANGED" },
    );
    assert.equal(
      f.app.db.get<{ count: number }>("SELECT COUNT(*) count FROM api_cache")
        ?.count,
      0,
    );
    assert.equal(
      f.app.repo.calls().find((c) => c.endpoint === "longtail")?.status,
      "uncertain",
    );
  } finally {
    await f.cleanup();
  }
});

test("下拉词分析中可跨重启恢复，重复查询不重发，继续查询仍受限频和预算约束", async () => {
  const f = await fixture();
  try {
    await enabled(f, "suggest", 1);
    let requests = 0;
    const request = async (_url: string, init?: RequestInit) => {
      requests++;
      assert.equal(
        new URLSearchParams(String(init?.body)).get("word"),
        "比特浏览器",
      );
      assert.equal(
        new URLSearchParams(String(init?.body)).get("platform"),
        "xiaohongshu",
      );
      assert.equal(
        new URLSearchParams(String(init?.body)).has("taskid"),
        false,
      );
      return requests === 1
        ? { errcode: "200104", errmsg: "数据分析中" }
        : {
            errcode: 0,
            data: [{ promote_word: "比特浏览器教程", platform: "xiaohongshu" }],
          };
    };
    const traffic = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      request,
    );
    const query = {
      endpoint: "suggest" as const,
      seeds: ["比特浏览器"],
      platform: "xiaohongshu",
      pages: 1,
      useCache: true,
    };
    const [first, concurrent] = await Promise.all([
      traffic.query(query),
      traffic.query(query),
    ]);
    assert.deepEqual(first.pendingSuggestions, concurrent.pendingSuggestions);
    assert.equal(requests, 1);
    const id = first.pendingSuggestions![0];
    assert.equal(f.app.snapshot().suggestionQueries[0].status, "pending");
    assert.equal(f.app.repo.calls()[0].status, "uncertain");
    const reopened = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      request,
    );
    assert.equal(
      (await reopened.query({ ...query, useCache: false })).pending,
      true,
    );
    assert.equal(requests, 1);
    await assert.rejects(reopened.resumeSuggestion(id), {
      code: "POLL_TOO_EARLY",
    });
    f.app.db.run(
      "UPDATE suggestion_queries SET last_requested_at=? WHERE id=?",
      new Date(Date.now() - 61000).toISOString(),
      id,
    );
    await assert.rejects(reopened.resumeSuggestion(id), {
      code: "API_BUDGET_EXCEEDED",
    });
    assert.equal(f.app.snapshot().suggestionQueries[0].status, "pending");
    assert.equal(requests, 1);
    f.app.db.run("UPDATE api_plans SET daily_units=2 WHERE endpoint='suggest'");
    const result = await reopened.resumeSuggestion(id);
    assert.equal(result.keywords[0].word, "比特浏览器教程");
    assert.equal(requests, 2);
    assert.equal(reopened.suggestionResult(id).fromCache, true);
    assert.equal(
      reopened.suggestionResult(id).keywords[0].fetchedAt,
      result.keywords[0].fetchedAt,
    );
    assert.equal((await reopened.query(query)).fromCache, true);
    assert.equal(requests, 2);
    assert.equal(f.app.repo.usage("CNY").pendingCount, 1);
    assert.equal(f.app.repo.usage("CNY").requestCount, 2);
    assert.equal(f.app.repo.usage("CNY").cacheHits, 1);
    await assert.rejects(
      f.app.invoke("traffic.resumeSuggestion", { id }),
      /true/,
    );
  } finally {
    await f.cleanup();
  }
});

test("下拉词超时保留检查点；更换Key隔离查询，不能用新Key继续旧记录", async () => {
  const f = await fixture();
  try {
    await enabled(f, "suggest");
    let requests = 0;
    const traffic = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async () => {
        requests++;
        throw new Error("timeout");
      },
    );
    const query = {
      endpoint: "suggest" as const,
      seeds: ["办公"],
      platform: "baidu",
      pages: 1,
      useCache: true,
    };
    await assert.rejects(traffic.query(query), /timeout/);
    const row = f.app.snapshot().suggestionQueries[0];
    assert.equal(row.status, "uncertain");
    assert.equal((await traffic.query(query)).pending, true);
    assert.equal(requests, 1);
    f.app.db.setSetting("keyRevision:suggest", "changed");
    assert.equal(f.app.snapshot().suggestionQueries[0].canRequest, false);
    await assert.rejects(traffic.resumeSuggestion(row.id), {
      code: "QUERY_KEY_CHANGED",
    });
    await assert.rejects(traffic.query(query), /timeout/);
    assert.equal(requests, 2);
    assert.equal(f.app.snapshot().suggestionQueries.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("下拉词混合返回保留成功结果和分析记录；空结果也可离线查看", async () => {
  const f = await fixture();
  try {
    await enabled(f, "suggest");
    let requests = 0;
    const traffic = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async (_url, init) => {
        requests++;
        const word = new URLSearchParams(String(init?.body)).get("word");
        return word === "待分析"
          ? { errcode: 200104 }
          : {
              errcode: 0,
              data: word === "空结果" ? [] : [{ promote_word: "办公清单" }],
            };
      },
    );
    const result = await traffic.query({
      endpoint: "suggest",
      seeds: ["办公", "待分析", "空结果"],
      platform: "baidu",
      pages: 1,
      useCache: true,
    });
    assert.equal(result.keywords.length, 1);
    assert.equal(result.pendingSuggestions?.length, 1);
    assert.equal(requests, 3);
    const empty = f.app
      .snapshot()
      .suggestionQueries.find((q) => q.seed === "空结果")!;
    assert.equal(empty.status, "completed");
    assert.equal(traffic.suggestionResult(empty.id).keywords.length, 0);
    assert.equal(requests, 3);
    assert.equal(
      f.app.db.get<{ count: number }>("SELECT COUNT(*) count FROM api_cache")
        ?.count,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
