import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, file } from "./helpers";
import { ZhidaoPublishingWorkflow } from "../core/zhidao/publishing-workflow";
import {
  preparePublishingSchema,
  type PublishingRecord,
  publishingRowsWithLinks,
  publishingLinkIssue,
} from "../shared/zhidao-workflow";
import type { ShareCreation } from "../core/share-creation";
import type { ShareCreationReceipt } from "../shared/share-creation";
import { readXlsx } from "../core/table-files";
import type { Account, ShareCheck } from "../shared/types";
import {
  defaultGenerationRules,
  generationHtml,
  generationQuestion,
} from "../shared/zhidao-generation";
import { publishingGenerationInstruction } from "../core/zhidao/publishing-generation";
import coverageReplay from "./fixtures/zhidao-keyword-coverage-20261125.json";

type GenerationInput = {
  resource: {
    title: string;
    summary: string;
    category: string;
    files: { name: string }[];
  };
  rows: {
    index: number;
    keyword: string;
    kind?: string;
    answerPoints?: string[];
  }[];
  previous: { question: string; introduction: string }[];
};

async function setup() {
  const f = await fixture();
  await f.app.secrets.set("openrouter", "fixture-key");
  f.app.db.setSetting("model", "fixture-model");
  const aiCalls: GenerationInput[] = [];
  let planOutput: unknown;
  let reviewOutput: unknown = { issues: [] };
  const reviewCalls: unknown[] = [];
  const planCalls: unknown[] = [];
  const researchCalls: unknown[] = [];
  let aiOutput: ((input: GenerationInput) => unknown) | undefined;
  let beforeAi: (() => Promise<void> | void) | undefined;
  f.app.ai.resourceExport = (async (
    _name,
    schema,
    instruction,
    input,
    _images,
    options,
  ) => {
    if (_name === "zhidao_publishing_research") {
      options?.beforeRequest?.();
      researchCalls.push(input);
      return schema.parse({
        facts: [],
        gaps: ["测试未提供外部资料，知识题须使用资源说明"],
      });
    }
    if (_name === "zhidao_publishing_plan") {
      options?.beforeRequest?.();
      planCalls.push(input);
      const words = (input as { keywords: unknown[] }).keywords;
      return schema.parse(
        planOutput ?? {
          groups: words.slice(0, 20).map((_, index) => ({
            index,
            intent: `办公练习主题${index + 1}获取`,
            related:
              index === 0
                ? words.slice(20).map((_, offset) => offset + 20)
                : [],
          })),
          excluded: [],
        },
      );
    }
    if (_name === "zhidao_publishing_review") {
      options?.beforeRequest?.();
      reviewCalls.push(input);
      return schema.parse(
        typeof reviewOutput === "function" ? reviewOutput(input) : reviewOutput,
      );
    }
    assert.equal(instruction, publishingGenerationInstruction);
    options?.beforeRequest?.();
    const value = input as GenerationInput;
    aiCalls.push(value);
    await beforeAi?.();
    const title = value.resource.title.slice(0, 14);
    const version = value.resource.title.match(/v\d+(?:\.\d+)+/i)?.[0] || "";
    const perspectives = [
      "此条围绕",
      "从已提供的说明出发核对",
      "可以关注",
      "阅读资源信息时留意",
      "结合当前需要查看",
      "按资料中的现有说明理解",
      "查阅时可重点确认",
      "整理使用计划时先看",
    ];
    const closings = [
      "整理已有资源信息。",
      "，不要把资源名称当作完整目录。",
      "，未阅读的内容仍需自行核对。",
      "，再判断材料是否适合当前的练习安排。",
    ];
    return schema.parse(
      aiOutput
        ? aiOutput(value)
        : {
            rows: value.rows.map(({ index, keyword }) => ({
              index,
              question: `${title}${version && !title.includes(version) ? ` ${version}` : ""}的${keyword}百度网盘在哪？`,
              introduction: `${value.resource.summary || `${value.resource.category}分类下可见${value.resource.files.map((file) => file.name).join("、")}。`}${perspectives[index % perspectives.length]}「${keyword}」${closings[Math.floor(index / perspectives.length) % closings.length]}`,
            })),
          },
    );
  }) as typeof f.app.ai.resourceExport;
  const account = (await f.app.invoke("account.add", {
    provider: "baidu",
    alias: "百度资料",
  })) as Account;
  await f.app.invoke("account.check", { id: account.id });
  const saved = await f.add(false, {
    accountId: account.id,
    sourceText: "https://pan.baidu.com/s/source-workflow",
  });
  f.app.db.run(
    "UPDATE copies SET status='ready',owner_uid=?,verified_at='2026-11-19',files=?,share_id='canonical',share_url='https://pan.baidu.com/s/canonical',share_owner_uid=?,share_verified_at='2026-11-19' WHERE id=?",
    f.provider.uid,
    JSON.stringify([file]),
    f.provider.uid,
    saved.copyId,
  );
  await f.app.secrets.set(`share:${saved.copyId}`, "abcd");
  let saves = 0,
    creates = 0,
    rechecks = 0,
    sessions = 0,
    checks = 0;
  let afterCreate: (() => void) | undefined;
  let uncertain = false;
  let checkFailure: Pick<ShareCheck, "status" | "message"> | null = null;
  const receipts = new Map<string, ShareCreationReceipt>();
  const shares = {
    withIndependentSession: async <T>(
      _id: string,
      action: () => Promise<T>,
    ) => {
      sessions++;
      return action();
    },
    options: async () => ({ issue: null }),
    result: async (id: string) => receipts.get(id) ?? null,
    recheck: async (id: string) => {
      rechecks++;
      return receipts.get(id)!;
    },
    createIndependent: async (input: {
      operationId: string;
      copyId: string;
    }) => {
      creates++;
      const receipt: ShareCreationReceipt = {
        ...input,
        state: uncertain ? "uncertain" : "success",
        url: uncertain
          ? undefined
          : `https://pan.baidu.com/s/independent-${creates}`,
        code: "abcd",
        createdAt: new Date().toISOString(),
        expiresInDays: 0,
        message: uncertain ? "待核对" : "已创建",
      };
      receipts.set(input.operationId, receipt);
      afterCreate?.();
      return receipt;
    },
  } as unknown as ShareCreation;
  f.ports.baiduShareReader = {
    inspect: async (source) => ({
      ...(await f.provider.inspect(account, source)),
      files: [file],
    }),
    isOpen: () => false,
    open: async () => {},
    close: () => {},
  } as typeof f.ports.baiduShareReader;
  const flow = new ZhidaoPublishingWorkflow({
    repo: f.app.repo,
    ai: f.app.ai,
    secrets: f.app.secrets,
    ports: f.ports,
    shareCreation: shares,
    changed: () => {},
    checkShare: async (copyId) => {
      checks++;
      if (checkFailure)
        return { copyId, checkedAt: new Date().toISOString(), ...checkFailure };
      if (f.app.repo.getCopy(copyId).status === "recorded")
        f.app.db.run(
          "UPDATE copies SET status='ready',owner_uid=?,verified_at='2026-11-19',share_owner_uid=?,share_verified_at='2026-11-19',files=? WHERE id=?",
          f.provider.uid,
          f.provider.uid,
          JSON.stringify([file]),
          copyId,
        );
      return {
        copyId,
        status: "valid",
        checkedAt: "2026-11-19",
        message: "已核验",
      };
    },
    saveResource: async (input) => {
      saves++;
      return f.app.saveResource(input);
    },
  });
  const resource = {
    key: randomUUID(),
    resourceId: saved.resourceId,
    copyId: saved.copyId,
    title: "办公练习清单",
    link: "https://pan.baidu.com/s/source-workflow",
    category: "效率办公",
    summary: "包含表格整理、数据核对和月报练习，面向已掌握基础公式的读者。",
    keywords: ["办公表格练习", "月报模板练习"],
  };
  return {
    ...f,
    flow,
    resource,
    account,
    saved,
    receipts,
    aiCalls,
    planCalls,
    researchCalls,
    reviewCalls,
    setReviewOutput: (value: unknown) => {
      reviewOutput = value;
    },
    setPlanOutput: (value: unknown) => {
      planOutput = value;
    },
    setAiOutput: (callback: typeof aiOutput) => {
      aiOutput = callback;
    },
    setBeforeAi: (callback: typeof beforeAi) => {
      beforeAi = callback;
    },
    setUncertain: (value: boolean) => {
      uncertain = value;
    },
    setAfterCreate: (callback: () => void) => {
      afterCreate = callback;
    },
    counts: () => ({ saves, creates, rechecks, sessions, checks }),
    setCheckFailure: (value: typeof checkFailure) => {
      checkFailure = value;
    },
  };
}

