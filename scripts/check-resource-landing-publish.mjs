// Explicit real-data publication check. Only run after reviewing generated.json.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const resourceId = "resource_332e6345-0873-4265-9d6f-4b7053a32d8c";
export async function run({ page, windowId }) {
  console.log("Publication test window:", windowId);
  const backend = await page.evaluate(() => window.panxu.invoke("dev.status"));
  const build = await fetch("http://127.0.0.1:8070/__panxu_dev").then((r) =>
    r.json(),
  );
  assert.equal(
    String(build.revision),
    backend.revision,
    "源码后端尚待安全重启",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await mkdir(".impeccable/review", { recursive: true });
  const state = await page.evaluate(
    (resourceId) => window.panxu.invoke("resourceLanding.get", { resourceId }),
    resourceId,
  );
  assert(
    state.draft && !state.stale && state.canPublish && !state.generating,
    "current draft must have fresh evidence before explicit review and publication",
  );
  const before = state.published?.version ?? 0;
  await page
    .getByRole("button", { name: "人情世故指南（PDF）", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "落地页内容", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "资源落地页", exact: true });
  await dialog.getByLabel("落地页标题").waitFor();
  const draft = await page.evaluate(
    (resourceId) => window.panxu.invoke("resourceLanding.get", { resourceId }),
    resourceId,
  );

  assert(draft.source.documents?.length, "Actual document reading required");
  await page.screenshot({ path: ".impeccable/review/editor-1440.png" });
  await dialog
    .getByRole("button", { name: /^(保存并发布|发布落地页|更新发布)$/ })
    .click();
  const deadline = Date.now() + 300000;
  for (;;) {
    const current = await page.evaluate(
      (resourceId) =>
        window.panxu.invoke("resourceLanding.get", { resourceId }),
      resourceId,
    );
    if (
      !current.pending &&
      current.published?.document &&
      current.published.version > before
    )
      break;
    if (!current.pending && current.error) throw new Error(current.error);
    if (!current.pending && (await dialog.locator(".notice").count()))
      throw new Error(await dialog.locator(".notice").first().innerText());
    if (Date.now() > deadline) {
      await page.screenshot({
        path: "/private/tmp/panxu-seo-qa/publish-failure.png",
      });
      throw new Error(
        current.error ?? (await dialog.innerText()).slice(0, 1800),
      );
    }
    await delay(500);
  }
  await dialog.getByText("已发布", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "阅读预览", exact: true }).click();
  await page.screenshot({ path: ".impeccable/review/editor-preview-1440.png" });
  const published = await page.evaluate(
    (resourceId) => window.panxu.invoke("resourceLanding.get", { resourceId }),
    resourceId,
  );
  await writeFile(
    "/private/tmp/panxu-seo-qa/published.json",
    JSON.stringify(published, null, 2),
  );
  await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  const links = await page.evaluate(
    async (resourceId) => ({
      landing: await window.panxu.invoke("resourceLinks.copy", {
        resourceId,
        kind: "landing",
      }),
      redirect: await window.panxu.invoke("resourceLinks.copy", {
        resourceId,
        kind: "redirect",
      }),
    }),
    resourceId,
  );
  assert(links.landing.text.includes("/r/"));
  assert(links.redirect.text.includes("/go/"));
  return {
    pageUrl: published.pageUrl,
    version: published.published.version,
    score: published.quality.score,
    links,
  };
}
