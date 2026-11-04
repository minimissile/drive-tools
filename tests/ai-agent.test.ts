import test from "node:test";
import assert from "node:assert/strict";
import { Database, id, now } from "../core/database";
import { Repository } from "../core/repository";
import { SecretStore } from "../core/secrets";
import { AiService } from "../core/ai";
import {
  runAgentTurn,
  agentModelPrices,
  type AgentTransportDependencies,
} from "../core/ai-agent";
import { ServiceHttpError } from "../core/errors";
import type { AiModel } from "../shared/ai-models";
import type {
  AgentMessage,
  AgentToolDefinition,
  AgentTurnInput,
} from "../shared/ai-agent";

const model: AiModel = {
  id: "test/native-tools",
  name: "Native tool fixture",
  structured: false,
  tools: true,
  textOutput: true,
  promptPrice: 1e-7,
  completionPrice: 2e-7,
  requestPrice: 0.0001,
};
const tools: AgentToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "observe",
      description: "Read scoped local state",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];
const messages: AgentMessage[] = [
  { role: "system", content: "Operate only within the granted scope." },
  { role: "user", content: "Observe before deciding." },
];
const toolCall = (callId = "call_first") => ({
  id: callId,
  type: "function" as const,
  function: { name: "observe", arguments: "{}" },
});
const response = (
  message: unknown = { role: "assistant", content: "Finished." },
  cost: number | null = 0.000001,
  finishReason = "stop",
) => ({
  usage: cost === null ? {} : { cost },
  choices: [{ message, finish_reason: finishReason }],
});
const input = (patch: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
  messages,
  tools,
  maxOutputTokens: 100,
  maxCostMicros: 1_000_000,
  budgetScope: {
    planId: "plan_one",
    cycleId: "cycle_one",
    dayLimitMicros: 1_000_000,
    cycleLimitMicros: 1_000_000,
  },
  ...patch,
});
type Row = {
  id: string;
  status: string;
  estimated_micros: number;
  reserved_micros: number;
  confirmed_micros: number | null;
  message: string;
};

function harness(
  request: AgentTransportDependencies["requestJson"],
  selected: AiModel = model,
) {
  const db = new Database(":memory:");
  let calls = 0,
    keyReads = 0;
  const payloads: Record<string, any>[] = [];
  const deps: AgentTransportDependencies = {
    db,
    model: selected.id,
    selected,
    getKey: async () => {
      keyReads++;
      return "synthetic-test-credential";
    },
    changed() {},
    requestJson: async (...args) => {
      calls++;
      payloads.push(JSON.parse(String(args[1]?.body)));
      return request(...args);
    },
  };
  return {
    db,
    deps,
    payloads,
    calls: () => calls,
    keyReads: () => keyReads,
    rows: () => db.all<Row>("SELECT * FROM api_calls ORDER BY rowid"),
    run: (value = input()) => runAgentTurn(deps, value),
  };
}
function prior(
  db: Database,
  phase: string,
  amount: number,
  createdAt = now(),
  status = "success",
) {
  db.run(
    "INSERT INTO api_calls(id,endpoint,phase,units,estimated_micros,reserved_micros,confirmed_micros,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    id("fixture"),
    "openrouter",
    phase,
    1,
    amount,
    amount,
    status === "success" ? amount : null,
    status,
    createdAt,
  );
}

