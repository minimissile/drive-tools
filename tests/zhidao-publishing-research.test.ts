import test from "node:test";
import assert from "node:assert/strict";
import type { AiService } from "../core/ai";
import type { PublishingRecord } from "../shared/zhidao-workflow";
import { researchPublishingTopics } from "../core/zhidao/publishing-research";
import {
  planPublishingTopics,
  generatePublishingBatch,
  publishingDraftBatches,
} from "../core/zhidao/publishing-generation";

const record = {
  resource: {
    title: "示例剧",
    category: "影视",
    summary: "",
    keywords: ["示例剧剧情解析"],
  },
} as PublishingRecord;
test("补充资料只采用实际返回带摘录的来源，拒绝模型自造网址；不把关键词泄露为网盘地址", async () => {
  let authorizations = 0;
  const ai = {
    resourceExport: async (
      _name,
      schema,
      _instruction,
      input,
      _images,
      options,
    ) => {
      options?.beforeRequest?.();
      assert.equal(options?.webSearch, true);
      assert.deepEqual(
        Object.keys((input as { resource: object }).resource).sort(),
        ["category", "summary", "title"],
      );
      options?.onWebSources?.([
        {
          url: "https://example.com/official",
          title: "测试官方介绍",
          content: "在海岛重逢的两人共同面对家庭冲突。",
        },
      ]);
      return schema.parse({
        facts: [
          {
            statement: "两人在海岛重逢并面对家庭冲突。",
            sourceUrls: ["https://example.com/official"],
          },
          {
            statement: "角色最终结婚。",
            sourceUrls: ["https://invented.example/ending"],
          },
        ],
        gaps: ["没有结局依据"],
      });
    },
  } as Pick<AiService, "resourceExport">;
  const result = await researchPublishingTopics(ai, record, () => {
    authorizations++;
  });
  assert.equal(authorizations, 1);
  assert.equal(result.facts.length, 1);
  assert.equal(result.sources.length, 1);
  assert.ok(result.gaps.some((gap) => gap.includes("未返回")));
});

test("无介绍且无检索事实时不能让模型凭关键词规划剧情题；有具体介绍仍需回答要点", async () => {
  for (const [summary, answerPoints] of [
    ["", ["剧情分析"]],
    ["测试提供剧情梗概", []],
  ] as const) {
    const ai = {
      resourceExport: async (_name, schema) =>
        schema.parse({
          groups: [
            {
              index: 0,
              related: [],
              intent: "剧情解析",
              kind: "knowledge",
              answerPoints,
            },
          ],
          excluded: [],
        }),
    } as Pick<AiService, "resourceExport">;
    await assert.rejects(
      () =>
        planPublishingTopics(
          ai,
          { ...record, resource: { ...record.resource, summary } },
          () => {},
        ),
      /缺少具体回答要点或事实资料/,
    );
  }
});

test("真实首轮问题回归：官网集数不证明网盘全集，获取批次不读取网页与知识稿", async () => {
  const r = {
    ...record,
    rows: [],
    resource: {
      ...record.resource,
      title: "示例剧百度网盘4K资源",
      keywords: ["示例剧全集观看", "示例剧最新更新"],
    },
    generation: {
      id: "fixture",
      status: "running",
      targets: [0, 1],
      research: {
        checkedAt: new Date().toISOString(),
        sources: [],
        facts: [{ statement: "官网12集全，不代表本地文件。", sourceUrls: [] }],
        gaps: [],
      },
      topics: [
        {
          id: "0",
          keyword: "示例剧全集观看",
          relatedKeywords: [],
          kind: "resource",
          answerPoints: ["官网12集全"],
        },
        {
          id: "1",
          keyword: "示例剧最新更新",
          relatedKeywords: [],
          kind: "knowledge",
          answerPoints: ["按官网12集的播出信息解答"],
        },
      ],
      drafts: [
        {
          index: 1,
          question: "示例剧更新到几集了？",
          introduction: "官网的12集全只适用于播出平台，不代表网盘副本。",
        },
      ],
    },
  } as PublishingRecord;
  assert.deepEqual(publishingDraftBatches(r, [0, 1]), [[0], [1]]);
  const ai = {
    resourceExport: async (_name, schema, _instruction, raw) => {
      const input = raw as {
        resource: { research?: unknown };
        rows: { answerPoints: string[] }[];
        previous: unknown[];
      };
      assert.equal(input.resource.research, undefined);
      assert.deepEqual(input.rows[0].answerPoints, []);
      assert.deepEqual(
        input.previous,
        [],
        "知识稿里的官网信息不进入获取写作批次",
      );
      return schema.parse({
        rows: [
          {
            index: 0,
            question: "示例剧百度网盘全集链接在哪？",
            introduction:
              "所选示例剧属于影视资源分类，用于验证本次资源与平台播出信息的边界。",
          },
        ],
      });
    },
  } as Pick<AiService, "resourceExport">;
  await assert.rejects(
    () => generatePublishingBatch(ai, r, [], [0], () => {}),
    /官网信息不能代替网盘文件依据/,
  );
});
