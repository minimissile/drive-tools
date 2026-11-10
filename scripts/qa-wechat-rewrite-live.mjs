import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { wechatArticleImages } from "../shared/wechat-markup.ts";

/** Real configured model and saved production flow in a new independent edition.
 * No mock, network interception, login changes, transfer or remote publication. */
export async function run({ page, windowId, checkpoint }) {
  const out = join(tmpdir(), `panxu-wechat-rewrite-live-${windowId}`);
  await mkdir(out, { recursive: true });
  const updates = await page.evaluate(() => window.panxu.invoke("dev.updates"));
  const required = Number(process.env.PANXU_WECHAT_REWRITE_REVISION || 12);
  assert(
    updates.runningRevision >= required,
    "请先手动加载本次已编译的后端修复",
  );
  const sourceId = "wechat_ca230a4e-d406-41c6-83cf-b0296cbeb94c";
  const original = await page.evaluate(
    (id) => window.panxu.invoke("wechat.get", { id }),
    sourceId,
  );
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  const existingId = process.env.PANXU_WECHAT_REWRITE_VERIFY_ID;
  const created = existingId
    ? { article: { id: existingId, revision: 1, body: original.article.body } }
    : await page.evaluate(
        (args) => window.panxu.invoke("wechat.newEdition", args),
        {
          id: sourceId,
          revision: original.article.revision,
          requestId: randomUUID(),
        },
      );
  const id = created.article.id;
  try {
    await checkpoint();
    const rewritten = existingId
      ? await page.evaluate(
          (id) => window.panxu.invoke("wechat.get", { id }),
          id,
        )
      : await page.evaluate(
          (id) =>
            window.panxu.invoke("wechat.rewrite", {
              id,
              styleId: "commentary",
            }),
          id,
        );
    assert.equal(rewritten.article.revision, created.article.revision + 1);
    assert.equal(rewritten.article.rewriteStyleId, "commentary");
    assert.notEqual(
      rewritten.article.body,
      created.article.body,
      "实际更新正文",
    );
    assert(rewritten.article.title.trim());
    assert(rewritten.article.digest.trim());
    assert.match(rewritten.article.body, /\*\*[^*\n]+\*\*/, "Markdown重点保留");
    assert.deepEqual(
      wechatArticleImages(rewritten.article.body).map(
        ({ url, alt, markup }) => ({ url, alt, markup }),
      ),
      wechatArticleImages(original.article.body).map(
        ({ url, alt, markup }) => ({ url, alt, markup }),
      ),
      "原图与顺序不变",
    );
    assert.deepEqual(
      rewritten.article.links.map((link) => link.ownUrl || link.url),
      original.article.links.map((link) => link.ownUrl || link.url),
      "原有资源链接不变",
    );
    const after = await page.evaluate(
      (id) => window.panxu.invoke("wechat.get", { id }),
      sourceId,
    );
    assert.deepEqual(
      after.article,
      original.article,
      "不覆盖用户正在编辑的原稿",
    );
    assert.equal(rewritten.article.remote, null, "只完成本地改写，不发送微信");
    await page.evaluate(
      ({ windowId, dataPath, id }) => {
        localStorage.setItem(
          `panxu-window:${encodeURIComponent(windowId)}:panxu:wechat:${dataPath}:selection`,
          JSON.stringify({ url: "", selected: id, query: "", page: 1 }),
        );
      },
      { windowId, dataPath: snapshot.dataPath, id },
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page
      .locator(".wechat-editor")
      .getByRole("button", { name: "全屏预览", exact: true })
      .click();
    await page.getByRole("dialog", { name: "全屏预览", exact: true }).waitFor();
    await page.screenshot({ path: join(out, "rewritten-article.png") });
    const report = {
      windowId,
      out,
      sourceId,
      articleId: id,
      edition: rewritten.article.edition?.number,
      loadedRevision: updates.runningRevision,
      checks: [
        "真实Qwen改写成功",
        "标题正文摘要同时保存",
        "Markdown重点",
        "插图和资源链接原位保留",
        "原稿不变",
        "独立新稿未送微信",
      ],
    };
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    await writeFile(
      join(out, "failure.json"),
      JSON.stringify(
        { sourceId, articleId: id, message: error.message },
        null,
        2,
      ),
    );
    throw error;
  }
}