test("本地副本的分享检查连接失败按未完成保存，显示原因；重试只继续检查及建链，不重新转存", async () => {
  const f = await setup();
  try {
    await f.flow.prepare(f.resource, "");
    const copy = f.app.repo.getCopy(f.saved.copyId);
    f.setCheckFailure({
      status: "unavailable",
      message: "无法连接比特浏览器本地服务。",
    });
    await assert.rejects(
      () => f.flow.shares(f.resource.key),
      (error) => {
        assert.equal(
          (error as { code: string }).code,
          "SHARE_CHECK_UNAVAILABLE",
        );
        assert.match((error as Error).message, /比特浏览器本地服务/);
        return true;
      },
    );
    const failed = f.flow.get(f.resource.key);
    assert.equal(failed.shareCheck?.status, "unavailable");
    assert.match(failed.message, /分享检查暂未完成/);
    assert.equal(failed.links.length, 0);
    assert.equal(f.counts().creates, 0);
    assert.deepEqual(f.app.repo.getCopy(f.saved.copyId), copy);
    f.setCheckFailure(null);
    assert.equal((await f.flow.shares(f.resource.key)).stage, "ready");
    assert.equal(f.flow.get(f.resource.key).shareCheck?.status, "valid");
    assert.equal(f.counts().saves, 0);
    assert.equal(f.counts().creates, 1);
  } finally {
    await f.cleanup();
  }
});
test("确认失效的入库分享仍阻止建链，展示平台检查结果，与连接失败区分", async () => {
  const f = await setup();
  try {
    await f.flow.prepare(f.resource, "");
    f.setCheckFailure({
      status: "invalid",
      message: "原分享已失效或文件不匹配。",
    });
    await assert.rejects(
      () => f.flow.shares(f.resource.key),
      /原分享已失效或文件不匹配/,
    );
    assert.equal(f.flow.get(f.resource.key).shareCheck?.status, "invalid");
    assert.equal(f.counts().creates, 0);
  } finally {
    await f.cleanup();
  }
});
test("旧的通用失败记录从本地检查恢复具体原因，读取不会发起远端请求或改写记录", async () => {
  const f = await setup();
  try {
    const prepared = await f.flow.prepare(f.resource, "");
    const old = {
      ...prepared,
      stage: "failed",
      message: "本人分享检查未通过，请在资源库处理后继续。",
      updatedAt: "2026-11-20T00:00:00.005Z",
    };
    f.app.db.setSetting(`zhidao-publishing-resource:${prepared.id}`, old);
    f.app.db.run(
      "INSERT INTO share_checks(copy_id,status,checked_at,message) VALUES(?,'unavailable','2026-11-20T00:00:00.000Z','fetch failed')",
      prepared.copyId,
    );
    const read = f.flow.getMany([prepared.id])[0];
    assert.equal(read.shareCheck?.status, "unavailable");
    assert.match(read.message, /检查请求连接失败/);
    assert.equal(f.counts().checks, 0);
    assert.equal(f.counts().creates, 0);
    assert.deepEqual(
      f.app.db.setting(`zhidao-publishing-resource:${prepared.id}`, null),
      old,
    );
  } finally {
    await f.cleanup();
  }
});

