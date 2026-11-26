import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Database } from "../core/database";
import { Repository } from "../core/repository";
import { SecretStore } from "../core/secrets";
import { AiService } from "../core/ai";
import type { fetchJson } from "../core/http";
import { ServiceHttpError } from "../core/errors";
import { createAiHandlers } from "../core/ipc/ai";
import { aiWebSources } from "../core/ai-web-search";

const article = z.object({
  title: z.string().min(1),
  body: z.string().min(10),
  checks: z.string(),
});
const value = {
  title: "整理演示资料",
  body: "正文已经开始，但具体步骤仍未",
  checks: "此字段可以完整闭合，不能用它推断正文已完整生成。",
};

async function fixture(
  response: Record<string, unknown>,
  requestOverride?: typeof fetchJson,
) {
  const db = new Database(":memory:");
  const secrets = new SecretStore(db, {
    available: () => true,
    encrypt: async (text) => text,
    decrypt: async (text) => text,
  });
  await secrets.set("openrouter", "synthetic-test-only");
  db.setSetting("model", "fixture/text");
  db.setSetting("modelCatalog", [
    {
      id: "fixture/text",
      name: "Fixture",
      structured: true,
      textOutput: true,
      promptPrice: 1e-7,
      completionPrice: 1e-7,
    },
  ]);
  let requests = 0,
    normalized = 0;
  const payloads: Record<string, any>[] = [];
  const request: typeof fetchJson = async (...args) => {
    requests++;
    payloads.push(args[1]?.body ? JSON.parse(String(args[1].body)) : {});
    if (requestOverride) return requestOverride(...args);
    return response;
  };
  const ai = new AiService(new Repository(db), secrets, () => {}, request);
  return {
    db,
    ai,
    secrets,
    payloads,
    requests: () => requests,
    normalized: () => normalized,
    run: () =>
      ai.resourceExport(
        "content_supply_editorial",
        article,
        "写出完整初稿",
        {},
        [],
        {
          normalizeResponse: (data) => {
            normalized++;
            return data;
          },
        },
      ),
  };
}

test("web grounding is explicit, reserves search charges and injected text, and only exposes real citation excerpts", async () => {
  const annotations = [
    {
      type: "url_citation",
      url_citation: {
        url: "https://example.com/manual",
        title: "手册",
        content: "有依据的具体操作步骤",
      },
    },
    {
      type: "url_citation",
      url_citation: { url: "https://example.com/empty", title: "无摘录" },
    },
    {
      type: "url_citation",
      url_citation: { url: "javascript:alert(1)", content: "不可点击" },
    },
    {
      type: "url_citation",
      url_citation: {
        url: "https://user:secret@example.com/private",
        content: "凭据不可出现",
      },
    },
  ];
  assert.equal(aiWebSources(annotations).length, 1);
  const f = await fixture({
    usage: { cost: 0.009 },
    choices: [
      {
        finish_reason: "stop",
        message: { content: JSON.stringify(value), annotations },
      },
    ],
  });
  try {
    f.db.setSetting("dailyAiBudgetMicros", 5000);
    await assert.rejects(
      () =>
        f.ai.resourceExport("grounding", article, "检索", {}, [], {
          maxTokens: 512,
          webSearch: true,
        }),
      { code: "AI_BUDGET_EXCEEDED" },
    );
    assert.equal(f.requests(), 0);
    f.db.setSetting("dailyAiBudgetMicros", 100000);
    let sources: unknown;
    await f.ai.resourceExport("grounding", article, "检索", {}, [], {
      maxTokens: 512,
      webSearch: true,
      onWebSources: (items) => {
        sources = items;
      },
    });
    assert.deepEqual(f.payloads[0].plugins, [
      { id: "web", engine: "exa", mode: "auto", max_results: 5 },
    ]);
    assert.deepEqual(sources, [
      {
        url: "https://example.com/manual",
        title: "手册",
        content: "有依据的具体操作步骤",
      },
    ]);
    const call = f.db.get<{
      estimated_micros: number;
      confirmed_micros: number;
    }>("SELECT estimated_micros,confirmed_micros FROM api_calls");
    assert.ok(call!.estimated_micros > 13000);
    assert.equal(call!.confirmed_micros, 9000);
    await f.run();
    assert.equal(f.payloads[1].plugins, undefined, "普通写作不启用付费联网");
  } finally {
    f.db.close();
  }
});

test("explicit incomplete generation states reject even syntactically valid schema-conforming JSON and keep the known charge", async (t) => {
  for (const finishReason of [
    "length",
    "content_filter",
    "error",
    "tool_calls",
    "function_call",
    "unknown_state",
  ])
    await t.test(finishReason, async () => {
      const f = await fixture({
        usage: { cost: 0.003286 },
        choices: [
          {
            finish_reason: finishReason,
            native_finish_reason: "provider_stop",
            message: { role: "assistant", content: JSON.stringify(value) },
          },
        ],
      });
      try {
        await assert.rejects(f.run(), { code: "INVALID_AI_RESPONSE" });
        assert.equal(
          f.requests(),
          1,
          "a rejected generation must not retry a paid request",
        );
        assert.equal(
          f.normalized(),
          0,
          "domain normalization must not turn an incomplete response into success",
        );
        const call = f.db.get<{
          status: string;
          confirmed_micros: number;
          reserved_micros: number;
          message: string;
        }>(
          "SELECT status,confirmed_micros,reserved_micros,message FROM api_calls",
        );
        assert.equal(
          call?.status,
          "success",
          "successful provider billing remains recorded despite unusable content",
        );
        assert.equal(call?.confirmed_micros, 3286);
        assert.equal(call?.reserved_micros, 3286);
        assert.match(call?.message ?? "", /校验未通过/);
        const diagnostic = f.db.get<{ value: string }>(
          "SELECT value FROM api_cache WHERE key LIKE 'ai-diagnostic:%'",
        );
        assert(diagnostic);
        const details = JSON.parse(diagnostic.value);
        assert.equal(details.finishReason, finishReason);
        assert.equal(details.nativeFinishReason, "provider_stop");
        assert.equal(details.model, "fixture/text");
        assert.equal(details.rawLength, JSON.stringify(value).length);
        assert(!diagnostic.value.includes(value.body), "异常诊断不保留正文");
      } finally {
        f.db.close();
      }
    });
});

