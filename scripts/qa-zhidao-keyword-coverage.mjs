// Browser plugin not available. Use the project's exact-ID test window and an
// isolated business service; no real research, model, share or publish request.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { publishingFixture } from "../tests/zhidao-publish-fixture.ts";
import { devSessionRequest } from "./dev-session-client.mjs";

export async function run({ page, windowId }) {
  const out = `/tmp/panxu-zhidao-keyword-coverage/${windowId}`;
  await mkdir(out, { recursive: true });
  const f = await publishingFixture();
  const errors = [],
    calls = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await f.service.secrets.set("openrouter", "fixture-only");
    f.service.db.setSetting("model", "fixture-model");
    const replay = JSON.parse(
      await readFile(
        new URL(
          "../tests/fixtures/zhidao-keyword-coverage-20261125.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const id = randomUUID();
    const resource = {
      ...replay,
      key: id,
      resourceId: "",
      copyId: "",
      link: "https://pan.baidu.com/s/fixture-only",
      image: "",
    };
    const [planned] = f.service.zhidaoWorkflow.planMany([resource]);
    const old = {
      ...planned,
      rows: [
        {
          id: randomUUID(),
          keyword: resource.keywords[0],
          question: "《爱情契约》的百度网盘资源在哪？",
          answer:
            "<p>这是测试页面保留的原有资源介绍，只用于验证原稿与新版切换。</p>",
          reviewed: false,
        },
      ],
      generation: {
        id: randomUUID(),
        status: "completed",
        targets: [0],
        drafts: [],
        planVersion: 2,
        topics: [
          {
            id: randomUUID(),
            keyword: resource.keywords[0],
            relatedKeywords: [],
          },
        ],
        excludedKeywords: resource.keywords
          .slice(1)
          .map((keyword) => ({ keyword, reason: "旧版仅接受获取类问题" })),
        validation: { status: "passed", issues: [] },
      },
    };
    f.service.db.setSetting(`zhidao-publishing-resource:${id}`, old);
    const groups = [
      {
        index: 0,
        related: [3, 12],
        kind: "resource",
        intent: "网盘资源获取",
        answerPoints: [],
      },
      {
        index: 4,
        related: [6],
        kind: "knowledge",
        intent: "演员其他作品",
        answerPoints: [
          "测试演员甲出演示例作品《海边》和《归途》，分别为家庭剧和公路片",
        ],
      },
      {
        index: 7,
        related: [],
        kind: "knowledge",
        intent: "角色结局",
        answerPoints: [
          "仅使用测试剧情：两位主角通过协商化解家庭冲突，不将这一虚构测试事实当成真实剧集结局",
        ],
      },
      {
        index: 11,
        related: [],
        kind: "knowledge",
        intent: "剧情分析",
        answerPoints: [
          "分析测试剧情中家庭选择与个人承诺之间的冲突及人物行动，不以介绍代替回答",
        ],
      },
    ];
    const used = groups.flatMap((group) => [group.index, ...group.related]);
    f.service.ai.resourceExport = async (
      name,
      schema,
      _instruction,
      input,
      _images,
      options,
    ) => {
      options?.beforeRequest?.();
      calls.push(name);
      if (name === "zhidao_publishing_research") {
        options.onWebSources?.([
          {
            url: "https://example.com/qa-source",
            title: "隔离测试资料（示例）",
            content: groups.flatMap((group) => group.answerPoints).join("。"),
          },
        ]);
        return schema.parse({
          facts: [
            {
              statement: "隔离测试资料包含演员作品、角色结局与剧情冲突。",
              sourceUrls: ["https://example.com/qa-source"],
            },
          ],
          gaps: ["这是模拟资料，不代表真实剧集事实。"],
        });
      }
      if (name === "zhidao_publishing_plan")
        return schema.parse({
          groups,
          excluded: resource.keywords.flatMap((_, index) =>
            used.includes(index)
              ? []
              : [{ index, reason: "测试未提供对应版本、热度或播出依据" }],
          ),
        });
      if (name === "zhidao_publishing_questions")
        return schema.parse({
          rows: input.rows.map(({ index, kind, answerPoints }) => ({
            index,
            question:
              kind === "resource"
                ? "《爱情契约》的百度网盘链接在哪？"
                : `《爱情契约》的${groups[index].intent}是什么？`,
            introduction:
              kind === "resource"
                ? "本条为隔离页面测试的资源获取回答，仅介绍所选资源名称及分类，不承诺免费或全集。"
                : `${answerPoints.join("。")}。\n本段只用于隔离测试，验证完整回答、换行与相关资料来源在页面中的展示。`,
          })),
        });
      assert.equal(name, "zhidao_publishing_review");
      return schema.parse({ issues: [] });
    };
    const methods = [
      "zhidao.workflow.get",
      "zhidao.workflow.generate",
      "zhidao.workflow.saveRows",
    ];
    await page.exposeFunction("__coverageQa", async (method, args) => {
      assert.ok(methods.includes(method));
      return f.invoke(method, args);
    });
    await page.route("**/src/api/client.ts*", async (route) => {
      const response = await route.fetch(),
        body = await response.text();
      const next =
        'import { publishingMock } from "/scripts/qa-zhidao-publishing-mock.mjs";\n' +
        body.replace(
          /return window\.panxu\.invoke[^;]+;/,
          `return ${JSON.stringify(methods)}.includes(method) ? window.__coverageQa(method,args) : publishingMock(method,args);`,
        );
      assert.notEqual(next, body);
      await route.fulfill({
        response,
        body: next,
        contentType: "application/javascript",
      });
    });
    await page.evaluate(async (resource) => {
      const snapshot = await window.panxu.invoke("snapshot");
      const { windowStorage } = await import("/src/storage/window-storage.ts");
      windowStorage.setItem(
        `panxu-zhidao-publishing-workflow:${snapshot.dataPath}/publishing-qa`,
        JSON.stringify({
          flowVersion: 2,
          step: 2,
          accountId: "",
          activeKey: resource.key,
          rows: [
            {
              ...resource,
              keywords: { seeds: "", text: resource.keywords.join("\n") },
              checked: true,
              prepared: false,
            },
          ],
          pendingReviews: [],
          reviewVersions: {},
          keywordBatchId: "",
          keywordBatchApplied: [],
        }),
      );
      sessionStorage.setItem(
        "zhidao-publishing-qa",
        JSON.stringify({ records: {}, calls: [] }),
      );
    }, resource);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.reload();
    const button = (name) => page.getByRole("button", { name, exact: true });
    const click = async (name) => {
      await devSessionRequest("dev.session.focus", { id: windowId });
      await button(name).click();
    };
    await button("扩展关键词覆盖").waitFor();
    assert.deepEqual(calls, [], "读取旧稿不自动调用AI");
    await click("扩展关键词覆盖");
    await page.getByLabel("第4条问题标题", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("第2条问题标题", { exact: true }).inputValue(),
      "《爱情契约》的演员其他作品是什么？",
    );
    assert.deepEqual(calls, [
      "zhidao_publishing_research",
      "zhidao_publishing_plan",
      "zhidao_publishing_questions",
      "zhidao_publishing_questions",
      "zhidao_publishing_review",
    ]);
    const record = f.service.zhidaoWorkflow.get(id);
    assert.equal(record.rows.length, 4);
    assert.ok(record.rows.every((row) => !row.reviewed));
    assert.equal(record.operations.length, 0);
    assert.equal(record.links.length, 0);
    assert.equal(await button("下一步：转存与独立链接").isDisabled(), true);
    await page.locator(".publishing-keyword-plan > summary").click();
    await page.getByText("补充资料 · 1 个来源", { exact: true }).click();
    await page.getByRole("link", { name: "隔离测试资料（示例）" }).waitFor();
    await page.screenshot({ path: `${out}/coverage-and-sources.png` });
    await page.locator(".publishing-keyword-plan > summary").click();
    await page
      .getByLabel("第2条回答内容", { exact: true })
      .fill("<p>手工编辑内容应先保存，不能直接被扩展生成覆盖。</p>");
    assert.equal(await button("扩展关键词覆盖").isDisabled(), true);
    await page.reload();
    await page.getByLabel("第2条回答内容", { exact: true }).waitFor();
    assert.match(
      await page.getByLabel("第2条回答内容", { exact: true }).inputValue(),
      /手工编辑/,
    );
    assert.equal(calls.length, 5, "刷新保留编辑，不重复研究或生成");
    await page.screenshot({ path: `${out}/review.png` });
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    return {
      windowId,
      out,
      calls,
      before: 1,
      after: record.rows.length,
      sources: record.generation.research.sources.length,
      realAiCalls: false,
      remoteOperations: 0,
    };
  } finally {
    await f.cleanup();
  }
}
