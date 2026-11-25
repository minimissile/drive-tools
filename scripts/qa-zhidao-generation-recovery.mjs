// Browser plugin unavailable; use one exact-ID source test window. The page's
// business transport calls an isolated service with a simulated model only.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { publishingFixture } from "../tests/zhidao-publish-fixture.ts";
import { devSessionRequest } from "./dev-session-client.mjs";

export async function run({ page, windowId }) {
  const out = `/tmp/panxu-zhidao-generation-recovery/${windowId}`;
  await mkdir(out, { recursive: true });
  const f = await publishingFixture();
  const errors = [],
    calls = [],
    modelCalls = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await f.service.secrets.set("openrouter", "fixture-only");
    f.service.db.setSetting("model", "fixture-model");
    const id = randomUUID();
    const resource = {
      key: id,
      resourceId: "",
      copyId: "",
      title: "电影《我的姐妹》Sister My Sister 1",
      link: "https://pan.baidu.com/s/fixture-resource",
      category: "影视资源",
      summary: "",
      image: "",
      keywords: [
        "《我的姐妹》完整版",
        "我的姐妹全集免费版观看高清版",
        "我的姐妹完整版观看",
        "我的姐妹全集免费版观看",
      ],
    };
    const [planned] = f.service.zhidaoWorkflow.planMany([resource]);
    const reason = "标题声称完整版，但资源名称和介绍未提供完整度依据。";
    const failed = {
      ...planned,
      generation: {
        id: randomUUID(),
        status: "failed",
        targets: [0],
        planVersion: 2,
        topics: [
          {
            id: randomUUID(),
            keyword: resource.keywords[0],
            relatedKeywords: resource.keywords.slice(1),
            intent: "获取同名电影资源",
          },
        ],
        drafts: [
          {
            index: 0,
            question: "电影《我的姐妹》完整版百度网盘分享地址有吗？",
            introduction:
              "电影《我的姐妹》（Sister My Sister）的影视资源，目录中可见一个名为“来自远方”的文件夹。",
          },
        ],
        validation: { status: "failed", issues: [{ index: 0, reason }] },
        message: "问答意图检查发现1处问题。",
      },
    };
    f.service.db.setSetting(`zhidao-publishing-resource:${id}`, failed);
    f.service.ai.resourceExport = async (
      name,
      schema,
      _instruction,
      input,
      _images,
      options,
    ) => {
      options?.beforeRequest?.();
      modelCalls.push(name);
      if (name === "zhidao_publishing_questions") {
        assert.deepEqual(
          input.rows.map((row) => row.index),
          [0],
        );
        assert.deepEqual(input.rows[0].corrections, [reason]);
        if (modelCalls.filter((phase) => phase === name).length === 1)
          throw Error(
            "服务请求失败（HTTP 400）。Request path cannot be relayed",
          );
        return schema.parse({
          rows: [
            {
              index: 0,
              question: "电影《我的姐妹》的百度网盘分享地址在哪？",
              introduction:
                "《我的姐妹》（Sister My Sister）是本次收录的影视资源，可按中文名称或英文名称查找对应条目。",
            },
          ],
        });
      }
      assert.equal(name, "zhidao_publishing_review");
      assert.equal(input.rows.length, 1);
      assert.doesNotMatch(
        input.rows[0].question + input.rows[0].introduction,
        /完整版|免费版|高清版|来自远方/,
      );
      if (modelCalls.filter((phase) => phase === name).length === 1)
        throw Error("检查请求连接中断，已改写的草稿保留。");
      return schema.parse({ issues: [] });
    };
    const methods = ["zhidao.workflow.get", "zhidao.workflow.generate"];
    await page.exposeFunction("__recoveryQa", async (method, args) => {
      assert.ok(methods.includes(method));
      calls.push({ method, args });
      return f.invoke(method, args);
    });
    await page.route("**/src/api/client.ts*", async (route) => {
      const response = await route.fetch(),
        body = await response.text();
      const next =
        'import { publishingMock } from "/scripts/qa-zhidao-publishing-mock.mjs";\n' +
        body.replace(
          /return window\.panxu\.invoke[^;]+;/,
          `return ${JSON.stringify(methods)}.includes(method) ? window.__recoveryQa(method,args) : publishingMock(method,args);`,
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
    await button("修正问题并重新检查").waitFor();
    await page
      .getByRole("list", { name: "需要修正的问答" })
      .getByText(failed.generation.drafts[0].question, { exact: true })
      .waitFor();
    assert.equal(await button("下一步：转存与独立链接").isDisabled(), true);
    assert.deepEqual(modelCalls, []);
    await page.screenshot({ path: `${out}/failed.png` });
    await page.reload();
    await button("修正问题并重新检查").waitFor();
    assert.deepEqual(modelCalls, [], "刷新不自动调用AI");
    await click("修正问题并重新检查");
    await page
      .locator(".publishing-review-panel .notice")
      .getByText("服务请求失败（HTTP 400）。Request path cannot be relayed", {
        exact: true,
      })
      .waitFor();
    await page
      .getByRole("list", { name: "需要修正的问答" })
      .getByText(failed.generation.drafts[0].question, { exact: true })
      .waitFor();
    assert.equal(
      f.service.zhidaoWorkflow.get(id).generation.rejectedDrafts.length,
      1,
    );
    assert.deepEqual(modelCalls, ["zhidao_publishing_questions"]);
    await page.screenshot({ path: `${out}/service-error.png` });
    await click("修正问题并重新检查");
    await button("重新检查问答").waitFor();
    assert.deepEqual(modelCalls, [
      "zhidao_publishing_questions",
      "zhidao_publishing_questions",
      "zhidao_publishing_review",
    ]);
    assert.equal(f.service.zhidaoWorkflow.get(id).generation.drafts.length, 1);
    await click("重新检查问答");
    await page.getByLabel("第1条问题标题", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("第1条问题标题", { exact: true }).inputValue(),
      "电影《我的姐妹》的百度网盘分享地址在哪？",
    );
    assert.deepEqual(modelCalls, [
      "zhidao_publishing_questions",
      "zhidao_publishing_questions",
      "zhidao_publishing_review",
      "zhidao_publishing_review",
    ]);
    assert.deepEqual(
      calls.filter((c) => c.method.endsWith("generate")),
      [
        { method: "zhidao.workflow.generate", args: { id, optimize: true } },
        { method: "zhidao.workflow.generate", args: { id, optimize: true } },
        { method: "zhidao.workflow.generate", args: { id } },
      ],
    );
    assert.equal(
      await button("下一步：转存与独立链接").isDisabled(),
      true,
      "修正不代替人工确认",
    );
    assert.deepEqual(f.service.zhidaoWorkflow.get(id).links, []);
    assert.deepEqual(f.service.zhidaoWorkflow.get(id).operations, []);
    assert.equal(f.service.zhidaoWorkflow.get(id).rows[0].reviewed, false);
    await page.screenshot({ path: `${out}/corrected.png` });
    await page.reload();
    await page.getByLabel("第1条问题标题", { exact: true }).waitFor();
    assert.equal(modelCalls.length, 4, "刷新后不重写已经修正的草稿");
    assert.deepEqual(errors, []);
    return {
      out,
      modelCalls,
      onlyRejectedRowsRewritten: true,
      noRemoteWrites: true,
    };
  } finally {
    await f.cleanup();
  }
}
