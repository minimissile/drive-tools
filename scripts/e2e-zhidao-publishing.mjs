// Browser plugin not available. Reuse the source Vite server with an isolated
// service and declared fake platform transport; never launch another Electron.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { publishingFixture } from "../tests/zhidao-publish-fixture.ts";
import { navigateTo } from "./e2e-navigation.mjs";
import { chooseOption } from "./e2e-select.mjs";

const url = process.env.PANXU_DEV_URL || "http://127.0.0.1:8070";
assert.equal(
  (await fetch(`${url}/__panxu_dev`).then((response) => response.json())).root,
  process.cwd(),
);
const evidence = await mkdtemp(join(tmpdir(), "panxu-publishing-"));
const f = await publishingFixture();
f.seed(3, false);
const errors = [],
  checks = [];
let failAccounts = false;
let browser, page;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PANXU_QA_BROWSER ||
      join(
        process.env.HOME,
        "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(15000);
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
    if (method === "zhidao.accounts" && failAccounts)
      throw Error("模拟账号列表读取失败，请重试。");
    return f.service.invoke(method, args);
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
        JSON.stringify({ page: "zhidao-publish" }),
      );
  });
  await page.goto(url);
  await page.getByRole("heading", { name: "发布任务", exact: true }).waitFor();
  await page.getByText("如何整理第1份学习资料？", { exact: true }).waitFor();
  const selection = page.getByRole("checkbox", {
    name: "选择本页结果",
    exact: true,
  });
  const start = page.getByRole("button", { name: "上传所选问答", exact: true });
  assert.equal(await selection.isDisabled(), true);
  assert.equal(await start.isDisabled(), true);
  await chooseOption(
    page.getByRole("combobox", { name: "发布账号", exact: true }),
    f.account.id,
  );
  await page.getByText("剩余额度 5,000 条", { exact: true }).waitFor();
  const name = page.getByRole("textbox", { name: "任务名称", exact: true });
  assert.equal(await name.getAttribute("maxlength"), "15");
  await name.fill("");
  await page
    .getByText("任务名称需填写1–15字，请修改后上传。", { exact: true })
    .waitFor();
  assert.equal(await start.isDisabled(), true);
  await name.fill("批量发布验收");
  const firstRow = page.getByRole("checkbox", {
    name: "选择 资料整理 1",
    exact: true,
  });
  assert.equal(await firstRow.isEnabled(), true);
  await firstRow.click();
  let reviewDialog = page.getByRole("dialog", {
    name: "审核并选择问答",
    exact: true,
  });
  const reviewCheck = reviewDialog.getByRole("checkbox", {
    name: "我已核对事实、链接与发布内容",
    exact: true,
  });
  assert.equal(await reviewCheck.isChecked(), false);
  await reviewDialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await firstRow.isChecked(), false);
  await firstRow.click();
  const title = reviewDialog.getByRole("textbox", {
    name: "问题标题",
    exact: true,
  });
  const answer = reviewDialog.getByRole("textbox", {
    name: "回答内容",
    exact: true,
  });
  const approve = reviewDialog.getByRole("button", {
    name: "审核并选中",
    exact: true,
  });
  await title.fill("问".repeat(50));
  await reviewDialog
    .getByText("标题当前50字，需缩短到49字以内，再确认审核。", { exact: true })
    .waitFor();
  assert.equal(await reviewCheck.isDisabled(), true);
  assert.equal(await approve.isDisabled(), true);
  await title.fill("如何整理学习资料，让以后更容易查找？");
  await answer.fill("");
  await reviewDialog
    .getByText("请先填写回答内容，再确认审核。", { exact: true })
    .waitFor();
  assert.equal(await reviewCheck.isDisabled(), true);
  await answer.fill(
    "我会先按主题分类，再用日期和版本命名。这样回头查资料时，我能少花一些时间，也方便清理重复文件。",
  );
  await reviewCheck.check();
  await answer.fill(`${await answer.inputValue()} 最后我会备份重要资料。`);
  assert.equal(await reviewCheck.isChecked(), false);
  assert.equal(await approve.isDisabled(), true);
  const approvedQuestion = await title.inputValue();
  const approvedAnswer = await answer.inputValue();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: join(evidence, "review-1366.png") });
  const approveRect = await approve.boundingBox();
  assert.ok(approveRect.y + approveRect.height < 768);
  await reviewCheck.check();
  await approve.click();
  await reviewDialog.waitFor({ state: "hidden" });
  assert.equal(await firstRow.isChecked(), true);
  assert.equal(
    (await f.invoke("zhidao.templates", { page: 1 })).items.find(
      (item) => item.name === "资料整理 1",
    ).reviewed,
    true,
  );
  await page.getByText("已选 1 / 100 条 · 跨页保留", { exact: true }).waitFor();
  for (let i = 2; i <= 3; i++) {
    if (i === 2) {
      const row = page.getByRole("checkbox", {
        name: `选择 资料整理 ${i}`,
        exact: true,
      });
      await row.focus();
      await page.keyboard.press("Space");
    } else {
      await page
        .getByRole("button", { name: `审核并选择 资料整理 ${i}`, exact: true })
        .click();
    }
    const dialog = page.getByRole("dialog", {
      name: "审核并选择问答",
      exact: true,
    });
    await dialog
      .getByRole("checkbox", {
        name: "我已核对事实、链接与发布内容",
        exact: true,
      })
      .check();
    await dialog
      .getByRole("button", { name: "审核并选中", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByRole("checkbox", { name: `选择 资料整理 ${i}`, exact: true })
        .isChecked(),
      true,
    );
  }
  await selection.check();
  const consent = page.getByRole("checkbox", {
    name: "我已审核所选3条问答，确认使用此账号真实上传",
    exact: true,
  });
  await consent.check();
  await navigateTo(page, "智能问答");
  await navigateTo(page, "发布任务");
  assert.equal(await name.inputValue(), "批量发布验收");
  assert.equal(await consent.isChecked(), false);
  await consent.check();
  await page.reload();
  await consent.waitFor();
  assert.equal(await consent.isChecked(), false);
  assert.equal(await name.inputValue(), "批量发布验收");
  await consent.check();
  await page.setViewportSize({ width: 1366, height: 768 });
  await start.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "ready-1366.png") });
  const startRect = await start.boundingBox();
  assert.ok(startRect.y + startRect.height < 768);
  checks.push(
    "点击待审核勾选框或文字按钮进入审核，支持键盘；取消不选中，标题超限与空回答明确提示，修改撤销确认，一次保存审核并自动选中；15字名称限制；切页与刷新恢复草稿、不恢复上传确认",
  );
  await start.click();
  await page.getByText(/已提交3\/3条问答；上传任务已创建/).waitFor();
  assert.equal(f.events.filter((event) => event.type === "upload").length, 1);
  const uploaded = f.events.find((event) => event.type === "upload");
  assert.equal(uploaded.rows.length, 4);
  assert.equal(uploaded.taskName, "批量发布验收");
  assert.ok(
    uploaded.rows.some(
      (row) => row[1] === approvedQuestion && row[2] === approvedAnswer,
    ),
  );
  await page.getByRole("button", { name: "查询平台审核", exact: true }).click();
  await page.getByText("待执行", { exact: true }).waitFor();
  f.state.taskStatus = 1;
  await page.getByRole("button", { name: "查询平台审核", exact: true }).click();
  await page.getByText("审核处理中", { exact: true }).waitFor();
  f.state.taskStatus = 2;
  f.state.successCount = 2;
  f.state.failCount = 1;
  await page.getByRole("button", { name: "查询平台审核", exact: true }).click();
  await page.getByText("审核完成", { exact: true }).waitFor();
  await page
    .getByText("通过 2 · 失败 1 · 使用额度 3", { exact: true })
    .waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("button", { name: "查询平台审核", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "audit-1440.png") });
  f.state.failTasks = true;
  await page.getByRole("button", { name: "查询平台审核", exact: true }).click();
  await page
    .getByRole("heading", { name: "平台审核记录暂时无法读取", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByText("通过 2 · 失败 1 · 使用额度 3", { exact: true })
      .isVisible(),
    true,
  );
  f.state.failTasks = false;
  await page
    .getByRole("button", { name: "打开答主工作台", exact: true })
    .click();
  assert.ok(
    f.events.some(
      (event) =>
        event.type === "open" &&
        event.accountId === f.account.id &&
        event.path === "quota",
    ),
  );
  await page.reload();
  await page.getByText("审核完成", { exact: true }).waitFor();
  checks.push(
    "多条合并一次XLSX上传、任务ID记录、待执行→审核中→审核完成；审核查询失败保留已读数据；官方入口绑定原账号；重载保留回执",
  );
  await page
    .getByRole("button", { name: "刷新资格与额度", exact: true })
    .click();
  await page.getByText("剩余额度 4,997 条", { exact: true }).waitFor();
  const extra = f.seed(2);
  f.state.mode = "unknown";
  for (const item of extra)
    await page
      .getByRole("checkbox", { name: `选择 ${item.name}`, exact: true })
      .check();
  const secondConsent = page.getByRole("checkbox", {
    name: "我已审核所选2条问答，确认使用此账号真实上传",
    exact: true,
  });
  await secondConsent.check();
  await start.click();
  await page
    .getByRole("button", { name: "核对结果", exact: true })
    .first()
    .waitFor();
  assert.equal(f.events.filter((event) => event.type === "upload").length, 2);
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "继续发布任务", exact: true });
  await dialog
    .getByRole("checkbox", {
      name: "我已核对账号、任务内容和已提交结果",
      exact: true,
    })
    .check();
  await dialog.getByRole("button", { name: "确认继续", exact: true }).click();
  await page.getByText(/上传结果未知，请先核对原平台任务/).waitFor();
  assert.equal(f.events.filter((event) => event.type === "upload").length, 2);
  await page
    .getByRole("button", { name: "核对结果", exact: true })
    .first()
    .click();
  dialog = page.getByRole("dialog", { name: "核对平台提交结果", exact: true });
  await dialog.getByText(/本批共2条问答/).waitFor();
  await dialog
    .getByRole("button", { name: "打开百度知道", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "上传任务ID", exact: true })
    .fill(f.accepted.at(-1).id);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: join(evidence, "unknown-batch-1366.png") });
  await dialog.getByRole("button", { name: "登记已提交", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText(/已登记2条问答的上传任务ID/).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "核对结果", exact: true }).count(),
    0,
  );
  assert.equal(f.events.filter((event) => event.type === "upload").length, 2);
  checks.push(
    "整批上传响应丢失：继续不重传；同账号打开官方页；登记一个ID同时确认本批两条问答",
  );
  const more = f.seed(26);
  await page.reload();
  await page
    .getByRole("checkbox", { name: `选择 ${more.at(-1).name}`, exact: true })
    .check();
  await page
    .getByRole("navigation", { name: "待发布问答分页", exact: true })
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: `选择 ${more[0].name}`, exact: true })
    .check();
  await page.getByText("已选 2 / 100 条 · 跨页保留", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await page.getByText("已选 0 / 100 条 · 跨页保留", { exact: true }).waitFor();
  failAccounts = true;
  await page.reload();
  await page
    .getByText("模拟账号列表读取失败，请重试。", { exact: true })
    .waitFor();
  assert.equal(await start.isDisabled(), true);
  await page.screenshot({
    path: join(evidence, "account-read-error-1366.png"),
  });
  failAccounts = false;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.getByText("剩余额度 4,997 条", { exact: true }).waitFor();
  checks.push("跨页选择与清空；账号读取错误仅一处提示、阻止上传、重试恢复");
  await page
    .getByRole("checkbox", { name: `选择 ${more.at(-1).name}`, exact: true })
    .check();
  f.state.rights.quota = 0;
  await page
    .getByRole("button", { name: "刷新资格与额度", exact: true })
    .click();
  await page
    .getByText("剩余额度0条，不足以上传所选1条问答。", { exact: true })
    .waitFor();
  assert.equal(await start.isDisabled(), true);
  await page.screenshot({ path: join(evidence, "quota-blocked-1366.png") });
  checks.push("额度不足时展示实际0额度，阻止确认及上传");
  const layout = await page.evaluate(() => ({
    title: document.title,
    blank: document.body.innerText.length < 100,
    overlay: !!document.querySelector("vite-error-overlay"),
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  assert.equal(layout.blank, false);
  assert.equal(layout.overlay, false);
  assert.equal(layout.overflow, false);
  assert.ok(layout.title.includes("盘序"));
  await page.evaluate(async () => {
    const previous = await import("/src/state.tsx?t=panxu-context-before");
    const next = await import("/src/state.tsx?t=panxu-context-after");
    const fixture = await import("/tests/context-probe.tsx");
    window.__releaseContextProbe = fixture.mountContextProbe(
      previous.AppProvider,
      next,
    );
  });
  await page
    .getByTestId("context-generation-probe")
    .filter({ hasText: f.dir })
    .waitFor();
  assert.equal(
    await page
      .getByTestId("context-generation-probe")
      .getAttribute("data-command"),
    "function",
  );
  assert.equal(
    await page
      .getByTestId("context-generation-probe")
      .getAttribute("data-navigation"),
    "zhidao-publish",
  );
  await page.evaluate(() => window.__releaseContextProbe());
  checks.push(
    "旧模块Provider与新模块消费者连接同一工作空间、导航与动作上下文，热更新后不再丢失AppProvider",
  );
  checks.push(
    "当前源码页面身份、非空、无框架错误层、1366×768与1440×900无横向溢出；无真实外网、AI或发布",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, errors, events: f.events }, null, 2),
  );
  console.log(JSON.stringify({ evidence, checks, errors }, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: join(evidence, "failure.png"), fullPage: true })
    .catch(() => {});
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify(
      {
        error: String(error),
        text: await page
          ?.locator("body")
          .innerText()
          .catch(() => ""),
        errors,
      },
      null,
      2,
    ),
  );
  console.error(`发布测试证据：${evidence}`);
  throw error;
} finally {
  await browser?.close();
  await f.cleanup();
}
