import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { devSessionRequest } from "./dev-session-client.mjs";

/** Paid calls require the user's explicit AI-test authorization. Never prepares shares or submits answers. */
export async function run({ page, windowId, checkpoint }) {
  const out = `/tmp/panxu-third-step/${windowId}`;
  await mkdir(out, { recursive: true });
  const live = process.env.PANXU_THIRD_STEP_LIVE === "1";
  const source = JSON.parse(
    await readFile(
      new URL(
        "../tests/fixtures/zhidao-publishing-20261124.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  const replay = process.env.PANXU_THIRD_STEP_RESULTS;
  let records;
  if (replay) records = JSON.parse(await readFile(replay, "utf8"));
  else if (live) {
    const updates = await devSessionRequest("dev.updates");
    assert.ok(updates.runningRevision >= 67, "修正后端尚未加载，本轮不调用AI");
    await writeFile(`${out}/backend.json`, JSON.stringify(updates, null, 2));
    const resources = source.map(
      ({ oldTopics, oldRows, ...resource }, index) => ({
        ...resource,
        key: randomUUID(),
        resourceId: "",
        copyId: "",
        link: `https://pan.baidu.com/s/qa-third-step-${index}`,
      }),
    );
    const installed = JSON.parse(
      await readFile(
        new URL("../dist-dev/main.js.map", import.meta.url),
        "utf8",
      ),
    );
    for (const relative of [
      "core/zhidao/publishing-generation.ts",
      "core/zhidao/publishing-workflow.ts",
      "shared/zhidao-workflow.ts",
    ]) {
      const index = installed.sources.findIndex((path) =>
        path.endsWith(`/${relative}`),
      );
      const current = await readFile(
        new URL(`../${relative}`, import.meta.url),
        "utf8",
      );
      assert.ok(
        index >= 0 && installed.sourcesContent[index] === current,
        `本次修正${relative}尚未加载，本轮不调用AI`,
      );
    }
    records = process.env.PANXU_THIRD_STEP_RESUME
      ? await page.evaluate(
          (ids) => window.panxu.invoke("zhidao.workflow.get", { ids }),
          JSON.parse(
            await readFile(process.env.PANXU_THIRD_STEP_RESUME, "utf8"),
          ),
        )
      : await page.evaluate(
          (resources) =>
            window.panxu.invoke("zhidao.workflow.planMany", { resources }),
          resources,
        );
    await writeFile(
      `${out}/planned-ids.json`,
      JSON.stringify(records.map((record) => record.id)),
    );
    for (let index = 0; index < records.length; index++) {
      await checkpoint();
      if (records[index].generation?.status === "completed") continue;
      try {
        records[index] = await page.evaluate(
          (id) => window.panxu.invoke("zhidao.workflow.generate", { id }),
          records[index].id,
        );
      } catch (error) {
        records[index] = (
          await page.evaluate(
            (id) => window.panxu.invoke("zhidao.workflow.get", { ids: [id] }),
            records[index].id,
          )
        )[0];
        records[index].qaError = error.message;
      }
      await writeFile(`${out}/results.json`, JSON.stringify(records, null, 2));
    }
  } else {
    records = source.map(({ oldTopics, oldRows, ...resource }, index) => {
      const id = randomUUID();
      const topics = oldTopics
        .filter(
          (topic) =>
            !/(怎么看|如何添加|怎么共享|设置在哪里|不见了)/.test(topic.keyword),
        )
        .slice(0, 3);
      const selected = new Set(
        topics.flatMap((topic) => [topic.keyword, ...topic.relatedKeywords]),
      );
      const excluded = resource.keywords
        .filter((keyword) => !selected.has(keyword))
        .map((keyword) => ({
          keyword,
          reason: "页面模拟：本词需核对资源依据或属于教程需求",
        }));
      const rows = topics.map((topic) => ({
        ...oldRows.find((row) => row.keyword === topic.keyword),
        id: topic.id,
        reviewed: false,
      }));
      return {
        id,
        resource: {
          ...resource,
          key: id,
          resourceId: "",
          copyId: "",
          link: `https://pan.baidu.com/s/qa-third-step-${index}`,
        },
        copyId: "",
        libraryResourceId: "",
        accountId: "",
        contentFirst: true,
        linkedAnswerFormat: true,
        stage: "draft",
        operations: [],
        links: [],
        rows,
        updatedAt: new Date().toISOString(),
        keywordPlan: { topics, excludedKeywords: excluded },
        generation: {
          id: randomUUID(),
          status: "completed",
          targets: rows.map((_, index) => index),
          drafts: [],
          topics,
          planVersion: 2,
          excludedKeywords: excluded,
          validation: { status: "passed", issues: [] },
        },
      };
    });
  }
  // Only this renderer uses a test transport. The live generation above used the actual backend.
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      body = await response.text();
    const next =
      'import { publishingMock } from "/scripts/qa-zhidao-publishing-mock.mjs";\n' +
      body.replace(
        /return window\.panxu\.invoke[^;]+;/,
        "return publishingMock(method,args);",
      );
    assert.notEqual(next, body);
    await route.fulfill({
      response,
      body: next,
      contentType: "application/javascript",
    });
  });
  await page.evaluate(async (records) => {
    const snapshot = await window.panxu.invoke("snapshot"),
      path = snapshot.dataPath + "/publishing-qa";
    sessionStorage.setItem(
      "zhidao-publishing-qa",
      JSON.stringify({
        records: Object.fromEntries(
          records.map((record) => [record.id, record]),
        ),
        calls: [],
      }),
    );
    const draft = {
      flowVersion: 2,
      step: 2,
      accountId: "",
      activeKey: records[0].id,
      rows: records.map((record) => ({
        ...record.resource,
        keywords: { seeds: "", text: record.resource.keywords.join("\n") },
        image: "",
        checked: true,
        prepared: false,
      })),
      pendingReviews: [],
      reviewVersions: {},
      keywordBatchId: "",
      keywordBatchApplied: [],
    };
    localStorage.setItem(
      `panxu-window:${encodeURIComponent(window.panxu.windowId)}:panxu-zhidao-publishing-workflow:${path}`,
      JSON.stringify(draft),
    );
  }, records);
  await page.reload();
  await page.locator(".publishing-keyword-plan summary").waitFor();
  for (const [index, record] of records.entries()) {
    if (index)
      await page
        .getByRole("button", { name: new RegExp(`${index + 1}\\. `) })
        .click();
    const details = page.locator(".publishing-keyword-plan");
    await page.screenshot({
      path: `${out}/resource-${index + 1}-before-open.png`,
    });
    if (!(await details.evaluate((node) => node.open)))
      await details.locator("summary").click();
    await details.getByRole("listitem").first().waitFor();
    const count = await details.getByRole("listitem").count();
    assert.equal(
      count,
      record.generation.topics.length +
        record.generation.excludedKeywords.length,
    );
    await page.screenshot({ path: `${out}/resource-${index + 1}.png` });
    if (record.generation.status === "failed") {
      await page
        .getByRole("button", {
          name:
            record.generation.validation?.status === "failed"
              ? "修正问题并重新检查"
              : "返回调整关键词",
          exact: true,
        })
        .waitFor();
    } else {
      await page.getByLabel("第1条问题标题", { exact: true }).waitFor();
      if (await details.evaluate((node) => node.open))
        await details.locator("summary").click();
      await page.screenshot({
        path: `${out}/resource-${index + 1}-review.png`,
      });
      assert.equal(
        await page
          .getByRole("button", { name: "下一步：转存与独立链接", exact: true })
          .isDisabled(),
        true,
      );
    }
  }
  await page.reload();
  await page.locator(".publishing-keyword-plan summary").waitFor();
  const state = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("zhidao-publishing-qa")),
  );
  assert.equal(
    state.calls.filter((call) =>
      /generate|prepare|shares|publish/.test(call.method),
    ).length,
    0,
    "刷新不得触发AI、建链或发布",
  );
  if (!live && !replay) {
    await page.evaluate(() => {
      const state = JSON.parse(sessionStorage.getItem("zhidao-publishing-qa"));
      const record = Object.values(state.records).at(-1);
      record.generation.status = "failed";
      record.generation.validation = {
        status: "failed",
        issues: [{ index: 0, reason: "此题与另一条获取意图相同，仅换了问法" }],
      };
      record.generation.message =
        "问答意图检查发现问题：此题与另一条获取意图相同，仅换了问法。请返回调整关键词。";
      record.rows = [];
      sessionStorage.setItem("zhidao-publishing-qa", JSON.stringify(state));
    });
    await page.reload();
    await page
      .getByRole("button", { name: "返回调整关键词", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "继续生成剩余问答", exact: true })
        .count(),
      0,
    );
    await page.screenshot({ path: `${out}/validation-failed.png` });
    await page
      .getByRole("button", { name: "返回调整关键词", exact: true })
      .click();
    assert.match(
      await page
        .locator(".publishing-steps li[data-state=current]")
        .textContent(),
      /检查关键词/,
    );
  }
  assert.deepEqual(errors, []);
  const summary = records.map((record) => ({
    id: record.id,
    title: record.resource.title,
    keywords: record.resource.keywords.length,
    groups: record.generation.topics?.length,
    excluded: record.generation.excludedKeywords?.length,
    rows: record.rows.length,
    validation: record.generation.validation,
    status: record.generation.status,
    error: record.qaError,
  }));
  await writeFile(
    `${out}/summary.json`,
    JSON.stringify({ live, summary }, null, 2),
  );
  if (live)
    assert.ok(
      summary.every(
        (record) =>
          record.status === "completed" &&
          record.validation?.status === "passed",
      ),
      `真实生成尚未全部通过，详情保存在${out}/summary.json；不自动重试模型调用。`,
    );
  return {
    out,
    live,
    summary,
    checks: [
      "逐词归组和排除原因",
      "第三步检查页面",
      "失败定位与调整入口",
      "未确认不进入建链",
      "刷新不自动生成或发布",
    ],
  };
}