test("native turns preserve tool results and signed reasoning, resend tools, and reconcile actual charges", async () => {
  const reasoning = [
    {
      type: "reasoning.encrypted",
      data: "opaque-signed-by-provider",
      signature: "unchanged",
      index: 0,
      extra: { formatVersion: 2 },
    },
    { type: "reasoning.summary", summary: "Use scoped observation", index: 1 },
  ];
  let turn = 0;
  const f = harness(async () =>
    ++turn === 1
      ? response(
          {
            role: "assistant",
            content: null,
            tool_calls: [toolCall()],
            reasoning_details: reasoning,
          },
          0.000001,
          "tool_calls",
        )
      : response(),
  );
  try {
    const first = await f.run();
    assert.deepEqual(first.message.reasoning_details, reasoning);
    const second = await f.run(
      input({
        messages: [
          ...messages,
          first.message,
          {
            role: "tool",
            tool_call_id: "call_first",
            content: '{"connected":true}',
          },
        ],
      }),
    );
    assert.equal(second.costKnown, true);
    assert.equal(second.costMicros, 1);
    for (const payload of f.payloads) {
      assert.deepEqual(payload.tools, tools);
      assert.equal("parallel_tool_calls" in payload, false);
      assert.equal(payload.provider.require_parameters, true);
      assert.equal(payload.provider.allow_fallbacks, false);
      assert.deepEqual(payload.provider.max_price, {
        prompt: 0.1,
        completion: 0.2,
        request: 0.0001,
      });
      assert.equal(payload.response_format, undefined);
    }
    assert.deepEqual(f.payloads[1].messages[2].reasoning_details, reasoning);
    assert.equal(f.payloads[1].messages[3].tool_call_id, "call_first");
    assert.ok(second.reservedMicros > first.reservedMicros);
    assert.deepEqual(
      f.rows().map((r) => [r.status, r.confirmed_micros, r.reserved_micros]),
      [
        ["success", 1, 1],
        ["success", 1, 1],
      ],
    );
  } finally {
    f.db.close();
  }
});

test("per-request charges are reserved even with zero token prices", async () => {
  const f = harness(async () => response(), {
    ...model,
    promptPrice: 0,
    completionPrice: 0,
    requestPrice: 0.001,
  });
  try {
    await assert.rejects(f.run(input({ maxCostMicros: 999 })), {
      code: "AI_BUDGET_EXCEEDED",
    });
    assert.equal(f.calls(), 0);
    assert.equal(f.rows().length, 0);
    const result = await f.run(input({ maxCostMicros: 1000 }));
    assert.equal(result.reservedMicros, 1000);
  } finally {
    f.db.close();
  }
});

test("strict routing works with the documented Qwen endpoint that supports tools but not parallel_tool_calls", async () => {
  // Snapshot of the public endpoint capability list, 2026-11-03. No remote request.
  const supported = new Set([
    "reasoning",
    "include_reasoning",
    "max_tokens",
    "temperature",
    "top_p",
    "seed",
    "presence_penalty",
    "response_format",
    "tools",
    "tool_choice",
    "structured_outputs",
    "logprobs",
    "top_logprobs",
    "top_k",
    "frequency_penalty",
    "stop",
    "reasoning_effort",
  ]);
  const f = harness(
    async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      for (const name of [
        "tools",
        "tool_choice",
        "max_tokens",
        "parallel_tool_calls",
      ]) {
        if (name in payload && !supported.has(name))
          throw new ServiceHttpError(
            404,
            "No endpoints support all requested parameters",
          );
      }
      assert.equal(payload.provider.require_parameters, true);
      assert.equal(payload.provider.allow_fallbacks, false);
      assert.equal(payload.provider.max_price.request, 0);
      return response(
        { role: "assistant", content: null, tool_calls: [toolCall()] },
        0.000001,
        "tool_calls",
      );
    },
    { ...model, requestPrice: null },
  );
  try {
    const result = await f.run();
    assert.equal(result.message.tool_calls?.length, 1);
    assert.equal(f.calls(), 1);
  } finally {
    f.db.close();
  }
});

