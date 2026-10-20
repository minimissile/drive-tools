import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { AiService } from "../core/ai";
import {
  redactLinks,
  redactPromptText,
  redactPromptInput,
} from "../core/text-safety";
import type { Draft } from "../shared/types";

const summary =
  "开源字体。来源：https://example.org/font.html；作者项目：https://github.com/example/font。适合海报标题和版面设计，保留授权说明。提取码：aB12；不要单独出售字体。";

test("links in Chinese prose are hidden without removing the following facts", () => {
  const safe = redactPromptText(summary);
  assert.match(safe, /适合海报标题和版面设计，保留授权说明/);
  assert.match(safe, /作者项目/);
  assert.match(safe, /不要单独出售字体/);
  assert.doesNotMatch(safe, /https?:|example\.org|github\.com|aB12/);
  for (const ending of [
    "，",
    "。",
    "；",
    "！",
    "？",
    "、",
    "）",
    "】",
    "》",
    "”",
    "’",
    "]",
    ")",
    '"',
    "'",
  ]) {
    const text = redactLinks(
      `参考https://example.org/字体?pwd=demo${ending}后面是完整说明`,
    );
    assert.match(text, /后面是完整说明$/);
    assert.doesNotMatch(text, /example|pwd|demo|字体\?/);
  }
  assert.equal(
    redactLinks("说明www.example.org/字体；继续说明", ""),
    "说明；继续说明",
  );
});

test("nested prompt metadata keeps its structure while removing links and credentials", () => {
  const original = {
    summary,
    items: [
      "参考www.example.org/font，正文保留",
      "API Key: sk-or-v1-abcdefghijklmnop。保留这句话",
      { value: "Bearer token_123；后续说明", ok: true, count: 2, empty: null },
    ],
  };
  const safe = redactPromptInput(original);
  const encoded = JSON.stringify(safe);
  assert.doesNotMatch(encoded, /example\.org|aB12|abcdefghijklmnop|token_123/);
  assert.match(encoded, /正文保留|保留这句话|后续说明/);
  assert.deepEqual((safe as typeof original).items[2], {
    value: "[凭据已省略]；后续说明",
    ok: true,
    count: 2,
    empty: null,
  });
  assert.match(original.summary, /https:/);
});

test("local creative templates preserve real intake descriptions after source URLs", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false, { title: "开源字体", summary });
    const draft = (await f.app.invoke("studio.create", {
      copyId: saved.copyId,
      platform: "xiaohongshu",
      mode: "template",
      format: "carousel",
      pageCount: 2,
    })) as Draft;
    assert.match(draft.body, /适合海报标题和版面设计/);
    assert.match(draft.body, /不要单独出售字体/);
    assert.match(draft.creative!.cards[0].copy, /保留授权说明/);
    assert.doesNotMatch(JSON.stringify(draft), /example\.org|github\.com|aB12/);
    assert.equal(f.app.repo.calls().length, 0);
  } finally {
    await f.cleanup();
  }
});

test("legacy keyword and draft generation both sanitize supplied metadata before any model request", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false, { title: "开源字体", summary });
    await f.app.secrets.set("openrouter", "test-only-ai-key");
    f.app.db.setSetting("model", "test/text");
    f.app.db.setSetting("modelCatalog", [
      {
        id: "test/text",
        structured: true,
        promptPrice: 0.0000001,
        completionPrice: 0.0000001,
      },
    ]);
    f.app.db.setSetting("dailyAiBudgetMicros", 1_000_000);
    const payloads: any[] = [];
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async (_url, init) => {
        const payload = JSON.parse(String(init?.body));
        payloads.push(payload);
        return {
          usage: { cost: 0.001 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  keywords: [{ word: "开源字体", intent: "选素材" }],
                  title: "开源字体",
                  body: "仅依据已知资料说明。",
                  tags: ["字体"],
                  coverText: "字体整理",
                }),
              },
            },
          ],
        };
      },
    );
    await ai.extract(saved.resourceId);
    await ai.draft(saved.copyId, "xiaohongshu", null);
    assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      const content = payload.messages[1].content;
      assert.match(content, /适合海报标题和版面设计/);
      assert.match(content, /不要单独出售字体/);
      assert.doesNotMatch(
        content,
        /https?:|www\.|github\.com|aB12|test-only-ai-key/,
      );
    }
  } finally {
    await f.cleanup();
  }
});
