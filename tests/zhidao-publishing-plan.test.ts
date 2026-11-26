import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import cases from "./fixtures/zhidao-publishing-20261124.json";
import {
  planPublishingTopics,
  publishingKeywordExclusion,
  distinctSupportedWindowsScopes,
  reviewPublishingDrafts,
} from "../core/zhidao/publishing-generation";
import type { PublishingRecord } from "../shared/zhidao-workflow";
import type { AiService } from "../core/ai";

function record(source: (typeof cases)[number]): PublishingRecord {
  return {
    id: randomUUID(),
    resource: {
      ...source,
      key: randomUUID(),
      link: "https://pan.baidu.com/s/test",
      resourceId: "",
      copyId: "",
    },
    contentFirst: true,
    rows: [],
    links: [],
    operations: [],
    copyId: "",
    libraryResourceId: "",
    accountId: "",
    stage: "draft",
    message: "",
    updatedAt: new Date().toISOString(),
  };
}
const response = (value: unknown): Pick<AiService, "resourceExport"> => ({
  resourceExport: (async (_name, schema) =>
    schema.parse(value)) as AiService["resourceExport"],
});

for (const source of cases) {
  test(`最新实录回放：${source.keywords.length}个词的旧分组不能无说明丢词`, async () => {
    const groups = source.oldTopics.map((topic) => ({
      index: source.keywords.indexOf(topic.keyword),
      related: topic.relatedKeywords.map((keyword) =>
        source.keywords.indexOf(keyword),
      ),
      intent: topic.keyword,
    }));
    await assert.rejects(
      () =>
        planPublishingTopics(
          response({ groups, excluded: [] }),
          record(source),
          () => {},
        ),
      /未说明去向/,
    );
  });
}

test("相关下载词并入同组，全部87个词均能保存明确去向，问答数不要求凑20", async () => {
  for (const source of cases) {
    const indexes = source.keywords.flatMap((word, index) =>
      /(?:下载|小工具|软件)$/.test(word) && !/免费|官网/.test(word)
        ? [index]
        : [],
    );
    const result = await planPublishingTopics(
      response({
        groups: [
          {
            index: indexes[0],
            related: indexes.slice(1),
            intent: "相同资源安装包获取",
          },
        ],
        excluded: source.keywords.flatMap((_, index) =>
          indexes.includes(index) ||
          publishingKeywordExclusion(
            source.keywords[index],
            record(source).resource,
          )
            ? []
            : [{ index, reason: "测试取舍记录：本词需补充资源依据后再采用" }],
        ),
      }),
      record(source),
      () => {},
    );
    assert.equal(result.topics.length, 1);
    assert.equal(
      result.topics[0].relatedKeywords.length +
        1 +
        result.excludedKeywords.length,
      source.keywords.length,
    );
  }
});

test("意图检查拿到完整资源事实、原分组和全部17条旧文案，不把关联词当事实", async () => {
  let checked = 0;
  for (const source of cases) {
    const r = record(source);
    r.rows = source.oldRows.map((row) => ({ ...row, reviewed: false }));
    r.generation = {
      id: randomUUID(),
      status: "running",
      targets: r.rows.map((_, index) => index),
      drafts: [],
      topics: source.oldTopics,
    };
    const ai: Pick<AiService, "resourceExport"> = {
      resourceExport: (async (name, schema, instruction, input) => {
        assert.equal(name, "zhidao_publishing_review");
        assert.match(instruction, /跨行检查语义重复/);
        const value = input as {
          resource: { summary: string };
          rows: { question: string; introduction: string; keyword: string }[];
        };
        assert.equal(value.resource.summary, source.summary);
        assert.equal(value.rows.length, source.oldRows.length);
        assert.ok(
          value.rows.every(
            (row) => row.question && row.introduction && row.keyword,
          ),
        );
        checked += value.rows.length;
        return schema.parse({ issues: [] });
      }) as AiService["resourceExport"],
    };
    assert.deepEqual(await reviewPublishingDrafts(ai, r, () => {}), []);
  }
  assert.equal(checked, 17);
});

