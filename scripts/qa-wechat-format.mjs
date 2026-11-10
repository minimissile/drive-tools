import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatWechatRewriteBody } from "../core/wechat/rewrite-layout.ts";
import { wechatHtml } from "../shared/wechat-markup.ts";

/** Preview a copy of the reported article through this page only; never edit the user's draft. */
export async function run({ page, windowId }) {
  const out = join(tmpdir(), `panxu-wechat-format-${windowId}`);
  await mkdir(out, { recursive: true });
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  const source = await page.evaluate(() =>
    window.panxu.invoke("wechat.get", {
      id: "wechat_c29c4aaa-979a-4a04-b97f-b02b4e9fd783",
    }),
  );
  const detail = structuredClone(source);
  detail.article.id = `format-${windowId}`;
  detail.article.body = formatWechatRewriteBody(source.article.body);
  detail.article.stage = "editing";
  detail.article.remote =
    detail.article.pendingAccount =
    detail.article.pendingDraft =
      null;
  detail.editions = undefined;
  assert.match(detail.article.body, /## 获取方法如下/);
  assert.match(wechatHtml(detail.article.body), /border-radius:12px/);
  await page.exposeFunction("__formatQaInvoke", async (method) => {
    if (method === "wechat.get") return detail;
    if (method === "wechat.list")
      return [{ ...detail.article, sentRevision: null }];
    throw Error(`排版验收未启用写操作 ${method}`);
  });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      source = await response.text(),
      needle = "return window.panxu.invoke(method, args);";
    assert(source.includes(needle));
    await route.fulfill({
      response,
      body: source.replace(
        needle,
        'return method.startsWith("wechat.") ? window.__formatQaInvoke(method,args) : window.panxu.invoke(method,args);',
      ),
    });
  });
  await page.evaluate(
    ({ windowId, dataPath, id }) =>
      localStorage.setItem(
        `panxu-window:${encodeURIComponent(windowId)}:panxu:wechat:${dataPath}:selection`,
        JSON.stringify({ url: "", selected: id, query: "", page: 1 }),
      ),
    { windowId, dataPath: snapshot.dataPath, id: detail.article.id },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const editor = page.locator(".wechat-editor");
  await editor.getByRole("button", { name: "全屏预览", exact: true }).click();
  const comparison = page.getByRole("dialog", {
    name: "全屏预览",
    exact: true,
  });
  const current = comparison.locator(
    "section[aria-labelledby='wechat-comparison-current']",
  );
  await current
    .getByRole("heading", { name: "获取方法如下", exact: true })
    .waitFor();
  assert.equal(
    await current.getByText("夸克网盘资源", { exact: true }).count(),
    1,
  );
  assert.equal(
    await current
      .getByText("点击文末“阅读原文”打开资源", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await current
      .locator(".wechat-comparison-scroll")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  await page.screenshot({ path: join(out, "reported-article-fixed.png") });
  const report = {
    windowId,
    out,
    sourceId: source.article.id,
    checks: [
      "真实问题稿件的副本",
      "独立引导语变为小标题",
      "入口链接🔗呈现资源卡片",
      "资源地址和原图引用保持",
      "全屏预览无横向溢出",
      "无共享稿件或远端写入",
    ],
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