test("optional request pricing remains unknown in the catalog while routing enforces a zero fixed-fee ceiling", async (t) => {
  for (const requestPrice of [null, undefined])
    await t.test(String(requestPrice), async () => {
      const selected = { ...model, requestPrice };
      const f = harness(async () => response(), selected);
      try {
        assert.deepEqual(agentModelPrices(selected), {
          prompt: model.promptPrice,
          completion: model.completionPrice,
          requestPriceKnown: false,
          requestPriceCeiling: 0,
        });
        const result = await f.run();
        assert.equal(f.payloads[0].provider.max_price.request, 0);
        assert.equal(f.payloads[0].provider.require_parameters, true);
        assert.equal(
          selected.requestPrice,
          requestPrice,
          "a routing ceiling must not rewrite an unknown catalog quote",
        );
        assert.match(f.rows()[0].message, /目录未提供固定请求费/);
        assert.ok(result.reservedMicros > 0);
      } finally {
        f.db.close();
      }
    });
  const f = harness(async () => response(), { ...model, requestPrice: -1 });
  try {
    await assert.rejects(f.run(), { code: "MODEL_PRICE_REQUIRED" });
    assert.equal(f.calls(), 0);
    assert.equal(f.keyReads(), 0);
  } finally {
    f.db.close();
  }
});

test("global, exact plan-day, and cross-day cycle reservations block requests before dispatch", async (t) => {
  for (const scope of ["global", "plan", "cycle"] as const)
    await t.test(scope, async () => {
      const f = harness(async () => response());
      try {
        if (scope === "global") {
          f.db.setSetting("dailyAiBudgetMicros", 1000);
          prior(f.db, "copy", 1000);
        }
        if (scope === "plan")
          prior(f.db, "agent:plan_one:previous_cycle", 1_000_000);
        if (scope === "cycle")
          prior(
            f.db,
            "agent:plan_one:cycle_one",
            1_000_000,
            new Date(Date.now() - 2 * 86400000).toISOString(),
          );
        await assert.rejects(f.run(), { code: "AI_BUDGET_EXCEEDED" });
        assert.equal(f.calls(), 0);
        assert.equal(f.rows().length, 1);
      } finally {
        f.db.close();
      }
    });
  const f = harness(async () => response());
  try {
    prior(f.db, "agent:planXone:different_plan", 1_000_000);
    prior(
      f.db,
      "agent:plan_one:old_day",
      1_000_000,
      new Date(Date.now() - 2 * 86400000).toISOString(),
    );
    await f.run();
    assert.equal(
      f.calls(),
      1,
      "underscore in a plan ID must not match a different plan",
    );
  } finally {
    f.db.close();
  }
});

test("unknown billing retains the reservation and forbids another request in that cycle", async () => {
  const f = harness(async () => response(undefined, null));
  try {
    const result = await f.run();
    assert.equal(result.costKnown, false);
    assert.equal(result.costMicros, null);
    assert.equal(f.rows()[0].status, "uncertain");
    assert.equal(f.rows()[0].reserved_micros, result.reservedMicros);
    await assert.rejects(f.run(), {
      code: "AI_COST_UNCERTAIN",
      uncertain: true,
    });
    assert.equal(f.calls(), 1);
  } finally {
    f.db.close();
  }
});

test("in-flight reservations prevent another cycle from overspending, and known actual cost releases unused capacity", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = harness(
    async () => {
      await pending;
      return response();
    },
    { ...model, promptPrice: 0, completionPrice: 0, requestPrice: 0.001 },
  );
  f.db.setSetting("dailyAiBudgetMicros", 1500);
  try {
    const first = f.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.rows()[0].status, "reserved");
    await assert.rejects(
      f.run(
        input({
          budgetScope: { ...input().budgetScope, cycleId: "cycle_second" },
        }),
      ),
      { code: "AI_BUDGET_EXCEEDED" },
    );
    assert.equal(f.calls(), 1);
    release();
    await first;
    await f.run(
      input({
        budgetScope: { ...input().budgetScope, cycleId: "cycle_second" },
      }),
    );
    assert.equal(f.calls(), 2);
    assert.deepEqual(
      f.rows().map((row) => row.reserved_micros),
      [1, 1],
    );
  } finally {
    release();
    f.db.close();
  }
});