test("库中资源跳过转存，保存关键词并含常规分享最多20条；重复点击不重复建链", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: Array.from({ length: 20 }, (_, i) => `办公练习主题${i + 1}`),
    };
    await f.flow.prepare(resource, "");
    assert.equal(f.flow.resources("AI办公")[0]?.id, resource.resourceId);
    assert.equal(f.flow.resources("%").length, 0);
    assert.equal(f.counts().saves, 0);
    assert.deepEqual(
      f.app.repo.getResource(resource.resourceId).searchKeywords,
      resource.keywords,
    );
    const result = await f.flow.shares(resource.key);
    assert.equal(result.links.length, 20);
    assert.equal(f.counts().creates, 19);
    assert.equal(f.counts().sessions, 1);
    await f.flow.shares(resource.key);
    assert.equal(f.counts().creates, 19);
    assert.equal(f.counts().sessions, 1);
    assert.equal(
      f.app.repo.getCopy(resource.copyId).shareUrl,
      "https://pan.baidu.com/s/canonical",
    );
    const generated = await f.flow.generate(resource.key);
    assert.equal(generated.rows.length, 20);
    assert.equal(
      new Set(generated.rows.map(({ question }) => question)).size,
      20,
    );
    for (const [index, row] of generated.rows.entries()) {
      const share: PublishingRecord["links"][number] = result.links[index];
      assert.ok(row.answer.includes(`href="${share.url}?pwd=${share.code}"`));
      assert.ok(row.question.includes(resource.title));
      assert.ok(row.question.length >= 5 && row.question.length <= 49);
    }
  } finally {
    await f.cleanup();
  }
});
test("问答使用完整网盘链接、资源简介与可选图片，长名称保留版本号", async () => {
  const f = await setup();
  try {
    const title = "年度练习清单" + "办公资料整理与分析".repeat(5) + " v12.3.4";
    const resource = {
      ...f.resource,
      title,
      summary: "这份清单包含 <月份> 与收支 & 核对说明。",
      image: "https://example.com/cover.jpg?fit=cover&format=jpg",
    };
    await f.flow.prepare(resource, "");
    await f.flow.shares(resource.key);
    const generated = await f.flow.generate(resource.key);
    const first = generated.rows[0];
    assert.ok(first.question.startsWith("年度练习清单"));
    assert.ok(first.question.includes("v12.3.4"));
    assert.ok(first.question.length >= 5 && first.question.length <= 49);
    assert.equal(
      first.answer,
      "<p><strong>点击链接获取网盘资源：</strong><br/></p>" +
        '<p><a href="https://pan.baidu.com/s/canonical?pwd=abcd">https://pan.baidu.com/s/canonical?pwd=abcd</a><br/></p>' +
        "<p>这份清单包含 &lt;月份&gt; 与收支 &amp; 核对说明。此条围绕「办公表格练习」整理已有资源信息。</p>" +
        `<img src="https://example.com/cover.jpg?fit=cover&amp;format=jpg" alt="${title}" />`,
    );
    assert.equal(
      preparePublishingSchema.safeParse({
        resource: { ...resource, image: "file:///tmp/cover.jpg" },
        authorized: true,
      }).success,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("旧自动与人工问答保留，缺少图片的旧准备记录可继续使用", async () => {
  const f = await setup();
  try {
    await f.flow.prepare(f.resource, "");
    await f.flow.shares(f.resource.key);
    const generated = await f.flow.generate(f.resource.key);
    const legacyRows = generated.rows.map((row, index) => ({
      ...row,
      question: index ? "旧版月报的表格怎样排版？" : "我已修改过的办公资料问答",
      answer:
        "<p>这项办公内容包含月度表与数据核对指引。</p>" +
        `<p>相关资料：${generated.links[index].url} 提取码：${generated.links[index].code}</p>`,
      reviewed: index === 0,
    }));
    const legacy = { ...generated, rows: legacyRows };
    delete legacy.linkedAnswerFormat;
    f.app.db.setSetting(`zhidao-publishing-resource:${generated.id}`, legacy);
    const resumed = await f.flow.prepare({ ...f.resource, image: "" }, "");
    assert.deepEqual(resumed.rows, legacyRows);
    assert.deepEqual((await f.flow.generate(generated.id)).rows, legacyRows);
    await assert.rejects(
      () => f.flow.generate(generated.id, true),
      /已有编辑或审核/,
    );
    f.flow.saveRows(
      generated.id,
      legacyRows.map((row) => ({ ...row, reviewed: true })),
    );
  } finally {
    await f.cleanup();
  }
});

test("旧版自动问答可套用新格式，保留分享并过滤错误的标题意图", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      summary: "",
      keywords: ["免费考试网站", "办公资料app"],
    };
    await f.flow.prepare(resource, "");
    const record = await f.flow.shares(resource.key);
    const legacyRows = resource.keywords.map((keyword, index) => {
      const link = record.links[index];
      const input = {
        title: resource.title,
        summary: "",
        link: link.url,
        code: link.code,
        image: "",
      };
      return {
        keyword,
        question: generationQuestion(
          { ...input, title: keyword },
          defaultGenerationRules,
        ),
        answer: generationHtml(input, defaultGenerationRules),
        reviewed: false,
      };
    });
    f.app.db.setSetting(`zhidao-publishing-resource:${record.id}`, {
      ...record,
      rows: legacyRows,
    });
    assert.equal(f.flow.getMany([record.id])[0].canUpgradeLegacy, true);
    assert.deepEqual((await f.flow.generate(record.id)).rows, legacyRows);
    f.setAiOutput((input) => ({
      rows: input.rows.map(({ index }) => ({
        index,
        question: index
          ? "办公练习清单的百度网盘地址在哪里？"
          : "办公练习清单的百度网盘资料可以在哪里获取？",
        introduction: `${index ? "按文件清单核对这份办公练习资料" : "这份效率办公资源保留已有文件"}，其中可见${file.name}，文件名并不代表已经阅读文件内容。`,
      })),
    }));
    const counts = f.counts();
    const updated = (await f.app.invoke("zhidao.workflow.generate", {
      id: record.id,
      upgradeLegacy: true,
    })) as PublishingRecord;
    assert.equal(updated.legacyUpgraded, true);
    assert.equal(updated.linkedAnswerFormat, true);
    assert.deepEqual(updated.links, record.links);
    assert.deepEqual(updated.operations, record.operations);
    assert.deepEqual(f.counts(), counts);
    assert.equal(updated.rows.length, legacyRows.length);
    for (const row of updated.rows) {
      assert.match(row.question, /办公练习清单.*百度网盘/);
      assert.doesNotMatch(row.question, /网站|app/);
      assert.match(row.answer, /^<p><strong>点击链接获取网盘资源：/);
      assert.ok(row.answer.includes("?pwd=abcd"));
      assert.ok(row.answer.includes(file.name));
    }
    assert.deepEqual(
      (await f.flow.generate(record.id, true)).rows,
      updated.rows,
    );
    assert.equal(f.flow.getMany([record.id])[0].canUpgradeLegacy, undefined);
  } finally {
    await f.cleanup();
  }
});

test("有效免码分享直接复用，缺失简介时引用已知分类与文件清单", async () => {
  const f = await setup();
  try {
    const resource = { ...f.resource, summary: "", keywords: ["办公练习"] };
    await f.app.secrets.set(`share:${resource.copyId}`, "");
    await f.flow.prepare(resource, "");
    await f.flow.shares(resource.key);
    const { rows } = await f.flow.generate(resource.key);
    assert.equal(f.counts().creates, 0);
    assert.match(
      rows[0].answer,
      /href="https:\/\/pan\.baidu\.com\/s\/canonical"/,
    );
    assert.ok(rows[0].answer.includes(resource.category));
    assert.ok(rows[0].answer.includes(file.name));
    assert.ok(!rows[0].answer.includes("pwd="));
    f.flow.saveRows(
      resource.key,
      rows.map((row) => ({ ...row, reviewed: true })),
    );
  } finally {
    await f.cleanup();
  }
});
test("库中直接入库的本人分享在准备时核验，不要求跳出流程手动补齐文件归属", async () => {
  const f = await setup();
  try {
    f.app.db.run(
      "UPDATE resources SET source_kind='owned' WHERE id=?",
      f.saved.resourceId,
    );
    f.app.db.run(
      "UPDATE copies SET status='recorded',owner_uid=NULL,verified_at=NULL,share_owner_uid=NULL,share_verified_at=NULL,files='[]' WHERE id=?",
      f.saved.copyId,
    );
    const record = await f.flow.prepare(f.resource, "");
    assert.equal(record.stage, "sharing");
    assert.equal(f.counts().checks, 1);
    assert.equal(f.counts().creates, 0);
    assert.equal(record.copyId, f.saved.copyId);
  } finally {
    await f.cleanup();
  }
});
test("库中未转存草稿沿用原账号与副本，只提交一次原转存队列；已有任务不重复入库", async () => {
  const f = await setup();
  try {
    f.app.db.run(
      "UPDATE copies SET status='draft',owner_uid=NULL,verified_at=NULL,share_owner_uid=NULL,share_verified_at=NULL,files='[]',selected_files='[]' WHERE id=?",
      f.saved.copyId,
    );
    const prepared = await f.flow.prepare(f.resource, "");
    assert.equal(prepared.stage, "transferring");
    assert.equal(prepared.copyId, f.saved.copyId);
    assert.equal(prepared.accountId, f.account.id);
    assert.equal(f.counts().saves, 1);
    await f.flow.prepare(f.resource, "");
    assert.equal(f.counts().saves, 1);
    assert.equal(
      f.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM resources")!.n,
      1,
    );
    assert.equal(
      f.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM copies")!.n,
      1,
    );
    assert.equal(
      f.app.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM jobs WHERE copy_id=?",
        f.saved.copyId,
      )!.n,
      1,
    );
    const second = { ...f.resource, key: randomUUID() };
    assert.equal((await f.flow.prepare(second, "")).stage, "transferring");
    assert.equal(f.counts().saves, 1);
    const job = f.app.repo
      .jobs()
      .find((entry) => entry.copyId === f.saved.copyId)!;
    f.app.db.run(
      "UPDATE copies SET status='failed',error='测试转存失败' WHERE id=?",
      f.saved.copyId,
    );
    f.app.db.run("UPDATE jobs SET stage='failed' WHERE id=?", job.id);
    const failed = f.flow.get(second.key);
    assert.equal(failed.transferBlocked, true);
    assert.deepEqual(failed.transferRecovery, {
      jobId: job.id,
      stage: "failed",
    });
    assert.match(failed.message, /测试转存失败.*核对并恢复原转存任务/);
    f.app.db.run("UPDATE jobs SET stage='waiting_login' WHERE id=?", job.id);
    const needsLogin = f.flow.get(second.key);
    assert.equal(needsLogin.transferRecovery?.stage, "waiting_login");
    assert.match(needsLogin.message, /登录任务绑定的百度网盘账号/);
    f.app.db.run("UPDATE jobs SET stage='cancelled' WHERE id=?", job.id);
    assert.equal(f.flow.get(second.key).transferRecovery?.stage, "cancelled");
  } finally {
    await f.cleanup();
  }
});
test("批次暂停等待当前回执并保留已完成链接，继续只创建剩余项；整理问答保留人工修改", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: ["办公练习", "预算整理", "月报清单", "公式检查"],
    };
    await f.flow.prepare(resource, "");
    f.setAfterCreate(() => f.flow.pause(resource.key));
    const paused = await f.flow.shares(resource.key);
    assert.equal(paused.stage, "paused");
    assert.equal(paused.links.length, 2);
    assert.equal(f.counts().creates, 1);
    f.setAfterCreate(() => {});
    const done = await f.flow.shares(resource.key);
    assert.equal(done.stage, "ready");
    assert.equal(done.links.length, 4);
    assert.equal(f.counts().creates, 3);
    const generated = (await f.flow.generateMany([resource.key]))[0];
    const modified = generated.rows.map((row, index) => ({
      ...row,
      question: index === 0 ? "办公练习清单有哪些内容？" : row.question,
      reviewed: true,
    }));
    f.flow.saveRows(resource.key, modified);
    assert.deepEqual(
      (await f.flow.generateMany([resource.key]))[0].rows,
      modified,
    );
  } finally {
    await f.cleanup();
  }
});
test("未知建链回执只读核对，恢复不再次发起创建", async () => {
  const f = await setup();
  try {
    await f.flow.prepare(f.resource, "");
    f.setUncertain(true);
    assert.equal((await f.flow.shares(f.resource.key)).stage, "uncertain");
    assert.equal((await f.flow.shares(f.resource.key)).stage, "uncertain");
    assert.equal(f.counts().creates, 1);
    assert.equal(f.counts().rechecks, 1);
  } finally {
    await f.cleanup();
  }
});
test("库外失败后恢复原任务并保留转存检查点，完成后接着建链", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      key: randomUUID(),
      resourceId: "",
      copyId: "",
      title: "预算整理练习",
      link: "https://pan.baidu.com/s/external-workflow",
    };
    const prepared = await f.flow.prepare(resource, f.account.id);
    assert.equal(prepared.stage, "transferring");
    const job = f.app.repo
      .jobs()
      .find((entry) => entry.copyId === prepared.copyId)!;
    f.app.db.run(
      "UPDATE jobs SET stage='needs_review',checkpoint='transfer_requested',error='转存结果待核对' WHERE id=?",
      job.id,
    );
    f.app.db.run(
      "UPDATE copies SET status='needs_review',error='转存结果待核对' WHERE id=?",
      prepared.copyId,
    );
    const blocked = f.flow.get(resource.key);
    assert.equal(blocked.transferBlocked, true);
    assert.deepEqual(blocked.transferRecovery, {
      jobId: job.id,
      stage: "needs_review",
    });
    const concurrentRetries = await Promise.allSettled([
      f.app.invoke("job.retry", { id: job.id }),
      f.app.invoke("job.retry", { id: job.id }),
    ]);
    assert.equal(
      concurrentRetries.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    assert.equal(f.app.repo.getJob(job.id).attempts, 1);
    assert.equal(f.app.repo.getJob(job.id).checkpoint, "transfer_requested");
    assert.equal(f.app.repo.getCopy(prepared.copyId).status, "needs_review");
    const requeued = await f.flow.prepare(resource, f.account.id);
    assert.equal(requeued.stage, "transferring");
    assert.equal(requeued.transferBlocked, false);
    assert.equal(requeued.transferRecovery, undefined);
    assert.equal(
      f.app.repo.jobs().filter((entry) => entry.copyId === prepared.copyId)
        .length,
      1,
    );
    assert.equal(f.counts().saves, 1);
    await assert.rejects(() => f.flow.shares(resource.key), /等待转存完成/);
    f.app.db.run(
      "UPDATE copies SET status='ready',owner_uid=?,verified_at='2026-11-19',files=?,share_id='own',share_url='https://pan.baidu.com/s/newcanonical',share_owner_uid=?,share_verified_at='2026-11-19' WHERE id=?",
      f.provider.uid,
      JSON.stringify([file]),
      f.provider.uid,
      prepared.copyId,
    );
    const ready = await f.flow.shares(resource.key);
    assert.equal(ready.stage, "ready");
    assert.equal(ready.links[0].url, "https://pan.baidu.com/s/newcanonical");
    assert.deepEqual((await f.flow.shares(resource.key)).links, ready.links);
    assert.equal(f.counts().creates, 1);
    const batch = await f.app.invoke("zhidao.workflow.get", {
      ids: [randomUUID(), resource.key],
    });
    assert.deepEqual(batch, [ready]);
  } finally {
    await f.cleanup();
  }
});
test("修改准备过的资源必须重新确认；重复来源及不完整分享不会转存", async () => {
  const f = await setup();
  try {
    await f.flow.prepare(f.resource, "");
    await assert.rejects(
      () => f.flow.prepare({ ...f.resource, keywords: ["修改后的主题"] }, ""),
      /资源信息已变化/,
    );
    const external = {
      ...f.resource,
      key: randomUUID(),
      resourceId: "",
      copyId: "",
    };
    await assert.rejects(
      () => f.flow.prepare(external, f.account.id),
      /已经在资源库/,
    );
    f.ports.baiduShareReader!.inspect = async () => ({
      title: "多页",
      files: [file],
      hasMore: true,
      page: 1,
      parentId: "0",
      shareKey: "multipage",
    });
    await assert.rejects(
      () =>
        f.flow.prepare(
          {
            ...external,
            key: randomUUID(),
            link: "https://pan.baidu.com/s/multipage",
          },
          f.account.id,
        ),
      /超过一页/,
    );
    assert.equal(f.counts().saves, 0);
  } finally {
    await f.cleanup();
  }
});
test("导出要求已审核、合法标题和本资源链接；XLSX固定三列且qid留空", async () => {
  const f = await setup();
  try {
    await f.flow.prepare(f.resource, "");
    await f.flow.shares(f.resource.key);
    const generated = await f.flow.generate(f.resource.key);
    await assert.rejects(() => f.flow.export([generated.id]), /先保存并审核/);
    assert.ok(generated.rows.every(({ answer }) => !answer.includes("<img")));
    assert.throws(
      () =>
        f.flow.saveRows(
          generated.id,
          generated.rows.map((row) => ({
            ...row,
            reviewed: true,
            question: "超".repeat(50),
          })),
        ),
      /缩短/,
    );
    assert.throws(
      () =>
        f.flow.saveRows(
          generated.id,
          generated.rows.map((row) => ({
            ...row,
            reviewed: true,
            answer: "清晰说明内容与使用条件，不带任何资料链接。",
          })),
        ),
      /缺少本资源/,
    );
    const reviewed = generated.rows.map((row) => ({ ...row, reviewed: true }));
    assert.throws(
      () =>
        f.flow.saveRows(generated.id, [
          { ...reviewed[0], question: "找资料" },
          reviewed[1],
        ]),
      /至少需要5字/,
    );
    assert.throws(
      () =>
        f.flow.saveRows(generated.id, [
          {
            ...reviewed[0],
            answer: reviewed[0].answer.slice(
              0,
              reviewed[0].answer.indexOf("</a><br/></p>") +
                "</a><br/></p>".length,
            ),
          },
          reviewed[1],
        ]),
      /填写具体的资源简介/,
    );
    assert.throws(
      () =>
        f.flow.saveRows(generated.id, [
          {
            ...reviewed[0],
            answer: reviewed[0].answer
              .replace(
                /<a\b[^>]*>[\s\S]*?<\/a>/,
                (anchor) => `<!--${anchor}-->`,
              )
              .concat("<p>https://pan.baidu.com/s/canonical?pwd=abcd</p>"),
          },
          reviewed[1],
        ]),
      /使用 HTML 超链接/,
    );
    assert.throws(
      () =>
        f.flow.saveRows(generated.id, [
          { ...reviewed[0], answer: reviewed[1].answer },
          reviewed[1],
        ]),
      /与这条问答分配的分享不一致/,
    );
    assert.throws(
      () =>
        f.flow.saveRows(generated.id, [
          {
            ...reviewed[0],
            answer: reviewed[0].answer.replaceAll("pwd=abcd", "pwd=zzzz"),
          },
          reviewed[1],
        ]),
      /与这条问答分配的分享不一致/,
    );
    f.flow.saveRows(generated.id, reviewed);
    let content: Uint8Array | undefined;
    f.ports.saveFile = async (_name, bytes) => {
      content = bytes;
      return "/tmp/问答.xlsx";
    };
    assert.equal(await f.flow.export([generated.id]), "/tmp/问答.xlsx");
    const table = readXlsx(Buffer.from(content!));
    assert.deepEqual(table[0], ["qid", "问题标题", "回答内容"]);
    assert.deepEqual(
      table.slice(1),
      generated.rows.map((row) => ["", row.question, row.answer]),
    );
    const rows = f.flow.get(generated.id).rows;
    f.flow.saveRows(
      generated.id,
      rows.map((row) => ({ ...row, question: rows[0].question })),
    );
    await assert.rejects(() => f.flow.export([generated.id]), /重复标题/);
    f.flow.saveRows(
      generated.id,
      generated.rows.map((row) => ({ ...row, reviewed: true })),
    );
    f.app.db.run(
      "UPDATE copies SET share_url='https://pan.baidu.com/s/replaced' WHERE id=?",
      f.saved.copyId,
    );
    await assert.rejects(
      () => f.flow.export([generated.id]),
      /本人分享或归属已变化/,
    );
  } finally {
    await f.cleanup();
  }
});
test("入口约束百度链接、明确授权及每份100个关键词上限", () => {
  const resource = {
    key: randomUUID(),
    title: "目录",
    link: "https://pan.baidu.com/s/source",
    category: "学习资料",
    keywords: ["目录说明"],
  };
  assert.equal(
    preparePublishingSchema.safeParse({ resource, authorized: true }).success,
    true,
  );
  assert.equal(
    preparePublishingSchema.safeParse({ resource, authorized: false }).success,
    false,
  );
  assert.equal(
    preparePublishingSchema.safeParse({
      resource: { ...resource, link: "https://example.com" },
      authorized: true,
    }).success,
    false,
  );
  assert.equal(
    preparePublishingSchema.safeParse({
      resource: {
        ...resource,
        keywords: Array.from({ length: 101 }, (_, i) => `主题${i}`),
      },
      authorized: true,
    }).success,
    false,
  );
});

