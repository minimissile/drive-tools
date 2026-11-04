import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Database } from "../core/database";
import { Repository } from "../core/repository";
import { SecretStore } from "../core/secrets";
import { AiService } from "../core/ai";
import type { fetchJson } from "../core/http";

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

async function fixture(response: Record<string, unknown>) {
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
  const request: typeof fetchJson = async () => {
    requests++;
    return response;
  };
  const ai = new AiService(new Repository(db), secrets, () => {}, request);
  return {
    db,
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
      } finally {
        f.db.close();
      }
    });
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
