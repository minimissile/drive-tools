import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { fixture } from "./helpers";
import { AiService } from "../core/ai";
import { ServiceHttpError } from "../core/errors";
import {
  aiPurposes,
  resolveAiModels,
  recommendAiModels,
  purposeForCall,
  type AiCatalog,
} from "../shared/ai-models";

const text = (id: string, imageInput = false) => ({
  id,
  name: id,
  structured: true,
  imageInput,
  promptPrice: 1e-7,
  completionPrice: 1e-7,
  reasoningEfforts: ["low", "medium"],
});
const media = (id: string, kind: "image" | "video") => ({
  id,
  name: id,
  kind,
  ratios: ["9:16", "3:4"],
  durations: kind === "video" ? [8] : [],
  resolutions: [],
  audio: false,
  reference: false,
  pricing: "测试",
});
const catalog: AiCatalog = {
  text: [
    text("anthropic/claude-sonnet-5.5"),
    text("qwen/qwen3.8-max-0902", true),
    text("anthropic/claude-opus-5.5", true),
  ],
  media: [
    media("openai/gpt-image-2.5-sunburst", "image"),
    media("google/veo-3.1", "video"),
  ],
};
test("role recommendations use available capable models and preserve legacy text settings", () => {
  const recommended = recommendAiModels(catalog);
  assert.equal(recommended.copy, catalog.text[0].id);
  assert.equal(recommended.analysis, catalog.text[1].id);
  assert.equal(recommended.vision, catalog.text[2].id);
  assert.equal(recommended.image, catalog.media[0].id);
  assert.equal(recommended.video, catalog.media[1].id);
  assert.deepEqual(
    recommendAiModels({ text: [], media: [] }),
    Object.fromEntries(aiPurposes.map((p) => [p, ""])),
  );
  assert.deepEqual(resolveAiModels(null, "legacy"), {
    copy: "legacy",
    analysis: "legacy",
    vision: "legacy",
    image: "",
    video: "",
  });
  assert.equal(purposeForCall("resource_export_article"), "copy");
  assert.equal(purposeForCall("resource_export_plan", true), "vision");
  assert.equal(purposeForCall("resource_export_match"), "analysis");
  assert.equal(purposeForCall("keyword_ideas"), "analysis");
});
test("settings validate capabilities atomically and route actual requests by purpose", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false);
    await f.app.secrets.set("openrouter", "test-role-key");
    f.app.db.setSetting("model", "legacy");
    f.app.db.setSetting("modelCatalog", catalog.text);
    f.app.db.setSetting("studio:modelCatalog", catalog.media);
    const selected = recommendAiModels(catalog);
    const args = {
      model: selected.copy,
      aiModels: selected,
      exportCodes: false,
      bitUrl: "",
      dailyAiBudgetMicros: null,
    };
    await f.app.invoke("settings.save", args);
    assert.deepEqual(f.app.snapshot().settings.aiModels, selected);
    await assert.rejects(
      f.app.invoke("settings.save", {
        ...args,
        aiModels: { ...selected, vision: selected.copy },
      }),
      { code: "MODEL_CAPABILITY_MISMATCH" },
    );
    await assert.rejects(
      f.app.invoke("settings.save", {
        ...args,
        aiModels: { ...selected, video: selected.image },
      }),
      { code: "MODEL_CAPABILITY_MISMATCH" },
    );
    assert.deepEqual(f.app.db.setting("aiModels", null), selected);
    const payloads: any[] = [];
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async (_url, init) => {
        const p = JSON.parse(String(init?.body));
        payloads.push(p);
        return {
          usage: { cost: 0.001 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  keywords: [{ word: "教学", intent: "学习" }],
                  title: "资料整理",
                  body: "依据记录整理正文",
                  tags: [],
                  coverText: "整理",
                  cards: [],
                  videoPrompt: "",
                  voiceover: "",
                  ok: true,
                }),
              },
            },
          ],
        };
      },
    );
    await ai.extract(saved.resourceId);
    await ai.creativeDraft({ format: "text" });
    await ai.resourceExport(
      "resource_export_plan",
      z.object({ ok: z.boolean() }),
      "识图",
      {},
      ["data:image/png;base64,TEST"],
    );
    assert.deepEqual(
      payloads.map((p) => p.model),
      [selected.analysis, selected.copy, selected.vision],
    );
    assert.ok(Array.isArray(payloads[2].messages[1].content));
    assert.deepEqual(payloads[0].reasoning, {
      effort: "medium",
      exclude: true,
    });
    assert.deepEqual(payloads[1].reasoning, { effort: "low", exclude: true });
    await assert.rejects(ai.creativeDraft({ format: "image", pageCount: 1 }), {
      code: "CREATIVE_PLAN_INVALID",
    });
    const cardsSchema =
      payloads[3].response_format.json_schema.schema.properties.cards;
    assert.equal(cardsSchema.minItems, 1);
    assert.equal(cardsSchema.maxItems, 1);
    const before = f.app.repo.calls().length;
    await f.app.invoke("settings.save", args);
    assert.equal(
      f.app.repo.calls().length,
      before,
      "saving settings does not generate content",
    );
    await f.app.invoke("settings.save", {
      model: "legacy-client",
      exportCodes: false,
      bitUrl: "",
      dailyAiBudgetMicros: null,
    });
    assert.deepEqual(
      f.app.db.setting("aiModels", null),
      selected,
      "legacy clients must not clear per-purpose choices",
    );
  } finally {
    await f.cleanup();
  }
});
test("local AI preflight validates saved configuration without decrypting or requesting", async () => {
  const f = await fixture();
  try {
    f.app.secrets.get = async () => {
      throw Error("preflight must not decrypt");
    };
    let requests = 0;
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async () => {
        requests++;
        throw Error("preflight must not request");
      },
    );
    assert.throws(() => ai.assertTextConfigured("copy"), {
      code: "API_KEY_REQUIRED",
    });
    await f.app.secrets.set("openrouter", "preflight-test-key");
    assert.throws(() => ai.assertTextConfigured("copy"), {
      code: "MODEL_REQUIRED",
    });
    f.app.db.setSetting("model", "legacy");
    assert.equal(ai.assertTextConfigured("copy").model, "legacy");
    f.app.db.setSetting("modelCatalog", [
      { ...text("legacy"), structured: false },
    ]);
    assert.throws(() => ai.assertTextConfigured("copy"), {
      code: "MODEL_UNSUPPORTED",
    });
    f.app.db.setSetting("modelCatalog", [text("legacy")]);
    assert.throws(() => ai.assertTextConfigured("vision"), {
      code: "VISION_MODEL_REQUIRED",
    });
    f.app.db.setSetting("modelCatalog", [text("legacy", true)]);
    assert.equal(ai.assertTextConfigured("vision").model, "legacy");
    assert.equal(requests, 0);
    assert.equal(f.app.repo.calls().length, 0);
  } finally {
    await f.cleanup();
  }
});
test("known provider rejections are retained and excluded from recommendations without automatic retries", async () => {
  const f = await fixture();
  try {
    await f.app.secrets.set("openrouter", "test-role-key");
    f.app.db.setSetting("modelCatalog", catalog.text);
    f.app.db.setSetting("aiModels", recommendAiModels(catalog));
    let requests = 0;
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async () => {
        requests++;
        throw new ServiceHttpError(403, "model unavailable in region");
      },
    );
    await assert.rejects(ai.creativeDraft({ format: "text" }), {
      code: "HTTP_ERROR",
    });
    assert.equal(requests, 1);
    const call = f.app.repo.calls().at(0)!;
    assert.equal(call.status, "failed");
    assert.equal(call.confirmedMicros, null);
    const next = {
      ...catalog,
      text: f.app.db.setting<AiCatalog["text"]>("modelCatalog", []),
    };
    assert.match(next.text[0].lastError!, /region/);
    next.text.push(text("anthropic/claude-sonnet-5"));
    assert.equal(recommendAiModels(next).copy, catalog.text[1].id);
    next.text.push({
      ...text("google/gemini-3.8-flash", true),
      lastError: "not available in your region",
    });
    assert.equal(recommendAiModels(next).vision, catalog.text[1].id);
    assert.equal(
      recommendAiModels(next).video,
      "google/veo-3.1",
      "text endpoint region failures do not exclude the separate video endpoint",
    );
    assert.equal(
      f.app.db.setting<any>("aiModels", {}).copy,
      catalog.text[0].id,
      "failure does not silently change chosen models",
    );
  } finally {
    await f.cleanup();
  }
});