test("每个关键词有独立 AI 标题与简介，20行分三批并提供原事实和历史结果", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: Array.from({ length: 20 }, (_, i) => `办公练习${i + 1}`),
    };
    await f.flow.prepare(resource, "");
    const prepared = await f.flow.shares(resource.key);
    const result = await f.flow.generate(resource.key);
    assert.deepEqual(
      f.aiCalls.map((call) => call.rows.length),
      [8, 8, 4],
    );
    assert.equal(
      new Set(
        result.rows.map((row) =>
          row.answer.replace(/https?:\/\/[^<\s]+/g, "URL"),
        ),
      ).size,
      20,
    );
    assert.equal(new Set(result.rows.map((row) => row.question)).size, 20);
    assert.deepEqual(
      result.rows.map((row) => row.keyword),
      resource.keywords,
    );
    assert.ok(
      result.rows.every(
        (row) => row.answer.includes(row.keyword) && !row.reviewed,
      ),
    );
    assert.equal(f.aiCalls[0].resource.summary, resource.summary);
    assert.deepEqual(f.aiCalls[0].resource.files, []);
    assert.equal(f.aiCalls[1].previous.length, 8);
    assert.deepEqual(result.links, prepared.links);
    assert.equal(result.generation?.status, "completed");
    await f.flow.generate(resource.key);
    assert.equal(f.aiCalls.length, 3, "读取既有结果不能再次计费");
  } finally {
    await f.cleanup();
  }
});

