import { navigateTo } from "./e2e-navigation.mjs";
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// Browser plugin not available. Verify current Vite source in isolated Electron.
const require = createRequire(import.meta.url);
const evidence = await mkdtemp(join(tmpdir(), "panxu-ui-"));
console.log(`UI evidence: ${evidence}`);
const dataPath = join(evidence, "database");
await mkdir(dataPath);
const identity = await fetch("http://127.0.0.1:8070/__panxu_dev").then((r) =>
  r.json(),
);
assert.equal(identity.root, process.cwd());
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_URL: "http://127.0.0.1:8070",
  PANXU_DEV_ROOT: process.cwd(),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require("electron"),
  args: [join(process.cwd(), "dist-dev")],
  env,
  timeout: 45000,
});
const errors = [],
  checks = [];
let page;
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await app.evaluate(({ session }) => {
    globalThis.fetch = async () => {
      throw new Error("UI QA blocks external services");
    };
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({
        cancel:
          ["http:", "https:"].includes(url.protocol) &&
          url.origin !== "http://127.0.0.1:8070",
      });
    });
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  assert.equal(page.url(), "http://127.0.0.1:8070/");
  assert.match(await page.title(), /盘序/);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  checks.push("当前源码启动、非空首屏、无框架错误遮罩");
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1380, 900),
  );
  await nav("账号管理").click();
  const alias = "UI验收账号：测试很长的中文账号名称是否保持布局与键盘操作正常";
  await page.getByRole("textbox", { name: "新增账号别名" }).fill(alias);
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  const account = page
    .locator(".account-row")
    .filter({ has: page.getByRole("heading", { name: alias, exact: true }) });
  const manage = account.getByRole("button", { name: "管理", exact: true });
  await manage.click();
  const dialog = page.getByRole("dialog", { name: `管理 ${alias}` });
  await dialog.waitFor();
  await page.waitForFunction(
    () => !!document.activeElement?.closest('[role="dialog"]'),
  );
  assert.equal(
    await dialog.getByLabel("账号别名", { exact: true }).inputValue(),
    alias,
  );
  await dialog.getByRole("button", { name: "保存设置", exact: true }).focus();
  await page.keyboard.press("Tab");
  await page.waitForFunction(
    () => !!document.activeElement?.closest('[role="dialog"]'),
  );
  await page.keyboard.press("Shift+Tab");
  await page.waitForFunction(
    () => !!document.activeElement?.closest('[role="dialog"]'),
  );
  await page.screenshot({ path: join(evidence, "dialog-desktop.png") });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.activeElement?.textContent?.trim() === "管理",
  );
  checks.push(
    "统一弹窗：初始焦点、Tab/Shift+Tab 边界、Esc、关闭后焦点恢复、长标题",
  );
  await nav("流量发现").click();
  const words = page.getByRole("tab", { name: "找词与词池", exact: true });
  await words.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tab", { name: "找热点", selected: true }).waitFor();
  await page.keyboard.press("End");
  await page.getByRole("tab", { name: "本地知识库", selected: true }).waitFor();
  await page.keyboard.press("Home");
  await page.getByRole("tab", { name: "找词与词池", selected: true }).waitFor();
  assert.equal(
    await page
      .getByRole("tab")
      .evaluateAll((els) => els.filter((e) => e.tabIndex === 0).length),
    1,
  );
  await page.getByRole("textbox", { name: "手工词池名称" }).fill("UI回归词池");
  await page
    .getByRole("textbox", { name: "手工词池关键词" })
    .fill("组件复用，交互验收");
  await page.getByRole("button", { name: "保存手工词池", exact: true }).click();
  await page
    .locator(".pool-list strong")
    .filter({ hasText: "UI回归词池" })
    .waitFor();
  checks.push(
    "统一 Tabs：左右方向键、Home/End、单一 Tab 停靠点；手工词池本地保存",
  );
  await nav("搜索运营").click();
  await page.getByRole("tab", { name: "全部选题", exact: true }).click();
  assert.equal(await page.getByRole("tabpanel").count(), 1);
  await page
    .getByRole("button", { name: "新建选题", exact: true })
    .first()
    .click();
  const searchDialog = page.getByRole("dialog", { name: "新建搜索选题" });
  await searchDialog
    .getByLabel("目标关键词", { exact: true })
    .fill("可复用组件的交互验证");
  assert.equal(
    await searchDialog.getByLabel("目标关键词", { exact: true }).inputValue(),
    "可复用组件的交互验证",
  );
  await page.keyboard.press("Escape");
  await searchDialog.waitFor({ state: "detached" });
  checks.push("搜索视图语义与共用弹窗输入、退出");
  await navigateTo(page, "AI 资源导出");
  const input = page.getByRole("textbox", { name: "导出需求", exact: true });
  await input.fill("筛选英语教学资源，验证拆分后的输入恢复");
  await nav("连接与设置").click();
  await page.locator(".ai-purpose-card").first().waitFor();
  const light = await page.evaluate(() => ({
    background: getComputedStyle(document.documentElement).backgroundColor,
    text: getComputedStyle(document.documentElement).color,
  }));
  await page.emulateMedia({ colorScheme: "dark" });
  const darkSystem = await page.evaluate(() => ({
    background: getComputedStyle(document.documentElement).backgroundColor,
    text: getComputedStyle(document.documentElement).color,
  }));
  assert.deepEqual(darkSystem, light);
  assert.equal(
    await page
      .locator(".ai-purpose-card")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 255, 255)",
  );
  await page.getByLabel("比特接口地址").fill("http://127.0.0.1:9999");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.locator(".toast").filter({ hasText: "设置已保存" }).waitFor();
  await navigateTo(page, "AI 资源导出");
  assert.equal(
    await input.inputValue(),
    "筛选英语教学资源，验证拆分后的输入恢复",
  );
  checks.push("仅白色主题；设置保存；资源导出切页恢复；未调用任何生成接口");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1024, 768),
  );
  for (const name of [
    "资源库",
    "AI 资源导出",
    "搜索运营",
    "分享统计",
    "连接与设置",
  ]) {
    await navigateTo(page, name);
    await page.locator("h1").waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      name,
    );
    assert.ok(
      await page
        .locator("main")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
      name,
    );
  }
  await navigateTo(page, "AI 资源导出");
  await page.screenshot({ path: join(evidence, "export-white-1024.png") });
  checks.push("5 个页面的 1024px 布局无页面级横向溢出");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors, evidence, dataPath }, null, 2));
} catch (error) {
  console.error(
    "UI failure state:",
    await page
      ?.evaluate(() => ({
        focus: {
          tag: document.activeElement?.tagName,
          text: document.activeElement?.textContent?.trim().slice(0, 160),
        },
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map((el) =>
          el.outerHTML.slice(0, 1200),
        ),
        headings: [...document.querySelectorAll("h1")].map(
          (el) => el.textContent,
        ),
      }))
      .catch(() => null),
  );
  await page
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, errors, dataPath }, null, 2),
  );
  await app.close();
}