test("方法类词交给事实规划，不再提前排除；无依据版本仍拦截", () => {
  const resource = record(cases[0]).resource;
  assert.equal(
    publishingKeywordExclusion("共享打印机主机ip地址怎么看", resource),
    "",
  );
  assert.match(
    publishingKeywordExclusion("一键共享打印机工具V1.0", resource),
    /版本依据/,
  );
  assert.equal(
    publishingKeywordExclusion("一键共享打印机工具V1.0", {
      ...resource,
      summary: "提供V1.0版工具",
    }),
    "",
  );
  assert.match(
    publishingKeywordExclusion("一键共享打印机工具V1.01", {
      ...resource,
      summary: "提供V1.0版工具",
    }),
    /版本依据/,
  );
  assert.equal(
    publishingKeywordExclusion("Python使用教程下载", {
      ...resource,
      title: "Python使用教程",
    }),
    "",
  );
});

test("预筛不重排原序号：无依据版本词有原因，其余获取词仍完整合并", async () => {
  const r = record(cases[0]);
  r.resource.keywords = [
    "一键共享打印机下载",
    "一键共享打印机V1.0",
    "打印机一键共享工具",
  ];
  const ai: Pick<AiService, "resourceExport"> = {
    resourceExport: (async (_name, schema, _instruction, input) => {
      assert.deepEqual(
        (input as { keywords: { index: number }[] }).keywords.map(
          (word) => word.index,
        ),
        [0, 2],
      );
      return schema.parse({
        groups: [{ index: 0, related: [2], intent: "相同软件工具获取" }],
        excluded: [],
      });
    }) as AiService["resourceExport"],
  };
  const plan = await planPublishingTopics(ai, r, () => {});
  assert.deepEqual(plan.topics[0].relatedKeywords, [r.resource.keywords[2]]);
  assert.equal(plan.excludedKeywords[0].keyword, r.resource.keywords[1]);
  assert.match(plan.excludedKeywords[0].reason, /版本依据/);
});

test("受支持系统判定：通用/Win7/Win10允许区别，同系统、单系统泛化、无依据系统与标题丢限定仍检查重复", () => {
  const resource = record(cases[0]).resource;
  const general = {
    keyword: "一键共享打印机下载",
    relatedKeywords: [],
    question: "一键共享打印机百度网盘链接在哪？",
  };
  const win7 = {
    keyword: "win7打印机一键共享",
    relatedKeywords: [],
    question: "Win7一键共享打印机百度网盘链接在哪？",
  };
  const win10 = {
    keyword: "WIN10一键共享打印软件",
    relatedKeywords: [],
    question: "Win10一键共享打印机百度网盘链接在哪？",
  };
  assert.equal(distinctSupportedWindowsScopes(resource, general, win7), true);
  assert.equal(distinctSupportedWindowsScopes(resource, win7, win10), true);
  assert.equal(
    distinctSupportedWindowsScopes(resource, win7, {
      ...win7,
      keyword: "Win7共享打印工具",
    }),
    false,
  );
  assert.equal(
    distinctSupportedWindowsScopes(resource, general, {
      ...win7,
      question: general.question,
    }),
    false,
  );
  assert.equal(
    distinctSupportedWindowsScopes(
      { ...resource, title: "打印软件", summary: "仅支持Win7" },
      general,
      win7,
    ),
    false,
  );
  assert.equal(
    distinctSupportedWindowsScopes(
      { ...resource, title: "打印软件", summary: "支持Win10和Win11" },
      win7,
      win10,
    ),
    false,
  );
});

test("真实误判回放：同一资源通用题和受支持系统题不因AI误报重复而整批阻断，真正重复保留", async () => {
  const r = record(cases[0]);
  const topics = [cases[0].oldTopics[0], cases[0].oldTopics[2]];
  r.generation = {
    id: randomUUID(),
    status: "running",
    targets: [0, 1],
    topics,
    drafts: [
      {
        index: 0,
        question: "一键共享打印机的百度网盘链接在哪？",
        introduction: "局域网打印机共享与常见连接错误修复工具。",
      },
      {
        index: 1,
        question: "Win10一键共享打印工具百度网盘链接在哪？",
        introduction: "用于Win10系统下打印机共享和连接错误修复。",
      },
    ],
  };
  const ai = response({
    issues: [
      {
        index: 0,
        kind: "duplicate",
        duplicateOf: 1,
        reason: "与系统限定题相同资源，通用获取题疑似重复",
      },
    ],
  });
  assert.deepEqual(await reviewPublishingDrafts(ai, r, () => {}), []);
  r.generation.topics![1] = { ...topics[0], id: randomUUID() };
  assert.equal((await reviewPublishingDrafts(ai, r, () => {})).length, 1);
});