test("第二批失败保留首批，刷新/中断只读状态，手动继续只请求剩余关键词", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: Array.from({ length: 9 }, (_, i) => `办公练习${i + 1}`),
    };
    await f.flow.prepare(resource, "");
    await f.flow.shares(resource.key);
    f.setBeforeAi(() => {
      if (f.aiCalls.length === 2) throw new Error("模型连接超时，费用待核对");
    });
    await assert.rejects(() => f.flow.generate(resource.key), /模型连接超时/);
    const failed = f.flow.get(resource.key);
    assert.equal(failed.generation?.drafts.length, 8);
    assert.equal(failed.generation?.status, "failed");
    assert.equal(failed.rows.length, 0);
    assert.equal(f.flow.isBusy, false);
    await assert.rejects(() => f.flow.export([resource.key]), /先保存并审核/);
    assert.throws(() => f.flow.saveRows(resource.key, []), /完成剩余/);
    failed.generation!.status = "running";
    f.app.db.setSetting(`zhidao-publishing-resource:${resource.key}`, failed);
    assert.equal(f.flow.get(resource.key).generation?.status, "paused");
    assert.equal(f.aiCalls.length, 2);
    f.setBeforeAi(undefined);
    const result = await f.flow.generate(resource.key);
    assert.deepEqual(
      f.aiCalls.map((call) => call.rows.map((row) => row.index)),
      [[0, 1, 2, 3, 4, 5, 6, 7], [8], [8]],
    );
    assert.equal(result.rows.length, 9);
    assert.deepEqual(
      result.generation?.drafts.slice(0, 8),
      failed.generation?.drafts,
    );
  } finally {
    await f.cleanup();
  }
});

test("拒绝重复资源介绍、仅换口头前缀的标题、重复平台词和错位返回，不自动重试", async () => {
  const f = await setup();
  try {
    await f.flow.prepare(f.resource, "");
    await f.flow.shares(f.resource.key);
    const output = (kind: string, input: GenerationInput) => ({
      rows: input.rows.map(({ index }) => ({
        index: kind === "index" ? 0 : index,
        question:
          kind === "title"
            ? `${index ? "请问" : ""}办公练习清单的百度网盘地址在哪？`
            : kind === "intent"
              ? `办公练习${index}的百度网盘版本怎么区分？`
              : kind === "platform"
                ? `办公练习${index}百度网盘的百度网盘地址在哪？`
                : `办公练习${index}的百度网盘资料在哪？`,
        introduction:
          kind === "keyword-only"
            ? `这份资料包含表格整理和月报练习，可根据已有目录核对「${input.rows.find((row) => row.index === index)?.keyword}」所对应的内容。`
            : `这份资料包含表格整理和月报练习，可根据已有目录核对${kind === "intro" ? "学习内容" : `第${index + 1}项练习内容`}。`,
      })),
    });
    for (const kind of [
      "intro",
      "keyword-only",
      "title",
      "platform",
      "index",
      "intent",
    ]) {
      f.setAiOutput((input) => output(kind, input));
      const count = f.aiCalls.length;
      await assert.rejects(
        () => f.flow.generate(f.resource.key),
        /重复|不对应|获取|方法类/,
      );
      assert.equal(f.aiCalls.length, count + 1);
      assert.equal(f.flow.get(f.resource.key).generation?.drafts.length, 0);
      assert.equal(f.flow.get(f.resource.key).rows.length, 0);
    }
    f.setAiOutput((input) => ({
      rows: output("normal", input).rows.reverse(),
    }));
    const result = await f.flow.generate(f.resource.key);
    assert.match(result.rows[0].question, /办公练习0/);
    assert.match(result.rows[1].question, /办公练习1/);
  } finally {
    await f.cleanup();
  }
});

test("AI 优化保留已确认条目和分享，仅重写未确认内容并隔离旧编辑缓存版本", async () => {
  const f = await setup();
  try {
    await f.flow.prepare(f.resource, "");
    await f.flow.shares(f.resource.key);
    const original = await f.flow.generate(f.resource.key);
    f.flow.saveRows(
      original.id,
      original.rows.map((row, i) => ({ ...row, reviewed: i === 0 })),
    );
    f.setAiOutput((input) => ({
      rows: input.rows.map(({ index, keyword }) => ({
        index,
        question: `办公练习清单里${keyword}对应的百度网盘资料在哪？`,
        introduction: `关于${keyword}，已知清单包含表格整理与月报练习，内容以已提供的资源介绍为依据。`,
      })),
    }));
    const result = await f.flow.generate(original.id, false, true);
    assert.deepEqual(result.rows[0], { ...original.rows[0], reviewed: true });
    assert.notEqual(result.rows[1].answer, original.rows[1].answer);
    assert.notEqual(result.generation?.id, original.generation?.id);
    assert.deepEqual(
      f.aiCalls.at(-1)?.rows.map((row) => row.index),
      [1],
    );
    assert.deepEqual(result.links, original.links);
    assert.deepEqual(result.operations, original.operations);
    await assert.rejects(
      () =>
        f.app.invoke("zhidao.workflow.saveRows", {
          id: result.id,
          generationId: original.generation?.id,
          rows: original.rows.map((row) => ({ ...row, reviewed: true })),
        }),
      /生成版本已更新/,
    );
    await assert.rejects(
      () =>
        f.app.invoke("zhidao.workflow.saveRows", {
          id: result.id,
          rows: original.rows.map((row) => ({ ...row, reviewed: true })),
        }),
      /生成版本已更新/,
    );
    assert.deepEqual(f.flow.get(result.id).rows, result.rows);
    const count = f.aiCalls.length;
    f.flow.saveRows(
      result.id,
      result.rows.map((row) => ({ ...row, reviewed: true })),
    );
    await f.flow.generate(result.id, false, true);
    assert.equal(f.aiCalls.length, count);
  } finally {
    await f.cleanup();
  }
});

