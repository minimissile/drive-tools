import test from "node:test";
import assert from "node:assert/strict";
import { imagePriceLines, videoPriceLines } from "../core/model-pricing";
import { loadMediaModelCatalog } from "../core/media-model-catalog";
import { AiService } from "../core/ai";
import { fixture } from "./helpers";
import {
  modelDropdownOptions,
  recommendPurposeModel,
  modelPriceSummary,
} from "../src/ai/model-recommendations";
import {
  modelsForPurpose,
  type AiCatalog,
  type AiModel,
} from "../shared/ai-models";
import type { MediaModel } from "../shared/studio";

const text = (id: string, imageInput = true): AiModel => ({
  id,
  name: id,
  structured: true,
  imageInput,
  promptPrice: 0.00000015,
  completionPrice: 0.00000047,
});
const media = (id: string, kind: "image" | "video"): MediaModel => ({
  id,
  name: id,
  kind,
  ratios: ["16:9"],
  durations: [8],
  resolutions: ["1080p"],
  reference: false,
  audio: true,
  pricing: "",
  priceLines: [
    {
      billable: kind === "image" ? "output_image" : "output_video",
      unit: kind === "image" ? "image" : "second",
      usd: 0.03,
    },
  ],
});

test("existing model dropdown adds labeled presets while saving only real IDs and keeping all manual options", () => {
  const catalog: AiCatalog = {
    text: [
      text("qwen/qwen3.8-flash"),
      text("qwen/qwen3.8-max-0902"),
      text("anthropic/claude-sonnet-5.5"),
      text("other/manual"),
    ],
    media: [],
  };
  const options = modelDropdownOptions(catalog, "copy");
  assert.match(options[0].label, /性价比优先.*Qwen|性价比优先.*qwen/);
  assert.match(options[0].label, /\$0.15/);
  assert.match(options[1].label, /均衡推荐/);
  assert.match(options[2].label, /效果优先/);
  assert.deepEqual(
    options.map((o) => o.value),
    catalog.text.map((m) => m.id),
  );
  const analysis = modelDropdownOptions(catalog, "analysis");
  const max = analysis.find((o) => o.value === "qwen/qwen3.8-max-0902")!;
  assert.match(max.label, /均衡推荐 \/ 效果优先/);
  assert.equal(new Set(analysis.map((o) => o.value)).size, analysis.length);
  assert.deepEqual(modelDropdownOptions({ text: [], media: [] }, "video"), []);
});

test("text catalog retains official prices and capabilities; image-only output cannot be selected for copy", async () => {
  const f = await fixture();
  try {
    let requests = 0;
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async (url, init) => {
        requests++;
        assert.equal(url, "https://openrouter.ai/api/v1/models");
        assert.notEqual(init?.method, "POST");
        return {
          data: [
            {
              id: "qa/vision",
              description: "Official description",
              context_length: 1000000,
              pricing: {
                prompt: "0.00000015",
                completion: "0.00000047",
                request: "0.001",
                overrides: [{}],
              },
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              supported_parameters: ["structured_outputs"],
            },
            {
              id: "qa/image-only",
              pricing: {},
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["image"],
              },
              supported_parameters: ["response_format"],
            },
          ],
        };
      },
    );
    const models = await ai.models();
    assert.equal(models[0].requestPrice, 0.001);
    assert.equal(models[0].contextLength, 1000000);
    assert.equal(models[0].description, "Official description");
    assert.ok(models[0].pricingUpdatedAt);
    assert.match(models[0].pricingNote!, /阶梯报价/);
    assert.deepEqual(
      modelsForPurpose("vision", { text: models, media: [] }).map((m) => m.id),
      ["qa/vision"],
    );
    assert.deepEqual(
      modelsForPurpose("copy", { text: models, media: [] }).map((m) => m.id),
      ["qa/vision"],
    );
    assert.equal(models[1].promptPrice, null);
    assert.equal(requests, 1);
    assert.equal(f.app.repo.calls().length, 0);
  } finally {
    await f.cleanup();
  }
});

test("three recommendation plans use capable models, skip failed providers and never replace missing quotes with free prices", () => {
  const catalog: AiCatalog = {
    text: [
      text("qwen/qwen3.8-flash"),
      text("qwen/qwen3.8-max-0902"),
      text("anthropic/claude-sonnet-5.5"),
      text("anthropic/claude-opus-5.5"),
      text("google/gemini-3.8-flash"),
    ],
    media: [
      media("qwen/qwen-image-2.1-turbo", "image"),
      media("qwen/qwen-image-3", "image"),
      media("openai/gpt-image-2.5-sunburst", "image"),
      media("google/veo-3.1-lite", "video"),
      media("google/veo-3.1-fast", "video"),
      media("google/veo-3.1", "video"),
    ],
  };
  assert.equal(
    recommendPurposeModel(catalog, "copy", "value")?.id,
    "qwen/qwen3.8-flash",
  );
  assert.equal(
    recommendPurposeModel(catalog, "copy", "balanced")?.id,
    "qwen/qwen3.8-max-0902",
  );
  assert.equal(
    recommendPurposeModel(catalog, "copy", "quality")?.id,
    "anthropic/claude-sonnet-5.5",
  );
  assert.equal(
    recommendPurposeModel(catalog, "vision", "quality")?.id,
    "anthropic/claude-opus-5.5",
  );
  for (const p of ["image", "video"] as const)
    for (const strategy of ["value", "balanced", "quality"] as const)
      assert.ok(recommendPurposeModel(catalog, p, strategy));
  catalog.text[0].imageInput = false;
  assert.equal(recommendPurposeModel(catalog, "vision", "value"), undefined);
  catalog.text[0].promptPrice = null;
  assert.equal(recommendPurposeModel(catalog, "copy", "value"), undefined);
  catalog.text[1].textOutput = false;
  assert.equal(
    recommendPurposeModel(catalog, "analysis", "balanced")?.id,
    "google/gemini-3.8-flash",
  );
  catalog.text[2].lastError = "model unavailable in region";
  assert.equal(
    recommendPurposeModel(catalog, "vision", "quality")?.id,
    "google/gemini-3.8-flash",
  );
  catalog.media[0].priceLines = [
    { billable: "input_image", unit: "image", usd: 0 },
  ];
  assert.equal(recommendPurposeModel(catalog, "image", "value"), undefined);
  catalog.media[0].priceLines = media("x", "image").priceLines;
  catalog.media[0].pricingError = "stale";
  assert.equal(recommendPurposeModel(catalog, "image", "value"), undefined);
  assert.equal(
    recommendPurposeModel({ text: [], media: [] }, "video", "quality"),
    undefined,
  );
});