test("malformed, parallel, repeated, and truncated tool responses never pass the transport gate, but their charge is kept", async (t) => {
  const cases = [
    {
      label: "parallel",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [toolCall(), toolCall("call_second")],
      },
      finish: "tool_calls",
    },
    {
      label: "unknown tool",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            ...toolCall(),
            function: { name: "arbitrary_shell", arguments: "{}" },
          },
        ],
      },
      finish: "tool_calls",
    },
    {
      label: "truncated",
      message: { role: "assistant", content: "Incomplete" },
      finish: "length",
    },
    {
      label: "inconsistent finish",
      message: { role: "assistant", content: null, tool_calls: [toolCall()] },
      finish: "stop",
    },
  ];
  for (const item of cases)
    await t.test(item.label, async () => {
      const f = harness(async () =>
        response(item.message, 0.000001, item.finish),
      );
      try {
        await assert.rejects(f.run(), { code: "INVALID_AI_RESPONSE" });
        assert.equal(f.rows()[0].confirmed_micros, 1);
        assert.equal(f.calls(), 1);
      } finally {
        f.db.close();
      }
    });
  const f = harness(async () =>
    response(
      { role: "assistant", content: null, tool_calls: [toolCall()] },
      0.000001,
      "tool_calls",
    ),
  );
  try {
    await assert.rejects(
      f.run(
        input({
          messages: [
            ...messages,
            { role: "assistant", content: null, tool_calls: [toolCall()] },
            { role: "tool", tool_call_id: "call_first", content: "{}" },
          ],
        }),
      ),
      { code: "INVALID_AI_RESPONSE" },
    );
    assert.equal(f.rows()[0].confirmed_micros, 1);
  } finally {
    f.db.close();
  }
});

test("unmatched or repeated tool results and oversized inputs fail without a request or credential read", async (t) => {
  const cases: AgentMessage[][] = [
    [...messages, { role: "tool", tool_call_id: "missing", content: "{}" }],
    [
      ...messages,
      { role: "assistant", content: null, tool_calls: [toolCall()] },
    ],
    [
      ...messages,
      { role: "assistant", content: null, tool_calls: [toolCall()] },
      { role: "tool", tool_call_id: "call_first", content: "{}" },
      { role: "tool", tool_call_id: "call_first", content: "{}" },
    ],
    [{ role: "user", content: "x".repeat(200_001) }],
  ];
  for (const [index, conversation] of cases.entries())
    await t.test(String(index), async () => {
      const f = harness(async () => response());
      try {
        await assert.rejects(f.run(input({ messages: conversation })), {
          code: "INVALID_AGENT_REQUEST",
        });
        assert.equal(f.calls(), 0);
        assert.equal(f.keyReads(), 0);
        assert.equal(f.rows().length, 0);
      } finally {
        f.db.close();
      }
    });
});

test("HTTP failures never retry, preserve known bills, and retain bounded safe diagnostics without credentials", async (t) => {
  await t.test("known zero bill", async () => {
    const f = harness(async (_url, _init, _timeout, onResponse) => {
      onResponse?.(JSON.stringify({ usage: { cost: 0 } }), 401);
      throw new ServiceHttpError(
        401,
        "No endpoints support the requested parameters; synthetic-test-credential",
      );
    });
    try {
      await assert.rejects(f.run(), (error) => {
        assert.doesNotMatch(String(error), /synthetic-test-credential/);
        assert.match(String(error), /No endpoints support/);
        return true;
      });
      assert.equal(f.rows()[0].status, "success");
      assert.equal(f.rows()[0].confirmed_micros, 0);
      assert.doesNotMatch(f.rows()[0].message, /synthetic-test-credential/);
      assert.match(f.rows()[0].message, /No endpoints support/);
      assert.equal(f.calls(), 1);
    } finally {
      f.db.close();
    }
  });
  await t.test("unknown bill", async () => {
    const f = harness(async () => {
      throw new ServiceHttpError(503, "untrusted provider detail");
    });
    try {
      await assert.rejects(f.run(), {
        code: "AI_COST_UNCERTAIN",
        uncertain: true,
      });
      assert.equal(f.rows()[0].status, "uncertain");
      assert.ok(f.rows()[0].reserved_micros > 0);
      assert.equal(f.calls(), 1);
    } finally {
      f.db.close();
    }
  });
});