test("AI 生成期间锁定重复提交，写入前核对最新问答且不覆盖并发修改", async () => {
  const f = await setup();
  let release!: () => void;
  try {
    await f.flow.prepare(f.resource, "");
    await f.flow.shares(f.resource.key);
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setBeforeAi(() => {
      started();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const pending = f.flow.generate(f.resource.key);
    await entered;
    await assert.rejects(() => f.flow.generate(f.resource.key), /正在处理/);
    assert.equal(f.aiCalls.length, 1);
    const current = f.flow.get(f.resource.key);
    current.rows = [
      {
        keyword: f.resource.keywords[0],
        question: "人工保留的问答在哪里？",
        answer: "这份资源的信息已由用户进行具体修改与核对。",
        reviewed: false,
      },
    ];
    f.app.db.setSetting(`zhidao-publishing-resource:${current.id}`, current);
    release();
    await assert.rejects(() => pending, /生成期间资源或问答已变化/);
    assert.deepEqual(f.flow.get(current.id).rows, current.rows);
  } finally {
    release?.();
    await f.cleanup();
  }
});

test("多资源 AI 生成失败不会回滚已完成资源，继续也不会重复请求已完成资源", async () => {
  const f = await setup();
  try {
    const second = {
      ...f.resource,
      key: randomUUID(),
      title: "季度复盘清单",
      keywords: ["季度复盘"],
    };
    for (const resource of [f.resource, second]) {
      await f.flow.prepare(resource, "");
      await f.flow.shares(resource.key);
    }
    f.setBeforeAi(() => {
      if (f.aiCalls.length === 2) throw new Error("第二份生成中断");
    });
    await assert.rejects(
      () => f.flow.generateMany([f.resource.key, second.key]),
      /第二份/,
    );
    assert.equal(f.flow.get(f.resource.key).generation?.status, "completed");
    assert.equal(f.flow.get(second.key).generation?.status, "failed");
    f.setBeforeAi(undefined);
    const result = await f.flow.generateMany([f.resource.key, second.key]);
    assert.equal(result.length, 2);
    assert.equal(
      f.aiCalls.filter((call) => call.resource.title === f.resource.title)
        .length,
      1,
    );
    assert.equal(f.aiCalls.length, 3);
  } finally {
    await f.cleanup();
  }
});

test("未配置文案模型时阻止生成，不创建半成品或调用模型", async () => {
  const f = await setup();
  try {
    await f.flow.prepare(f.resource, "");
    await f.flow.shares(f.resource.key);
    f.app.db.setSetting("model", "");
    await assert.rejects(
      () => f.flow.generate(f.resource.key),
      /选择文案创作模型/,
    );
    assert.equal(f.aiCalls.length, 0);
    assert.equal(f.flow.get(f.resource.key).generation, undefined);
    assert.equal(f.flow.get(f.resource.key).rows.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("新五步完整流程：先归并最多20条、审核删减后按实际条数建链，排序编辑不会串链，导出三列", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: Array.from({ length: 25 }, (_, i) => `办公专题${i + 1}`),
    };
    f.flow.planMany([resource]);
    assert.deepEqual(f.counts(), {
      saves: 0,
      creates: 0,
      rechecks: 0,
      sessions: 0,
      checks: 0,
    });
    await assert.rejects(() => f.flow.prepare(resource, ""), /先生成并确认/);
    const generated = await f.flow.generate(resource.key);
    assert.equal(generated.rows.length, 20);
    assert.equal(generated.rows[0].relatedKeywords?.length, 5);
    assert.equal(generated.links.length, 0);
    assert.ok(
      generated.rows.every((row) => row.id && !row.answer.includes("https://")),
    );
    assert.equal(f.counts().creates, 0);
    assert.equal(f.counts().checks, 0);
    await assert.rejects(() => f.flow.shares(resource.key), /先生成并确认/);
    const chosen = generated.rows
      .slice(0, 4)
      .reverse()
      .map((row) => ({ ...row, reviewed: true }));
    const saved = f.flow.saveRows(
      resource.key,
      chosen,
      generated.generation!.id,
    );
    assert.throws(
      () => f.flow.saveRows(resource.key, saved.rows, randomUUID()),
      /版本已更新/,
    );
    await f.flow.prepare(resource, "");
    const ready = await f.flow.shares(resource.key);
    assert.equal(ready.links.length, 4);
    assert.equal(f.counts().creates, 3);
    assert.equal(publishingLinkIssue([ready]), "");
    const byId = { ...ready.rowShares };
    const edited = [
      { ...ready.rows[2], question: "办公练习专题的百度网盘地址在哪？" },
      ready.rows[0],
      ready.rows[1],
    ];
    const reordered = f.flow.saveRows(ready.id, edited, ready.generation!.id);
    assert.deepEqual(
      reordered.rows.map((row) => reordered.rowShares![row.id!]),
      edited.map((row) => byId[row.id!]),
    );
    await f.flow.shares(ready.id);
    assert.equal(f.counts().creates, 3);
    let output: Uint8Array | undefined;
    f.ports.saveFile = async (_name, bytes) => {
      output = bytes;
      return "/tmp/问答.xlsx";
    };
    await f.flow.export([ready.id]);
    const table = readXlsx(Buffer.from(output!));
    assert.deepEqual(table[0], ["qid", "问题标题", "回答内容"]);
    assert.deepEqual(
      table.slice(1),
      publishingRowsWithLinks(reordered).map((row) => [
        "",
        row.question,
        row.answer,
      ]),
    );
    assert.equal(table.length, 4);
    assert.equal(
      new Set(table.slice(1).map((row) => row[2].match(/href="([^"]+)/)?.[1]))
        .size,
      3,
    );
    assert.deepEqual(f.flow.get(ready.id).resource.keywords, resource.keywords);
  } finally {
    await f.cleanup();
  }
});

test("规划允许少于20条，拒绝无效分组；生成中断保留规划和批次，读取不自动调用AI", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: Array.from({ length: 12 }, (_, i) => `办公练习${i + 1}`),
    };
    f.flow.planMany([resource]);
    f.setPlanOutput({
      groups: [{ index: 0, related: [0], intent: "办公练习获取" }],
      excluded: [],
    });
    await assert.rejects(() => f.flow.generate(resource.key), /重复或无效序号/);
    assert.equal(f.aiCalls.length, 0);
    f.setPlanOutput({
      groups: resource.keywords.slice(0, 9).map((_, index) => ({
        index,
        intent: `办公练习主题${index + 1}获取`,
        related: index === 0 ? [9, 10, 11] : [],
      })),
      excluded: [],
    });
    f.setBeforeAi(() => {
      if (f.aiCalls.length === 2) throw new Error("测试中断");
    });
    await assert.rejects(() => f.flow.generate(resource.key), /测试中断/);
    assert.equal(f.flow.get(resource.key).generation?.drafts.length, 8);
    const count = f.planCalls.length;
    f.flow.get(resource.key);
    f.setBeforeAi(undefined);
    const result = await f.flow.generate(resource.key);
    assert.equal(result.rows.length, 9);
    assert.equal(f.planCalls.length, count);
    assert.deepEqual(
      f.aiCalls.map((call) => call.rows.length),
      [8, 1, 1],
    );
    assert.equal(f.counts().creates, 0);
  } finally {
    await f.cleanup();
  }
});

test("新问答拒绝正文链接、伪造标识、重复标题和空集合；确认版本不能绕过", async () => {
  const f = await setup();
  try {
    f.flow.planMany([f.resource]);
    const result = await f.flow.generate(f.resource.key);
    const confirmed = result.rows.map((row) => ({ ...row, reviewed: true }));
    assert.throws(() => f.flow.saveRows(result.id, []), /1–20/);
    assert.throws(
      () => f.flow.saveRows(result.id, [{ ...confirmed[0], id: randomUUID() }]),
      /标识/,
    );
    assert.throws(
      () =>
        f.flow.saveRows(
          result.id,
          confirmed.map((row) => ({ ...row, question: confirmed[0].question })),
        ),
      /重复/,
    );
    assert.throws(
      () =>
        f.flow.saveRows(result.id, [
          {
            ...confirmed[0],
            answer:
              confirmed[0].answer + "<p>https://pan.baidu.com/s/extra</p>",
          },
        ]),
      /移除正文中的链接/,
    );
    const stored = f.flow.get(result.id);
    stored.generation!.status = "failed";
    f.app.db.setSetting(`zhidao-publishing-resource:${result.id}`, stored);
    assert.throws(() => f.flow.saveRows(result.id, confirmed), /完成剩余/);
  } finally {
    await f.cleanup();
  }
});

test("新流程停止建链后恢复剩余，未知回执不重发，重复URL不能分配或导出", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: ["办公月报", "办公数据", "办公公式", "办公计划"],
    };
    f.flow.planMany([resource]);
    const generated = await f.flow.generate(resource.key);
    f.flow.saveRows(
      resource.key,
      generated.rows.map((row) => ({ ...row, reviewed: true })),
    );
    await f.flow.prepare(resource, "");
    f.setAfterCreate(() => f.flow.pause(resource.key));
    const paused = await f.flow.shares(resource.key);
    assert.equal(paused.stage, "paused");
    assert.equal(paused.links.length, 2);
    f.setAfterCreate(() => {});
    const ready = await f.flow.shares(resource.key);
    assert.equal(ready.links.length, 4);
    assert.equal(f.counts().creates, 3);
    const bad = structuredClone(ready);
    bad.rowShares![bad.rows[1].id!] = bad.rowShares![bad.rows[0].id!];
    f.app.db.setSetting(`zhidao-publishing-resource:${ready.id}`, bad);
    await assert.rejects(() => f.flow.export([ready.id]), /重复分享URL/);
  } finally {
    await f.cleanup();
  }
});

test("旧25条问答保留，新规划另存且幂等，不把旧链接循环分配给新问答", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: Array.from({ length: 25 }, (_, i) => `办公旧专题${i + 1}`),
    };
    const legacy = await f.flow.prepare(resource, "");
    const original = {
      ...legacy,
      stage: "ready" as const,
      rows: Array.from({ length: 25 }, (_, i) => ({
        keyword: resource.keywords[i],
        question: `办公资料第${i + 1}份的百度网盘在哪？`,
        answer: "<p>保留原本的问答内容。</p>",
        reviewed: false,
      })),
    };
    f.app.db.setSetting(`zhidao-publishing-resource:${legacy.id}`, original);
    const [planned] = f.flow.planMany([resource]);
    assert.notEqual(planned.id, legacy.id);
    assert.equal(planned.rows.length, 0);
    assert.equal(f.flow.planMany([resource])[0].id, planned.id);
    assert.deepEqual(f.flow.get(legacy.id).rows, original.rows);
    await assert.rejects(() => f.flow.export([legacy.id]), /先保存并审核/);
  } finally {
    await f.cleanup();
  }
});

