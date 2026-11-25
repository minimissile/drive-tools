// Browser plugin not available. Attach an exact-ID source test window; only its
// API module uses an isolated service and declared mock business transports.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { publishingFixture } from "../tests/zhidao-publish-fixture.ts";

export async function run({ page, windowId }) {
  const out = `/tmp/panxu-zhidao-cleanup/${windowId}`;
  await mkdir(out, { recursive: true });
  const f = await publishingFixture();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const sources = f.seed(31, false);
    const published = f.service.zhidao.store.create(
      "publish",
      "已提交问答回执",
      {
        accountId: f.account.id,
        taskName: "已提交问答回执",
        itemIds: sources.slice(0, 21).map((source) => source.id),
        uploadMode: "batch-v1",
      },
      21,
    );
    for (const source of sources.slice(0, 21))
      f.service.zhidao.store.put(published.id, source.id, {
        ...source,
        id: `published-${source.id}`,
        runId: published.id,
        key: source.id,
        status: "submitted",
        taskId: "123456",
      });
    f.service.zhidao.store.state(
      published.id,
      "completed",
      "已提交21条，保留原始回执",
      21,
    );
    const sourceBefore = sources.map((source) =>
      f.service.zhidao.store.item(source.id),
    );
    await page.exposeFunction("__cleanupQaRead", async (method, args) => {
      assert.ok(
        ["zhidao.templates", "zhidao.runs", "zhidao.run"].includes(method),
        "清理验收只允许读取隔离服务",
      );
      return f.invoke(method, args);
    });
    await page.route("**/src/api/client.ts*", async (route) => {
      const response = await route.fetch(),
        body = await response.text();
      const next =
        'import { publishingMock } from "/scripts/qa-zhidao-publishing-mock.mjs";\n' +
        body.replace(
          /return window\.panxu\.invoke[^;]+;/,
          'return ["zhidao.templates","zhidao.runs","zhidao.run"].includes(method) ? window.__cleanupQaRead(method,args) : publishingMock(method,args);',
        );
      assert.notEqual(next, body);
      await route.fulfill({
        response,
        body: next,
        contentType: "application/javascript",
      });
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.reload();
    const button = (name) => page.getByRole("button", { name, exact: true });
    await page
      .getByRole("heading", { name: "问答发布", exact: true })
      .waitFor();
    assert.equal(await button("管理知道账号").count(), 1);
    await button("已有问答上传").click();
    await page.getByText(sources[30].question, { exact: true }).waitFor();
    assert.equal(
      await page
        .locator(".publish-upload-workspace .operations-table tbody tr")
        .count(),
      10,
    );
    assert.equal(
      await page.getByText(sources[0].question, { exact: true }).count(),
      0,
    );
    assert.equal(await button("管理知道账号").count(), 1);
    assert.equal(await button("管理发布账号").count(), 0);
    assert.equal(await button("上传所选问答").isDisabled(), true);
    await page
      .locator(".publish-upload-workspace .operations-table")
      .evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${out}/pending-10.png` });
    await page.reload();
    await page.getByText(sources[30].question, { exact: true }).waitFor();
    assert.equal(
      await page
        .locator(".publish-upload-workspace .operations-table tbody tr")
        .count(),
      10,
    );
    await button("发布记录").click();
    await page
      .getByRole("combobox", { name: "选择发布记录", exact: true })
      .waitFor();
    await page.getByText("已提交21条，保留原始回执", { exact: true }).waitFor();
    assert.equal(f.service.zhidao.store.items(published.id).length, 21);
    assert.deepEqual(
      sources.map((source) => f.service.zhidao.store.item(source.id)),
      sourceBefore,
    );
    await page.screenshot({ path: `${out}/history-preserved.png` });
    await button("返回五步制作表格").click();
    await page
      .getByRole("button", { name: "录入库外资源", exact: true })
      .waitFor();
    assert.equal(await button("管理知道账号").count(), 1);
    assert.equal(f.events.filter((event) => event.type === "upload").length, 0);
    assert.deepEqual(errors, []);
    return {
      out,
      checks: [
        "31条来源中过滤21条已提交，仅显示10条待审核",
        "刷新保留筛选结果",
        "账号管理入口仅一处",
        "发布回执与源稿均保留",
        "五步入口可返回",
        "无真实AI、建链或发布",
      ],
    };
  } finally {
    await f.cleanup();
  }
}
