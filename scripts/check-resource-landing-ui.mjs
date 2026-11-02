import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const resourceId = "resource_332e6345-0873-4265-9d6f-4b7053a32d8c";
export async function run({ page, windowId }) {
  console.log("SEO test window:", windowId);
  const backend = await page.evaluate(() => window.panxu.invoke("dev.status"));
  console.log("Backend:", backend);
  const build = await fetch("http://127.0.0.1:8070/__panxu_dev").then((r) =>
    r.json(),
  );
  assert.equal(
    String(build.revision),
    backend.revision,
    "源码后端尚待安全重启，本轮不调用 AI",
  );
  await mkdir("/private/tmp/panxu-seo-qa", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("button", { name: "人情世故指南（PDF）", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "落地页内容", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "资源落地页", exact: true });
  await dialog.waitFor();
  await dialog.getByLabel("落地页编辑补充").waitFor();
  await page.screenshot({ path: "/private/tmp/panxu-seo-qa/editor-empty.png" });
  const initial = await page.evaluate(
    (resourceId) => window.panxu.invoke("resourceLanding.get", { resourceId }),
    resourceId,
  );
  assert(initial.source.files.length > 0);
  if (!initial.draft || process.env.PANXU_SEO_REGENERATE === "1") {
    // Explicit UI trigger. This uses the configured real writer/reviewer models.
    await dialog
      .getByRole("button", {
        name: initial.draft ? "重新生成草稿" : "生成落地页草稿",
        exact: true,
      })
      .click();
    await dialog
      .getByRole("button", { name: "正在撰写并检查…", exact: true })
      .waitFor();
    await dialog.getByLabel("落地页标题").waitFor({ timeout: 300000 });
    await dialog
      .getByRole("button", { name: "重新生成草稿", exact: true })
      .waitFor({ timeout: 300000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent === "重新生成草稿" && !b.disabled,
        ),
      undefined,
      { timeout: 720000 },
    );
  }
  const generated = await page.evaluate(
    (resourceId) => window.panxu.invoke("resourceLanding.get", { resourceId }),
    resourceId,
  );
  await writeFile(
    "/private/tmp/panxu-seo-qa/generated.json",
    JSON.stringify(generated, null, 2),
  );
  assert(generated.draft, "real AI generated article");
  if (process.env.PANXU_SEO_REGENERATE === "1")
    assert(
      generated.draftVersion > initial.draftVersion,
      generated.error ?? "generation did not produce a new draft",
    );
  await page.screenshot({
    path: "/private/tmp/panxu-seo-qa/editor-generated.png",
  });
  if (process.env.PANXU_SEO_CAPTURE_REVIEW === "1") {
    await mkdir(".impeccable/review", { recursive: true });
    await page.screenshot({ path: ".impeccable/review/editor-1440.png" });
  }
  await dialog.getByRole("button", { name: "阅读预览", exact: true }).click();
  assert(
    (await dialog.locator(".landing-reading-preview").innerText()).includes(
      generated.draft.title,
    ),
  );
  await page.screenshot({
    path: "/private/tmp/panxu-seo-qa/editor-preview.png",
  });
  if (process.env.PANXU_SEO_CAPTURE_REVIEW === "1")
    await page.screenshot({
      path: ".impeccable/review/editor-preview-1440.png",
    });
  await dialog.getByRole("button", { name: "编辑内容", exact: true }).click();
  // A reversible edit exercises per-window restoration without saving business data.
  const title = dialog.getByLabel("落地页标题");
  await title.fill(generated.draft.title + "（编辑暂存）");
  await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page.getByRole("button", { name: "落地页内容", exact: true }).click();
  const restored = page.getByRole("dialog", {
    name: "资源落地页",
    exact: true,
  });
  await restored.getByLabel("落地页标题").waitFor();
  assert.equal(
    await restored.getByLabel("落地页标题").inputValue(),
    generated.draft.title + "（编辑暂存）",
  );
  await restored.getByLabel("落地页标题").fill(generated.draft.title);
  assert.deepEqual(errors, []);
  return {
    resourceId,
    quality: generated.quality,
    targetIssue: generated.targetIssue,
    errors,
  };
}
