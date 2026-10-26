// Browser plugin not available. Reuse the existing Vite source service; the
// browser bridge and CSDN editor run against temporary data and intercepted IO.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { csdnFixture } from "../tests/csdn-fixture.ts";
import { csdnEditorFixture } from "../tests/csdn-editor-fixture.ts";
import { CsdnBrowserEditor } from "../core/csdn/editor.ts";
import { navigateTo } from "./e2e-navigation.mjs";

const url = process.env.PANXU_DEV_URL || "http://127.0.0.1:8070";
assert.equal(
  (await fetch(`${url}/__panxu_dev`).then((r) => r.json())).root,
  process.cwd(),
);
const evidence = await mkdtemp(join(tmpdir(), "panxu-csdn-qa-"));
const f = await csdnFixture();
const errors = [],
  checks = [],
  submissions = [];
let browser,
  failRead = false,
  missingId = false;
try {
  await f.app.invoke("pool.save", {
    name: "本机模拟搜索需求",
    resourceId: f.saved.resourceId,
    keywords: [
      {
        id: "fixture-word",
        word: "Matplotlib 中文乱码",
        source: "测试数据",
        platform: "baidu",
        metrics: { index: 0 },
        intent: "排错",
        sourceUpdatedAt: null,
        fetchedAt: new Date().toISOString(),
      },
    ],
  });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PANXU_QA_BROWSER ||
      join(
        process.env.HOME,
        "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
  });
  const editorContext = await browser.newContext();
  await editorContext.addCookies([
    {
      name: "UserName",
      value: "qa_author",
      domain: ".csdn.net",
      path: "/",
      secure: true,
    },
  ]);
  await editorContext.route("**/*", async (route) => {
    const request = route.request(),
      target = new URL(request.url());
    if (target.origin === "https://editor.csdn.net")
      return route.fulfill({
        contentType: "text/html",
        body: csdnEditorFixture,
      });
    if (
      target.origin === "https://bizapi.csdn.net" &&
      target.pathname === "/blog-console-api/v3/mdeditor/saveArticle"
    ) {
      const headers = {
        "access-control-allow-origin": "https://editor.csdn.net",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST,OPTIONS",
      };
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      const payload = request.postDataJSON();
      submissions.push(payload);
      return route.fulfill({
        contentType: "application/json",
        headers,
        body: JSON.stringify({
          code: 200,
          data: missingId ? {} : { id: 123456789 },
        }),
      });
    }
    return route.abort();
  });
  const existing = await editorContext.newPage();
  await existing.goto(
    "https://editor.csdn.net/md/?articleId=existing-user-draft",
  );
  await existing.locator(".editor__inner").fill("已有用户草稿，不得覆盖");
  const editor = new CsdnBrowserEditor({
    withContext: async (_binding, action) => action(editorContext),
  });
  f.app.csdnEditor.prepare = (binding, payload) =>
    editor.prepare(binding, payload);
  f.app.csdnEditor.submit = (binding, payload, before) =>
    editor.submit(binding, payload, before);
  f.app.csdnEditor.inspect = (binding, key) => editor.inspect(binding, key);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === url
      ? route.continue()
      : route.abort(),
  );
  await page.exposeFunction("invokeQa", async (method, args) => {
    if (method === "updater.state")
      return { phase: "idle", channel: "stable", autoCheck: false };
    if (method === "ai.modelCatalog") return { text: [], media: [] };
    if (method === "csdn.words" && failRead)
      throw Error("模拟本地词库读取失败");
    return f.app.invoke(method, args);
  });
  await page.addInitScript(() => {
    window.panxu = {
      invoke: (method, args) => window.invokeQa(method, args),
      onChanged: () => () => {},
      onUpdateChanged: () => () => {},
    };
    if (!localStorage.getItem("panxu-ui-v1"))
      localStorage.setItem(
        "panxu-ui-v1",
        JSON.stringify({ page: "workbench" }),
      );
  });
  await page.goto(url);
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.screenshot({
    path: join(evidence, "workbench-entry.png"),
    fullPage: false,
  });
  await navigateTo(page, "CSDN 自动创作与发布");
  await page
    .getByRole("heading", { name: "CSDN 自动创作与发布", exact: true })
    .waitFor();
  assert.match(await page.title(), /盘序/);
  await page
    .getByRole("textbox", { name: "CSDN 目标关键词", exact: true })
    .fill("Matplotlib");
  await page.locator(".csdn-word-list button").first().click();
  await page
    .getByRole("button", { name: "展开CSDN 配套资料", exact: true })
    .click();
  await page
    .getByRole("option")
    .filter({ hasText: "Matplotlib 中文字体练习资料" })
    .click();
  await page
    .getByRole("textbox", { name: "CSDN 软件版本", exact: true })
    .fill("Matplotlib 3.x");
  await page
    .getByRole("textbox", { name: "CSDN 适用系统", exact: true })
    .fill("macOS；其他系统尚未验证");
  await page
    .getByRole("textbox", { name: "CSDN 教程依据", exact: true })
    .fill(
      "示例说明项目内注册字体的方法。资料含练习文件；仅核对字体注册步骤，示例未覆盖全部系统。",
    );
  await page.reload();
  assert.equal(
    await page
      .getByRole("textbox", { name: "CSDN 目标关键词", exact: true })
      .inputValue(),
    "Matplotlib 中文乱码",
  );
  assert.match(
    await page
      .getByRole("textbox", { name: "CSDN 教程依据", exact: true })
      .inputValue(),
    /项目内注册字体/,
  );
  failRead = true;
  await page.reload();
  await page.getByText("模拟本地词库读取失败", { exact: true }).waitFor();
  assert.match(
    await page
      .getByRole("textbox", { name: "CSDN 教程依据", exact: true })
      .inputValue(),
    /项目内注册字体/,
  );
  failRead = false;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.locator(".csdn-word-list button").first().waitFor();
  await page.screenshot({
    path: join(evidence, "setup-1440.png"),
    fullPage: true,
  });
  checks.push(
    "工作台入口、来源选词、自动匹配本人资料、配置刷新恢复及读取失败重试",
  );
  await page.getByRole("button", { name: "创建单篇任务", exact: true }).click();
  await page
    .getByRole("button", { name: "使用 AI 生成教程", exact: true })
    .click();
  await page.getByRole("textbox", { name: "内容标题", exact: true }).waitFor();
  const autoFill = page.getByRole("button", {
    name: "核验并自动填写",
    exact: true,
  });
  assert.equal(await autoFill.isEnabled(), false);
  await page
    .getByRole("textbox", { name: "内容正文", exact: true })
    .fill(
      (await page
        .getByRole("textbox", { name: "内容正文", exact: true })
        .inputValue()) + "\n\n人工补充：已核对字体资料许可与配套文件说明。",
    );
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("checkbox", { name: "已人工审阅", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="已人工审阅"]')?.checked ===
      true,
  );
  await page
    .getByRole("textbox", { name: "CSDN 用户名", exact: true })
    .fill("qa_author");
  await page
    .getByRole("checkbox", {
      name: "在已核实允许的正文位置附加本人分享与提取码",
      exact: true,
    })
    .check();
  await autoFill.click();
  await page
    .getByRole("button", { name: "提交当前文章到 CSDN", exact: true })
    .waitFor();
  const run = f.app.csdn.history()[0];
  assert.equal(run.stage, "ready", run.message);
  assert.equal(f.app.csdn.get(run.id).draft.version, 2);
  assert.equal(submissions.length, 0);
  assert.equal(
    await existing.locator(".editor__inner").innerText(),
    "已有用户草稿，不得覆盖",
  );
  const taskPage = (
    await Promise.all(
      editorContext.pages().map(async (p) => ({
        page: p,
        name: await p.evaluate(() => window.name),
      })),
    )
  ).find((item) => item.name === run.prepared.pageKey).page;
  assert.match(await taskPage.locator(".editor__inner").innerText(), /own123/);
  assert.equal(
    await taskPage.locator(".creation-statement-select input").inputValue(),
    "部分内容由AI辅助生成",
  );
  assert.equal(await taskPage.locator(".gitcode-box input").isChecked(), false);
  checks.push(
    "真实 IPC、文案生成与费用台账、v2 保存审阅、官方编辑器适配自动填写且保留其他草稿",
  );
  const consent = page.getByRole("checkbox", {
    name: "我已核对当前文章、账号和资源入口，授权本次提交",
    exact: true,
  });
  await consent.check();
  await page.reload();
  assert.equal(await consent.isChecked(), false);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page
    .getByRole("button", { name: "提交当前文章到 CSDN", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "ready-1366.png"),
    fullPage: false,
  });
  await consent.check();
  await page
    .getByRole("button", { name: "提交当前文章到 CSDN", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "发布回执与结果核对", exact: true })
    .waitFor();
  assert.equal(submissions.length, 1);
  assert.equal(f.app.csdn.get(run.id).run.stage, "submitted");
  await page
    .getByRole("checkbox", {
      name: "我已在 CSDN 核对本次提交结果",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "确认文章已公开", exact: true })
    .click();
  await page
    .getByText("文章已确认公开。资料是否可获取，请继续在发布记录中验收。", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({
    path: join(evidence, "receipt-1366.png"),
    fullPage: true,
  });
  checks.push(
    "提交授权刷新不恢复，实际发布点击一次，回执自动记录待审核，人工确认公开同步原发布记录",
  );

  // Exercise pre-click identity/content guards through the real adapter.
  const second = await f.ready("Matplotlib 项目内加载字体");
  assert.equal(second.run.stage, "ready", second.run.message);
  const secondPage = (
    await Promise.all(
      editorContext.pages().map(async (p) => ({
        page: p,
        name: await p.evaluate(() => window.name),
      })),
    )
  ).find((item) => item.name === second.run.prepared.pageKey).page;
  await secondPage.locator(".editor__inner").fill("平台侧发生了另一份编辑");
  const changed = await f.app.invoke("csdn.submit", {
    id: second.run.id,
    confirmed: true,
  });
  assert.equal(changed.run.stage, "attention");
  assert.equal(submissions.length, 1);
  const original =
    f.app.csdn.get(second.run.id).draft.body +
    `\n\n资源链接：${f.provider.ownUrl}\n提取码：test`;
  await secondPage.locator(".editor__inner").fill(original);
  await f.app.invoke("csdn.prepare", { id: second.run.id });
  await editorContext.addCookies([
    {
      name: "UserName",
      value: "wrong_author",
      domain: ".csdn.net",
      path: "/",
      secure: true,
    },
  ]);
  const wrong = await f.app.invoke("csdn.submit", {
    id: second.run.id,
    confirmed: true,
  });
  assert.equal(wrong.run.stage, "attention");
  assert.equal(submissions.length, 1);
  await editorContext.addCookies([
    {
      name: "UserName",
      value: "qa_author",
      domain: ".csdn.net",
      path: "/",
      secure: true,
    },
  ]);
  await f.app.invoke("csdn.prepare", { id: second.run.id });
  missingId = true;
  const unknown = await f.app.invoke("csdn.submit", {
    id: second.run.id,
    confirmed: true,
  });
  assert.equal(unknown.run.stage, "uncertain");
  await assert.rejects(
    f.app.invoke("csdn.submit", { id: second.run.id, confirmed: true }),
    { code: "CSDN_PREPARE_REQUIRED" },
  );
  assert.equal(submissions.length, 2);
  await page
    .getByRole("navigation", { name: "CSDN 单篇任务", exact: true })
    .getByRole("button")
    .filter({ hasText: "Matplotlib 项目内加载字体" })
    .click();
  await page
    .getByRole("heading", { name: "发布回执与结果核对", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "uncertain-1366.png"),
    fullPage: false,
  });
  checks.push(
    "平台侧内容变化和账号变化均在点击前阻止；成功响应缺少ID进入待核对且不重发",
  );
  assert.equal(
    await page
      .locator("body")
      .evaluate((body) => body.scrollWidth <= innerWidth),
    true,
  );
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify(
      { url, viewports: ["1440x900", "1366x768"], checks, errors, submissions },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
} finally {
  await browser?.close();
  await f.cleanup();
}