test("本地已提交URL不再次分配，导出前新增提交记录也会阻断重复提交", async () => {
  const f = await setup();
  const submitted = (url: string) => {
    const runId = randomUUID();
    f.app.db.run(
      "INSERT INTO operation_runs(id,kind,title,status,config,total,created_at,updated_at) VALUES(?,'publish','历史发布','completed','{}',1,?,?)",
      runId,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    f.app.db.run(
      "INSERT INTO operation_items(id,run_id,item_key,status,data) VALUES(?,?,?,'submitted',?)",
      randomUUID(),
      runId,
      url,
      JSON.stringify({ link: url, answer: "" }),
    );
  };
  try {
    submitted("https://pan.baidu.com/s/canonical?pwd=abcd");
    f.flow.planMany([f.resource]);
    const generated = await f.flow.generate(f.resource.key);
    f.flow.saveRows(
      generated.id,
      generated.rows.map((row) => ({ ...row, reviewed: true })),
    );
    await f.flow.prepare(f.resource, "");
    const ready = await f.flow.shares(generated.id);
    assert.equal(ready.links.length, 2);
    assert.equal(f.counts().creates, 2);
    assert.ok(ready.links.every((link) => !link.url.endsWith("/canonical")));
    submitted(ready.links[0].url);
    await assert.rejects(() => f.flow.export([ready.id]), /有分享URL已提交/);
  } finally {
    await f.cleanup();
  }
});

test("第三步逐词记录去向：漏词/重复排除阻断，缺资料的方法词说明原因，无有效词保留原因", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: ["办公工具下载", "办公工具软件", "共享打印机主机ip地址怎么看"],
    };
    f.flow.planMany([resource]);
    f.setPlanOutput({
      groups: [{ index: 0, related: [], intent: "办公工具安装包获取" }],
      excluded: [],
    });
    await assert.rejects(() => f.flow.generate(resource.key), /未说明去向/);
    assert.equal(f.aiCalls.length, 0);
    f.setPlanOutput({
      groups: [{ index: 0, related: [1, 2], intent: "办公工具安装包获取" }],
      excluded: [{ index: 2, reason: "重复序号测试" }],
    });
    await assert.rejects(() => f.flow.generate(resource.key), /重复或无效序号/);
    f.setPlanOutput({
      groups: [{ index: 0, related: [1], intent: "办公工具安装包获取" }],
      excluded: [
        { index: 2, reason: "未提供查看IP的具体方法依据，需补充步骤资料" },
      ],
    });
    const result = await f.flow.generate(resource.key);
    assert.equal(result.rows.length, 1);
    assert.equal(result.generation?.excludedKeywords?.length, 1);
    assert.equal(result.generation?.planVersion, 3);
    assert.equal(result.generation?.validation?.status, "passed");
    assert.equal(f.reviewCalls.length, 1);
    const plan = result.keywordPlan;
    const optimized = await f.flow.generate(resource.key, false, true);
    assert.deepEqual(optimized.keywordPlan, plan);
    assert.equal(optimized.generation?.validation?.status, "passed");
    assert.equal(f.reviewCalls.length, 2);
    assert.equal(f.counts().creates, 0);
    const empty = {
      ...f.resource,
      key: randomUUID(),
      keywords: ["共享打印机主机ip地址怎么看"],
    };
    f.flow.planMany([empty]);
    f.setPlanOutput({
      groups: [],
      excluded: [{ index: 0, reason: "属于查看IP教程，不能生成资源获取题" }],
    });
    await assert.rejects(() => f.flow.generate(empty.key), /没有资料充分/);
    assert.equal(f.flow.get(empty.key).generation?.excludedKeywords?.length, 1);
    assert.equal(f.flow.get(empty.key).rows.length, 0);
    assert.equal(f.aiCalls.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("第三步生成后检查意图、无依据属性及近似题：拦截并保留草稿，不确认、不建链、不自动重试", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      keywords: ["办公工具下载", "办公工具Win10"],
    };
    f.flow.planMany([resource]);
    f.setReviewOutput({
      issues: [
        {
          index: 1,
          kind: "duplicate",
          duplicateOf: 0,
          reason: "此行没有保留Win10区别，与第1条相同获取意图，仅换了问法",
        },
      ],
    });
    await assert.rejects(
      () => f.flow.generate(resource.key),
      /问答意图检查发现1处问题/,
    );
    const failed = f.flow.get(resource.key);
    assert.equal(failed.generation?.validation?.status, "failed");
    assert.equal(failed.generation?.drafts.length, 2);
    assert.equal(failed.rows.length, 0);
    assert.equal(f.counts().creates, 0);
    const calls = f.reviewCalls.length;
    f.flow.get(resource.key);
    assert.equal(f.reviewCalls.length, calls);
    f.setReviewOutput({
      issues: [
        {
          index: 99,
          kind: "intent",
          duplicateOf: null,
          reason: "不存在的问答序号不能通过检查",
        },
      ],
    });
    await assert.rejects(() => f.flow.generate(resource.key), /无效结果/);
    assert.equal(f.flow.get(resource.key).rows.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("空介绍的本地资源在分组、生成、检查中使用相同文件依据，检查不因缺少summary误判真实目录", async () => {
  const f = await setup();
  try {
    const files = [{ ...file, name: "来自远方", isDirectory: true }];
    f.app.db.run(
      "UPDATE copies SET files=? WHERE id=?",
      JSON.stringify(files),
      f.saved.copyId,
    );
    const resource = {
      ...f.resource,
      title: "电影《我的姐妹》Sister My Sister 1",
      category: "影视资源",
      summary: "",
      keywords: [
        "《我的姐妹》完整版",
        "我的姐妹全集免费版观看高清版",
        "我的姐妹完整版观看",
        "我的姐妹全集免费版观看",
      ],
    };
    f.flow.planMany([resource]);
    f.setPlanOutput({
      groups: [{ index: 0, related: [1, 2, 3], intent: "获取同名电影资源" }],
      excluded: [],
    });
    f.setAiOutput(() => ({
      rows: [
        {
          index: 0,
          question: "电影《我的姐妹》的百度网盘分享地址在哪？",
          introduction:
            "《我的姐妹》（Sister My Sister）是本次收录的影视资源，可按中文名称或英文名称查找对应条目。",
        },
      ],
    }));
    f.setReviewOutput((input: GenerationInput) => ({
      issues: input.resource.files.some((entry) => entry.name === "来自远方")
        ? []
        : [
            {
              index: 0,
              kind: "unsupported",
              duplicateOf: null,
              reason: "检查阶段缺少写作时已提供的目录依据",
            },
          ],
    }));
    const generated = await f.flow.generate(resource.key);
    const expected = {
      title: resource.title,
      category: resource.category,
      summary: "",
      files: [{ name: "来自远方", isDirectory: true }],
    };
    for (const input of [f.planCalls[0], f.aiCalls[0], f.reviewCalls[0]])
      assert.deepEqual((input as GenerationInput).resource, expected);
    assert.equal(generated.rows.length, 1);
    assert.doesNotMatch(
      generated.rows[0].question + generated.rows[0].answer,
      /完整版|免费版|高清版|来自远方/,
    );
    assert.equal(generated.generation?.validation?.status, "passed");
    assert.equal(f.counts().creates, 0);
  } finally {
    await f.cleanup();
  }
});

test("显式修正只重写问题行并传入检查意见，失败后能续跑，保留有效草稿及分组且不自动建链", async () => {
  const f = await setup();
  try {
    f.flow.planMany([f.resource]);
    const reason = "标题中的完整版没有资料依据，请保留名称与获取需求";
    f.setReviewOutput({
      issues: [{ index: 1, kind: "unsupported", duplicateOf: null, reason }],
    });
    await assert.rejects(() => f.flow.generate(f.resource.key), /发现1处问题/);
    const before = f.flow.get(f.resource.key);
    const goodDraft = before.generation!.drafts.find(
      (draft) => draft.index === 0,
    );
    const plans = f.planCalls.length;
    const calls = f.aiCalls.length;
    f.flow.get(f.resource.key);
    assert.equal(f.aiCalls.length, calls, "只读与刷新不调用AI");

    f.setBeforeAi(() => {
      throw new Error("本次修正连接中断");
    });
    await assert.rejects(
      () => f.flow.generate(f.resource.key, false, true),
      /连接中断/,
    );
    const partial = f.flow.get(f.resource.key);
    assert.notEqual(partial.generation?.id, before.generation?.id);
    assert.deepEqual(partial.generation?.drafts, [goodDraft]);
    assert.deepEqual(partial.generation?.rejectedDrafts, [
      before.generation!.drafts.find((draft) => draft.index === 1),
    ]);
    assert.deepEqual(partial.generation?.topics, before.generation?.topics);
    assert.deepEqual(partial.keywordPlan, before.keywordPlan);
    assert.equal(partial.generation?.validation?.status, "failed");

    f.setBeforeAi(undefined);
    f.setReviewOutput({ issues: [] });
    const corrected = await f.flow.generate(f.resource.key);
    assert.equal(f.planCalls.length, plans, "已有分组不重做付费规划");
    assert.deepEqual(
      f.aiCalls.slice(calls).map((input) => input.rows.map((row) => row.index)),
      [[1], [1]],
    );
    assert.ok(
      f.aiCalls
        .slice(calls)
        .every((input) => JSON.stringify(input.rows).includes(reason)),
    );
    assert.deepEqual(
      corrected.generation?.drafts.find((draft) => draft.index === 0),
      goodDraft,
    );
    assert.equal(corrected.generation?.status, "completed");
    assert.equal(corrected.generation?.validation?.status, "passed");
    assert.equal(corrected.generation?.rejectedDrafts, undefined);
    assert.equal(corrected.rows.length, 2);
    assert.ok(corrected.rows.every((row) => !row.reviewed));
    assert.deepEqual(corrected.links, before.links);
    assert.deepEqual(corrected.operations, before.operations);
    assert.equal(f.counts().creates, 0);
  } finally {
    await f.cleanup();
  }
});

test("修正已完成但检查连接中断时保留新旧草稿，继续仅重查，不再次付费重写", async () => {
  const f = await setup();
  try {
    f.flow.planMany([f.resource]);
    f.setReviewOutput({
      issues: [
        {
          index: 0,
          kind: "unsupported",
          duplicateOf: null,
          reason: "这条简介需要去除未提供的版本描述",
        },
      ],
    });
    await assert.rejects(() => f.flow.generate(f.resource.key), /发现1处问题/);
    const before = f.flow.get(f.resource.key);
    f.setReviewOutput(() => {
      throw Error("检查请求连接中断");
    });
    await assert.rejects(
      () => f.flow.generate(f.resource.key, false, true),
      /检查请求连接中断/,
    );
    const pending = f.flow.get(f.resource.key);
    assert.equal(pending.generation?.drafts.length, 2);
    assert.equal(pending.generation?.validation, undefined);
    assert.equal(pending.generation?.rejectedDrafts?.length, 1);
    assert.equal(pending.rows.length, 0);
    const calls = f.aiCalls.length;
    f.setReviewOutput({ issues: [] });
    const result = await f.flow.generate(f.resource.key);
    assert.equal(f.aiCalls.length, calls);
    assert.equal(result.generation?.status, "completed");
    assert.deepEqual(result.generation?.drafts, pending.generation?.drafts);
    assert.equal(result.generation?.rejectedDrafts, undefined);
    assert.deepEqual(result.links, before.links);
    assert.equal(f.counts().creates, 0);
  } finally {
    await f.cleanup();
  }
});

test("14词旧稿扩展：不同需求可形成7题，先保留旧稿，失败续跑复用资料；确认后禁止重新分组", async () => {
  const f = await setup();
  try {
    const resource = {
      ...f.resource,
      ...coverageReplay,
      // Deliberately synthetic editorial input, not facts about the real programme.
      summary:
        "测试资料：提供该剧剧情梗概、角色结局、演员其他作品、12集的剧集安排和有日期的播出说明；包含十部爱情泰剧的选片介绍和推荐理由。",
    };
    f.flow.planMany([resource]);
    f.setAiOutput(() => ({
      rows: [
        {
          index: 0,
          question: "《爱情契约》的百度网盘资源在哪？",
          introduction:
            "这是测试资料中列出的影视资源，用于验证旧问答保留与扩展流程，不承诺免费观看。",
        },
      ],
    }));
    f.setPlanOutput({
      groups: [{ index: 0, related: [3, 12], intent: "获取该剧网盘资源" }],
      excluded: resource.keywords.flatMap((_, index) =>
        [0, 3, 12].includes(index)
          ? []
          : [{ index, reason: "旧版仅处理资源获取需求" }],
      ),
    });
    const old = await f.flow.generate(resource.key);
    assert.equal(old.rows.length, 1);
    const groups = [
      {
        index: 0,
        related: [3, 12],
        intent: "资源获取",
        kind: "resource",
        answerPoints: [],
      },
      {
        index: 2,
        related: [5],
        intent: "十部爱情泰剧的选片推荐及理由",
        kind: "knowledge",
        answerPoints: [
          "依据测试资料十部作品的介绍比较题材与观剧偏好，不宣称热度排名",
        ],
      },
      {
        index: 4,
        related: [6],
        intent: "主演的其他影视作品",
        kind: "knowledge",
        answerPoints: ["列出测试资料确认的演员和作品，不与同名作品混淆"],
      },
      {
        index: 7,
        related: [],
        intent: "角色结局",
        kind: "knowledge",
        answerPoints: ["先提示剧透，再据测试资料交代角色关系的结局与原因"],
      },
      {
        index: 9,
        related: [],
        intent: "官方更新安排",
        kind: "knowledge",
        answerPoints: ["按资料日期说明官方播出安排，不保证网盘更新"],
      },
      {
        index: 10,
        related: [],
        intent: "第12集的剧情衔接及观看顺序",
        kind: "knowledge",
        answerPoints: ["按测试资料说明第12集位置及前后剧情衔接，不承诺免费"],
      },
      {
        index: 11,
        related: [],
        intent: "剧情解析",
        kind: "knowledge",
        answerPoints: ["依据测试剧情资料分析主要冲突和人物动机"],
      },
    ];
    f.setPlanOutput({
      groups,
      excluded: [1, 8, 13].map((index) => ({
        index,
        reason: "作品身份或未删减版本缺少可靠依据",
      })),
    });
    f.setAiOutput(({ rows }) => ({
      rows: rows.map(({ index, kind }) => ({
        index,
        question:
          kind === "resource"
            ? "泰剧《爱情契约》的百度网盘分享链接在哪？"
            : `泰剧《爱情契约》的${groups[index].intent}是什么？`,
        introduction: `以下为测试回答${index + 1}。${groups[index].answerPoints.join("。")}。本段按对应需求分别组织实质内容，使用测试资料中提供的事实，验证内容题不再被强制改为链接获取问题。`,
      })),
    }));
    const researchCount = f.researchCalls.length;
    f.setReviewOutput({
      issues: [
        {
          index: 6,
          kind: "unsupported",
          duplicateOf: null,
          reason: "测试拦截：剧情分析需补充依据",
        },
      ],
    });
    await assert.rejects(
      () => f.flow.generate(resource.key, false, false, true),
      /问答意图检查/,
    );
    let current = f.flow.get(resource.key);
    assert.deepEqual(current.rows, old.rows, "新稿失败不能覆盖原稿");
    assert.equal(current.generation?.drafts.length, 7);
    assert.equal(
      current.generation?.topics?.filter((topic) => topic.kind === "knowledge")
        .length,
      6,
    );
    const accounted = current
      .generation!.topics!.flatMap((topic) => [
        topic.keyword,
        ...topic.relatedKeywords,
      ])
      .concat(
        current.generation!.excludedKeywords!.map((entry) => entry.keyword),
      );
    assert.equal(accounted.length, 14);
    assert.equal(new Set(accounted).size, 14);
    const calls = f.aiCalls.length;
    f.setReviewOutput({ issues: [] });
    current = await f.flow.generate(resource.key);
    assert.equal(current.rows.length, 7);
    assert.equal(
      f.researchCalls.length,
      researchCount,
      "复用已保存的检索资料，不重复付费检索",
    );
    assert.equal(f.aiCalls.length, calls, "续验不重写已完成正文");
    assert.equal(current.generation?.planVersion, 3);
    assert.ok(
      current.rows.slice(1).every((row) => !row.question.includes("百度网盘")),
    );
    assert.equal(f.counts().creates, 0, "生成和检查不建链");
    const linked = {
      ...current,
      rowShares: Object.fromEntries(
        current.rows.map((row, index) => [
          row.id!,
          { url: `https://pan.baidu.com/s/test${index}`, code: "" },
        ]),
      ),
    };
    const answers = publishingRowsWithLinks(linked);
    assert.ok(answers[0].answer.startsWith("<p><strong>点击链接"));
    assert.ok(
      answers[1].answer.startsWith(current.rows[1].answer),
      "内容题先给实质解答再附资源入口",
    );
    const confirmed = f.flow.saveRows(
      current.id,
      current.rows.map((row) => ({ ...row, reviewed: true })),
      current.generation!.id,
    );
    await assert.rejects(
      () => f.flow.generate(current.id, false, false, true),
      /已确认/,
    );
    assert.deepEqual(f.flow.get(current.id).rows, confirmed.rows);
  } finally {
    await f.cleanup();
  }
});