test("abort before dispatch avoids billing; in-flight abort is conservatively uncertain; late abort records returned usage", async (t) => {
  await t.test("before dispatch", async () => {
    const f = harness(async () => response()),
      abort = new AbortController();
    abort.abort();
    try {
      await assert.rejects(f.run(input({ signal: abort.signal })), {
        name: "AbortError",
      });
      assert.equal(f.calls(), 0);
      assert.equal(f.keyReads(), 0);
      assert.equal(f.rows().length, 0);
    } finally {
      f.db.close();
    }
  });
  await t.test("in flight", async () => {
    const abort = new AbortController();
    const f = harness(async (_url, init) => {
      abort.abort();
      init?.signal?.throwIfAborted();
      return response();
    });
    try {
      await assert.rejects(f.run(input({ signal: abort.signal })), {
        code: "AI_COST_UNCERTAIN",
      });
      assert.equal(f.rows()[0].status, "uncertain");
      assert.equal(f.calls(), 1);
    } finally {
      f.db.close();
    }
  });
  await t.test("response received", async () => {
    const abort = new AbortController(),
      f = harness(async () => {
        abort.abort();
        return response();
      });
    try {
      await assert.rejects(f.run(input({ signal: abort.signal })), {
        code: "AI_AGENT_REQUEST_FAILED",
      });
      assert.equal(f.rows()[0].status, "success");
      assert.equal(f.rows()[0].confirmed_micros, 1);
    } finally {
      f.db.close();
    }
  });
});

test("HTTP diagnostics scrub exact arbitrary keys, encoded forms, credential fields and bearer values before retaining a bounded reason", async () => {
  const secret = 'unusual+"key\\&=only-for-this-fixture';
  const forms = [
    secret,
    encodeURIComponent(secret),
    encodeURI(secret),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret).toString("base64"),
  ];
  const f = harness(async () => {
    throw new ServiceHttpError(
      404,
      `No endpoints support all requested parameters. ${forms.join(" | ")} Bearer another-secret api_key=unknown-api-secret key=another-key password=unknown-password ${"x".repeat(600)}`,
    );
  });
  f.deps.getKey = async () => secret;
  try {
    await assert.rejects(f.run(), (error) => {
      const message = String(error);
      assert.match(message, /No endpoints support all requested parameters/);
      assert.ok(message.length < 500);
      for (const value of [
        ...forms,
        "another-secret",
        "unknown-api-secret",
        "another-key",
        "unknown-password",
      ])
        assert.ok(!message.includes(value));
      return true;
    });
    const row = f.rows()[0];
    assert.equal(row.status, "failed");
    assert.equal(row.confirmed_micros, 0);
    assert.equal(row.reserved_micros, 0);
    assert.match(row.message, /No endpoints support all requested parameters/);
    for (const value of [
      ...forms,
      "another-secret",
      "unknown-api-secret",
      "another-key",
      "unknown-password",
    ])
      assert.ok(!row.message.includes(value));
    assert.equal(f.calls(), 1);
  } finally {
    f.db.close();
  }
});

test("actual cost beyond the reservation is recorded and reported as a distinct overrun", async () => {
  const f = harness(async () => response(undefined, 2));
  try {
    await assert.rejects(f.run(), { code: "AI_COST_OVERRUN" });
    assert.equal(f.rows()[0].confirmed_micros, 2_000_000);
    assert.equal(f.rows()[0].reserved_micros, 2_000_000);
  } finally {
    f.db.close();
  }
});

