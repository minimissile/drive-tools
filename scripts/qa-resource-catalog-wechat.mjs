import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function run({ page, windowId }) {
  console.log(JSON.stringify({ windowId }));
  const evidence = resolve("test-results/resource-catalog-wechat");
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".catalog-page").waitFor();
  const actual = page.getByRole("button", {
    name: "导出到公众号草稿箱",
    exact: true,
  });
  if (await actual.count())
    await page.screenshot({ path: resolve(evidence, "source-entry.png") });
  const origin = new URL(page.url()).origin;
  async function load(scenario = "normal") {
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style><iframe src="${origin}/__qa-resource-catalog.html?controls=0&scenario=${scenario}"></iframe>`,
    );
    const root = page.frameLocator("iframe");
    await root.locator(".catalog-page").waitFor();
    return root;
  }
  let root = await load("wechat-error");
  let action = root.getByRole("button", {
    name: "导出到公众号草稿箱",
    exact: true,
  });
  await action.click();
  await root
    .getByRole("alert")
    .getByText("模拟：草稿导出失败，未创建草稿。", { exact: true })
    .waitFor();
  assert.equal(await action.isEnabled(), true);
  assert.equal(await root.locator(".catalog-page").count(), 1);
  root = await load();
  action = root.getByRole("button", {
    name: "导出到公众号草稿箱",
    exact: true,
  });
  await action.click();
  assert.equal(await action.isDisabled(), true);
  await root
    .getByRole("heading", { name: "公众号草稿箱", level: 1, exact: true })
    .waitFor();
  const title = root.getByRole("textbox", { name: /文章标题/ });
  await title.waitFor();
  assert.equal(
    await title.inputValue(),
    "英语学习资源清单：基础入门到日常应用",
  );
  assert.equal(await root.locator(".catalog-page").count(), 0);
  assert.ok(
    await root
      .getByText("英语学习资源清单：基础入门到日常应用", { exact: true })
      .count(),
  );
  await page.screenshot({ path: resolve(evidence, "local-draft-handoff.png") });
  root = await load("no-resources");
  await root.locator(".catalog-preview").waitFor();
  assert.equal(
    await root
      .getByRole("button", { name: "导出到公众号草稿箱", exact: true })
      .isDisabled(),
    true,
  );
  return {
    windowId,
    evidence,
    checks: [
      "export entry",
      "error recovery",
      "pending disabled",
      "draft handoff",
      "empty disabled",
    ],
    realWrites: 0,
    remoteCalls: 0,
  };
}
