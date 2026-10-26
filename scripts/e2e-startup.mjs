// Reuse the running npm run dev source service. Browser-only mock transport; no second Electron instance.
import { chromium } from "playwright-core";
import { fixture } from "../tests/helpers.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const url = process.env.PANXU_DEV_URL || "http://127.0.0.1:8070";
const identity = await fetch(`${url}/__panxu_dev`).then((r) => r.json());
assert.equal(identity.root, process.cwd());
const evidence = await mkdtemp(join(tmpdir(), "panxu-startup-"));
const test = await fixture();
const browser = await chromium.launch({
  headless: true,
  executablePath: join(
    process.env.HOME,
    "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ),
});
const errors = [],
  checks = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const firstPaint = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await firstPaint.route("**/src/main.tsx*", (route) => route.abort());
  await firstPaint.goto(url);
  await firstPaint.getByText("正在启动盘序…", { exact: true }).waitFor();
  assert.equal(
    await firstPaint
      .locator(".startup-art")
      .evaluate((el) => el.complete && el.naturalWidth > 0),
    true,
  );
  await firstPaint.screenshot({
    path: join(evidence, "startup-first-paint.png"),
  });
  await firstPaint.close();
  checks.push("React 加载前的首屏 HTML 已展示品牌与本地插图，避免空白首屏");
  const snapshot = test.app.snapshot();
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === url
      ? route.continue()
      : route.abort(),
  );
  await page.exposeFunction("startupSnapshot", () => snapshot);
  await page.addInitScript(() => {
    window.__startupMode = "hold";
    window.__startupRelease = [];
    window.panxu = {
      invoke: async (method) => {
        if (method === "snapshot") {
          if (window.__startupMode === "hold")
            await new Promise((resolve) =>
              window.__startupRelease.push(resolve),
            );
          if (window.__startupMode === "fail")
            throw Error("模拟本地读取失败，请重试。");
          return window.startupSnapshot();
        }
        if (method === "ai.modelCatalog") return { text: [], media: [] };
        if (method === "resource.page")
          return { items: [], total: 0, page: 1, pageSize: 25 };
        return null;
      },
      onChanged: () => () => {},
      onUpdateChanged: () => () => {},
    };
    localStorage.setItem("panxu-ui-v1", JSON.stringify({ page: "accounts" }));
  });
  await page.goto(url);
  await page.getByText("正在打开本地工作空间…", { exact: true }).waitFor();
  assert.equal(await page.locator(".app-shell").count(), 0);
  assert.equal(
    await page
      .locator(".startup-art")
      .evaluate((el) => el.complete && el.naturalWidth > 0),
    true,
  );
  await page.screenshot({ path: join(evidence, "startup-1440.png") });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: join(evidence, "startup-1366.png") });
  assert.equal(
    await page
      .locator(".startup-screen")
      .evaluate(
        (el) =>
          el.scrollWidth <= el.clientWidth &&
          el.scrollHeight <= el.clientHeight,
      ),
    true,
  );
  checks.push(
    "真实快照未返回时展示完整品牌启动页，本地插图正常加载，1440×900 与 1366×768 无溢出",
  );
  await page.evaluate(() => {
    window.__startupMode = "fail";
    window.__startupRelease.splice(0).forEach((resolve) => resolve());
  });
  await page.getByText("本地工作空间暂未打开", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "startup-error.png") });
  await page.evaluate(() => (window.__startupMode = "ready"));
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.locator(".accounts-page").waitFor();
  assert.equal(await page.locator(".startup-screen").count(), 0);
  const heading = page.locator(".page-heading h1");
  await heading.focus();
  assert.equal(
    await heading.evaluate((el) => getComputedStyle(el).outlineStyle),
    "none",
  );
  const nav = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "资源库", exact: true });
  await page.keyboard.press("Tab");
  await nav.focus();
  assert.notEqual(
    await nav.evaluate((el) => getComputedStyle(el).outlineStyle),
    "none",
  );
  await nav.press("Enter");
  await page.locator('main[data-page="library"] .page-heading h1').waitFor();
  assert.equal(
    await heading.evaluate((el) => getComputedStyle(el).outlineStyle),
    "none",
  );
  await page.screenshot({ path: join(evidence, "title-no-frame.png") });
  checks.push(
    "读取失败提供重试；数据就绪立即进入页面，无人工延迟；标题聚焦无外框，导航键盘焦点仍可见",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.getByText("正在打开本地工作空间…", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".startup-status svg")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
  await test.cleanup();
}