test("endpoint image prices retain provider, input/output, variants and token units without guessing per-image prices", () => {
  const lines = imagePriceLines({
    endpoints: [
      {
        provider_name: "P",
        pricing: [
          { billable: "input_image", unit: "image", cost_usd: 0 },
          {
            billable: "output_image",
            unit: "token",
            cost_usd: "0.00003",
            variant: "high",
          },
          { billable: "output_image", unit: "image", cost_usd: null },
          { billable: "output_image", unit: "image", cost_usd: false },
        ],
      },
    ],
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[1].provider, "P");
  assert.equal(lines[1].variant, "high");
  const quote = modelPriceSummary({
    ...media("token-image", "image"),
    priceLines: lines,
  });
  assert.match(quote.rate, /\$30\/百万/);
  assert.doesNotMatch(quote.rate, /张|免费/);
  assert.match(quote.example, /暂不换算/);
});

test("video dollars, cents, tokens, resolution and audio are kept distinct", () => {
  const lines = videoPriceLines({
    duration_seconds_without_audio_720p: "0.03",
    duration_seconds_with_audio: "0.08",
    cents_per_video_output_second_1080p: "14",
    video_tokens: "0.000007",
    cents_per_image_input: "1",
    minimum_cents_per_generation: "56",
    duration_seconds_invalid: null,
  });
  assert.equal(lines.length, 6);
  assert.equal(lines[2].usd, 0.14);
  assert.equal(lines[2].unit, "second");
  assert.equal(lines[3].unit, "token");
  assert.equal(lines[4].usd, 0.01);
  assert.equal(lines[5].usd, 0.56);
  assert.match(lines[0].variant!, /无音频.*720p/);
  const scene = videoPriceLines({
    text_to_video_duration_seconds_720p: "0.08",
    image_to_video_duration_seconds_1080p: "0.15",
  });
  assert.equal(scene[0].unit, "second");
  assert.match(scene[0].variant!, /文生视频.*720p/);
  assert.match(scene[1].variant!, /图生视频.*1080p/);
  const summary = modelPriceSummary({
    ...media("video", "video"),
    priceLines: lines,
  });
  assert.match(summary.rate, /\$0.03–\$0.14\/秒/);
  assert.match(summary.example, /\$0.24–\$1.12/);
  assert.match(modelPriceSummary(text("text")).example, /\$0.00077/);
});

test("metadata refresh uses bounded GETs, preserves old quotes on partial failure and performs no generation", async () => {
  const old = {
    ...media("qa/image-b", "image"),
    pricingUpdatedAt: "2026-10-01T00:00:00.000Z",
  };
  let active = 0,
    peak = 0;
  const urls: string[] = [];
  const catalog = await loadMediaModelCatalog(
    async (url, init) => {
      assert.notEqual(init?.method, "POST");
      urls.push(url);
      if (url.endsWith("/images/models"))
        return {
          data: Array.from({ length: 6 }, (_, i) => ({
            id: i === 1 ? "qa/image-b" : `qa/image-${i}`,
            architecture: { output_modalities: ["image"] },
          })),
        };
      if (url.endsWith("/videos/models"))
        return {
          data: [
            {
              id: "qa/video",
              pricing_skus: { cents_per_video_output_second_720p: "3" },
            },
          ],
        };
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((r) => setTimeout(r, 5));
        if (url.includes("image-b")) throw new Error("offline");
        return {
          endpoints: [
            {
              pricing: [
                { billable: "output_image", unit: "image", cost_usd: 0.0184 },
              ],
            },
          ],
        };
      } finally {
        active--;
      }
    },
    [old],
    {},
  );
  assert.ok(peak <= 4);
  assert.equal(urls.length, 8);
  const stale = catalog.find((m) => m.id === old.id)!;
  assert.equal(stale.pricingUpdatedAt, old.pricingUpdatedAt);
  assert.deepEqual(stale.priceLines, old.priceLines);
  assert.match(stale.pricingError!, /保留旧报价/);
  assert.equal(catalog.at(-1)!.priceLines![0].usd, 0.03);
  assert.match(catalog[0].pricing, /\$0.0184/);
});