test("only a typed HTTP 404 before provider acceptance is a confirmed zero-cost failure; 502 and HTTP 200 error bodies remain protected", async (t) => {
  await t.test("HTTP 404", async () => {
    const f = harness(async () => {
      throw new ServiceHttpError(
        404,
        "No endpoints support all requested parameters",
      );
    });
    try {
      await assert.rejects(f.run(), {
        code: "AI_AGENT_REQUEST_FAILED",
        uncertain: false,
      });
      assert.equal(f.calls(), 1);
      assert.equal(f.rows()[0].status, "failed");
      assert.equal(f.rows()[0].confirmed_micros, 0);
      assert.equal(f.rows()[0].reserved_micros, 0);
      assert.match(f.rows()[0].message, /No endpoints support/);
    } finally {
      f.db.close();
    }
  });
  await t.test("HTTP 502", async () => {
    const f = harness(async () => {
      throw new ServiceHttpError(502, "Provider connection failed");
    });
    try {
      await assert.rejects(f.run(), {
        code: "AI_COST_UNCERTAIN",
        uncertain: true,
      });
      assert.equal(f.rows()[0].status, "uncertain");
      assert.equal(f.rows()[0].confirmed_micros, null);
      assert.ok(f.rows()[0].reserved_micros > 0);
      assert.equal(f.calls(), 1);
    } finally {
      f.db.close();
    }
  });
  await t.test("HTTP 200 with error.code 404", async () => {
    const f = harness(async () => ({
      error: { code: 404, message: "Failure after provider accepted request" },
    }));
    try {
      await assert.rejects(f.run(), {
        code: "AI_COST_UNCERTAIN",
        uncertain: true,
      });
      assert.equal(f.rows()[0].status, "uncertain");
      assert.ok(f.rows()[0].reserved_micros > 0);
      assert.equal(f.calls(), 1);
    } finally {
      f.db.close();
    }
  });
  await t.test("conflicting positive usage is never erased", async () => {
    const f = harness(async (_url, _init, _timeout, onResponse) => {
      onResponse?.(JSON.stringify({ usage: { cost: 0.000001 } }), 404);
      throw new ServiceHttpError(404, "Contradictory upstream billing");
    });
    try {
      await assert.rejects(f.run(), { code: "AI_AGENT_REQUEST_FAILED" });
      assert.equal(f.rows()[0].status, "success");
      assert.equal(f.rows()[0].confirmed_micros, 1);
      assert.equal(f.rows()[0].reserved_micros, 1);
    } finally {
      f.db.close();
    }
  });
});

test("timeout is combined with the caller signal and keeps an unknown in-flight bill reserved", async () => {
  const f = harness(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(
      f.run(input({ timeoutMs: 1000, signal: new AbortController().signal })),
      { code: "AI_COST_UNCERTAIN" },
    );
    assert.equal(f.calls(), 1);
    assert.equal(f.rows()[0].status, "uncertain");
    assert.ok(f.rows()[0].reserved_micros > 0);
  } finally {
    clearTimeout(keepAlive);
    f.db.close();
  }
});

test("readiness accepts tools-only models and optional fixed fees, requires token pricing, and never decrypts a key", async () => {
  const db = new Database(":memory:");
  let decrypts = 0;
  const secrets = new SecretStore(db, {
    available: () => true,
    encrypt: async (value) => value,
    decrypt: async (value) => {
      decrypts++;
      return value;
    },
  });
  try {
    await secrets.set("openrouter", "synthetic-test-credential");
    db.setSetting("modelCatalog", [model]);
    db.setSetting("model", model.id);
    const ai = new AiService(
      new Repository(db),
      secrets,
      () => {},
      async () => {
        assert.fail("Readiness must not request a service");
      },
    );
    assert.equal(ai.assertAgentConfigured().model, model.id);
    assert.throws(() => ai.assertTextConfigured("analysis"), {
      code: "MODEL_UNSUPPORTED",
    });
    db.setSetting("modelCatalog", [{ ...model, tools: undefined }]);
    assert.throws(() => ai.assertAgentConfigured(), {
      code: "MODEL_UNSUPPORTED",
    });
    db.setSetting("modelCatalog", [{ ...model, requestPrice: null }]);
    assert.equal(ai.assertAgentConfigured().selected.requestPrice, null);
    db.setSetting("modelCatalog", [{ ...model, promptPrice: null }]);
    assert.throws(() => ai.assertAgentConfigured(), {
      code: "MODEL_PRICE_REQUIRED",
    });
    assert.equal(decrypts, 0);
  } finally {
    db.close();
  }
});