test("桌面网络与原直连可显式对照，默认生成使用注入网络，失败不自动换网络或重试", async () => {
  const f = await fixture({});
  let system = 0,
    direct = 0;
  const response = {
    usage: { cost: 0 },
    choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
  };
  let reject = false;
  const ai = new AiService(
    new Repository(f.db),
    f.secrets,
    () => {},
    async () => {
      system++;
      if (reject)
        throw new ServiceHttpError(400, "Request path cannot be relayed");
      return response;
    },
    async () => {
      direct++;
      return response;
    },
  );
  try {
    await ai.probe({ mode: "json-schema" });
    await ai.probe({ mode: "json-schema", network: "direct" });
    assert.equal(system, 1);
    assert.equal(direct, 1);
    reject = true;
    await assert.rejects(
      () => ai.probe({ mode: "json-schema" }),
      /cannot be relayed/,
    );
    assert.equal(system, 2);
    assert.equal(direct, 1);
  } finally {
    f.db.close();
  }
});

test("显式生成诊断按原预算记费，三种输出模式独立调用，不切换默认模型或自动重试", async () => {
  const f = await fixture({
    usage: { cost: 0.000001 },
    choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
  });
  try {
    for (const mode of ["json-schema", "json-object", "prompt-json"] as const)
      assert.equal((await f.ai.probe({ mode })).ok, true);
    assert.equal(f.requests(), 3);
    assert.deepEqual(
      f.payloads.map((p) => p.response_format?.type ?? "prompt-json"),
      ["json_schema", "json_object", "prompt-json"],
    );
    assert.ok(
      f.payloads.every(
        (p) => p.max_tokens === 512 && p.model === "fixture/text",
      ),
    );
    assert.equal(f.db.setting("model", ""), "fixture/text");
    assert.equal(
      f.db.get<{ n: number }>(
        "SELECT count(*) n FROM api_calls WHERE phase='connection_probe' AND status='success' AND confirmed_micros=1",
      )?.n,
      3,
    );
    f.db.setSetting("dailyAiBudgetMicros", 0);
    await assert.rejects(() => f.ai.probe({ mode: "json-schema" }), {
      code: "AI_BUDGET_EXCEEDED",
    });
    assert.equal(f.requests(), 3);
    const handlers = createAiHandlers({ ai: f.ai, db: f.db, ideas: {} as any });
    assert.throws(
      () => handlers["ai.probe"]({ mode: "json-schema" }),
      /authorized/,
    );
    assert.equal(f.requests(), 3);
  } finally {
    f.db.close();
  }
});

test("被拒绝的生成保留脱敏HTTP及供应商诊断，不保存原始请求、不重试、不编造确认费用", async () => {
  const key = "synthetic-test-only";
  const f = await fixture({}, async (_url, _init, _timeout, onResponse) => {
    onResponse?.(
      JSON.stringify({
        error: {
          code: 400,
          message: "Request path cannot be relayed",
          metadata: {
            provider_name: `Fixture ${key}`,
            error_type: "request_validation",
            provider_code: "invalid_path",
            raw: `private prompt ${key}`,
          },
        },
        openrouter_metadata: {
          region: "test",
          summary: `router ${key}`,
          pipeline: [{ private: "never retain this" }],
        },
      }),
      400,
    );
    throw new ServiceHttpError(400, "Request path cannot be relayed");
  });
  try {
    await assert.rejects(
      () => f.ai.probe({ mode: "json-schema" }),
      /cannot be relayed/,
    );
    assert.equal(f.requests(), 1);
    const row = f.db.get<{ value: string }>(
      "SELECT value FROM api_cache WHERE key LIKE 'ai-diagnostic:%'",
    )!;
    const diagnostic = JSON.parse(row.value);
    assert.equal(diagnostic.httpStatus, 400);
    assert.equal(diagnostic.remoteError.code, 400);
    assert.equal(diagnostic.remoteError.providerCode, "invalid_path");
    assert.doesNotMatch(
      row.value,
      /synthetic-test-only|private prompt|never retain this/,
    );
    const call = f.db.get<{ status: string; confirmed_micros: number | null }>(
      "SELECT status,confirmed_micros FROM api_calls",
    )!;
    assert.equal(call.status, "failed");
    assert.equal(call.confirmed_micros, null);
  } finally {
    f.db.close();
  }
});

test("a normal stop preserves the complete original JSON fields without slicing or moving checks into body", async () => {
  const complete = {
    ...value,
    body: "先复制原件，再整理资料与出处。\n\n".repeat(60),
    checks: "仅作为独立核对字段。",
  };
  const f = await fixture({
    usage: { cost: 0.003456 },
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(complete) },
      },
    ],
  });
  try {
    assert.deepEqual(await f.run(), complete);
    assert.equal(f.requests(), 1);
  } finally {
    f.db.close();
  }
});

test("missing legacy finish metadata stays unspecified rather than inventing a truncation diagnosis", async () => {
  const f = await fixture({
    usage: { cost: 0 },
    choices: [{ message: { content: JSON.stringify(value) } }],
  });
  try {
    assert.deepEqual(await f.run(), value);
  } finally {
    f.db.close();
  }
});
