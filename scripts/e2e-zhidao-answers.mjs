// Browser plugin not available. Reuse Vite with a browser-only bridge and a
// disposable application service; no second Electron desktop or real requests.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { AppService } from "../core/service.ts";
import { ServiceHttpError } from "../core/errors.ts";
import { TestProvider } from "../tests/helpers.ts";
import { navigateTo } from "./e2e-navigation.mjs";

const url = process.env.PANXU_DEV_URL || "http://127.0.0.1:8070";
assert.equal(
  (await fetch(`${url}/__panxu_dev`).then((r) => r.json())).root,
  process.cwd(),
);
const evidence = await mkdtemp(join(tmpdir(), "panxu-auto-answers-"));
const dataPath = await mkdtemp(join(tmpdir(), "panxu-auto-answers-data-"));
const events = [],
  errors = [],
  checks = [];
let failResponse = false,
  failRead = false;
let questionVersion = 0,
  rateLimited = false,
  generationGate = null,
  commandGate = null;
function deferCommand(method) {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  commandGate = { method, promise, release };
  return () => {
    release();
    commandGate = null;
  };
}
async function auditDialog(page, title, name) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.waitFor();
  const layout = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const footer = el.querySelector(".dialog-actions");
    const body = el.querySelector(".dialog-body");
    const checkbox = el.querySelector(".checkbox-field");
    return {
      inViewport:
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= innerWidth &&
        rect.bottom <= innerHeight,
      overflow: el.scrollWidth > el.clientWidth,
      footerVisible: footer.getBoundingClientRect().bottom <= innerHeight,
      gap: parseFloat(getComputedStyle(footer).gap),
      bodyScrollable: getComputedStyle(body).overflowY === "auto",
      checkboxGap: checkbox ? parseFloat(getComputedStyle(checkbox).gap) : null,
      checkboxWidth: checkbox?.querySelector("input").getBoundingClientRect()
        .width,
    };
  });
  assert.equal(layout.inViewport, true, title);
  assert.equal(layout.overflow, false, title);
  assert.equal(layout.footerVisible, true, title);
  assert.ok(layout.gap >= 8);
  assert.equal(layout.bodyScrollable, true);
  if (layout.checkboxGap != null) {
    assert.ok(layout.checkboxGap >= 8);
    assert.equal(layout.checkboxWidth, 16);
  }
  await page.screenshot({ path: join(evidence, `${name}.png`) });
  return dialog;
}
const provider = new TestProvider();
const session = {
  openQuestion: async (id, questionId) => {
    events.push({ type: "question-window", id, questionId });
  },
  login: async (id, page = "home") => {
    events.push({ type: "open", id, page });
  },
  clear: async () => {},
  close: async () => {},
  setCookie: async () => {},
  request: async (id, raw, init = {}) => {
    const target = new URL(raw);
    assert.equal(target.origin, "https://zhidao.baidu.com");
    events.push({ type: "request", id, path: target.pathname });
    let body;
    if (target.pathname === "/api/logininfo")
      body = {
        isLogin: "1",
        uid: "qa-owner",
        userName: "本机模拟答主",
        stoken: "qa-only-token",
      };
    else if (target.pathname === "/qa/api/bulkqa/userinfo")
      body = { code: 200, data: { hasPermission: false } };
    else if (target.pathname === "/qa/api/query/result/category")
      body = {
        code: 200,
        data: {
          list: [
            {
              qid: questionVersion
                ? `qa-extra-${questionVersion}`
                : failResponse
                  ? "qa-unknown"
                  : "qa-first",
              question: questionVersion
                ? `情感情境${questionVersion}：如何平等表达自己在关系中的需要？`
                : failResponse
                  ? "和伴侣沟通时总担心被误解，应该怎么办？"
                  : "在关系里总是我主动联系，如何表达自己的感受？",
              answered: false,
            },
          ],
          base: "8",
          hasMore: "0",
          total: 1,
        },
      };
    else if (target.pathname === "/msubmit/answer") {
      const sent = new URLSearchParams(String(init.body));
      assert.equal(sent.get("stoken"), "qa-only-token");
      assert.equal(sent.get("activity"), "21th");
      assert.ok(sent.get("content"));
      body = failResponse
        ? { errno: 0 }
        : { errno: 0, data: { aid: "qa-aid-confirmed" } };
    } else throw Error(`Mock did not declare ${target.pathname}`);
    return { status: 200, body: JSON.stringify(body) };
  },
};
const service = new AppService(
  dataPath,
  {
    available: () => true,
    encrypt: async (v) => Buffer.from(v).toString("base64"),
    decrypt: async (v) => Buffer.from(v, "base64").toString(),
  },
  Object.fromEntries(
    ["quark", "baidu", "uc", "xunlei", "guangya", "pikpak"].map((p) => [
      p,
      provider,
    ]),
  ),
  {
    zhidaoSession: session,
    openExternal: async () => {
      throw Error("QA does not open external pages");
    },
    saveFile: async () => null,
    login: async () => {},
    clearSession: async () => {},
    closeAccountWindow: async () => {},
    chooseDirectory: async () => null,
    readText: async () => null,
    activateDataPath: async () => {},
    normalizeCover: async (b) => b,
    openPath: async () => {},
    openAccountPage: async () => {},
    copyText: async () => {},
  },
  () => {},
);
service.queue.pump = async () => {};
const textModels = [
  {
    id: "test/copy",
    name: "本机模拟文案模型",
    structured: true,
    promptPrice: 0,
    completionPrice: 0,
  },
];
service.db.setSetting("modelCatalog", textModels);
service.ai.resourceExport = async (_name, _schema, _instructions, input) => {
  events.push({
    type: "generate",
    question: input.question,
    requirements: input.evidence.requirements,
    firstPerson: _instructions.includes("优先使用第一人称"),
  });
  if (generationGate) await generationGate.promise;
  if (rateLimited)
    throw new ServiceHttpError(
      429,
      "Provider returned error",
      "HTTP_ERROR",
      300_000,
    );
  return {
    answer:
      "我的理解是，你担心的不只是这次沟通，而是自己的需要能否被认真对待。我会建议，先用一句具体的话说清感受和期待，再给对方回应的空间。",
  };
};
const account = await service.invoke("zhidao.account.add", {
  alias: "学习资料运营账号（本机模拟）",
});
let browser;
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
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === url
      ? route.continue()
      : route.abort(),
  );
  await page.exposeFunction("invokeQa", async (method, args) => {
    if (method === "updater.state")
      return { phase: "idle", channel: "stable", autoCheck: false };
    if (method === "ai.modelCatalog") return { text: textModels, media: [] };
    if (method === "zhidao.accounts" && failRead)
      throw Error("模拟账号列表读取失败，请重试。");
    if (commandGate?.method === method) await commandGate.promise;
    return service.invoke(method, args);
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
        JSON.stringify({ page: "zhidao-accounts" }),
      );
  });
  await page.goto(url);
  await page.getByRole("heading", { name: "账号管理", exact: true }).waitFor();
  const card = page
    .locator(".website-account-row")
    .filter({ hasText: account.alias });
  await card.getByRole("button", { name: "登录 / 扫码", exact: true }).click();
  await card.getByRole("button", { name: "检查登录", exact: true }).click();
  await card.getByRole("button", { name: "自动答题", exact: true }).waitFor();
  assert.equal(
    events.some((e) => e.type === "generate"),
    false,
  );
  await card.getByRole("button", { name: "去获取资格", exact: true }).click();
  await page.getByRole("button", { name: "配置自动答题", exact: true }).click();
  await page.getByRole("tab", { name: "自动回答", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("spinbutton", { name: "目标回答数" }).inputValue(),
    "30",
  );
  assert.equal(
    await page.getByRole("spinbutton", { name: "提交间隔（秒）" }).inputValue(),
    "30",
  );
  const start = page.getByRole("button", { name: "开始自动回答", exact: true });
  const consent = page.getByRole("checkbox", {
    name: "我已核对账号与数量，授权本次 AI 生成和自动提交",
    exact: true,
  });
  await consent.check();
  assert.equal(await start.isEnabled(), false);
  await page
    .getByText("请先到连接与设置保存 OpenRouter API Key。", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "配置 AI 连接与模型", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "openrouter密钥", exact: true })
    .fill("qa-local-key");
  await page
    .locator("#settings-ai")
    .getByRole("button", { name: "保存Key", exact: true })
    .click();
  await page.getByText("已保存Key", { exact: true }).waitFor();
  await navigateTo(page, "智能问答");
  await consent.check();
  await page
    .getByText("请先到连接与设置选择文案创作模型，并点击“保存设置”。", {
      exact: true,
    })
    .waitFor();
  assert.equal(await start.isEnabled(), false);
  await page.screenshot({
    path: join(evidence, "answer-model-required.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "配置 AI 连接与模型", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "文案创作默认模型", exact: true })
    .fill("test/copy");
  await page.getByRole("option", { name: /本机模拟文案模型/ }).click();
  await page.screenshot({
    path: join(evidence, "settings-before-save.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText(/通用设置已保存。/).waitFor();
  await navigateTo(page, "智能问答");
  assert.equal(service.zhidao.store.list("answer").total, 0);
  assert.equal(
    events.filter(
      (e) =>
        e.type === "generate" || e.path === "/qa/api/query/result/category",
    ).length,
    0,
  );
  checks.push(
    "缺少Key或文案模型时阻止启动；从提示进入设置分别保存Key与模型，期间不取题、不生成",
  );
  assert.equal(await start.isEnabled(), false);
  await page.getByRole("spinbutton", { name: "目标回答数" }).fill("1");
  await page.getByRole("spinbutton", { name: "目标回答数" }).fill("201");
  await page.getByText("请输入1–200之间的整数。", { exact: true }).waitFor();
  assert.equal(await start.isEnabled(), false);
  await page.getByRole("spinbutton", { name: "目标回答数" }).fill("1");
  await page.getByRole("spinbutton", { name: "提交间隔（秒）" }).fill("17");
  await page
    .getByText("请输入18–600之间的整数秒数。", { exact: true })
    .waitFor();
  await page.getByRole("spinbutton", { name: "提交间隔（秒）" }).fill("30");
  await page
    .getByRole("textbox", { name: "补充回答要求（可选）" })
    .fill("先直接回答，再分步骤给建议，不虚构个人经历。");
  await consent.check();
  const style = page.getByRole("combobox", { name: "回答风格", exact: true });
  await style.click();
  await page.getByRole("option", { name: "共情陪伴", exact: true }).click();
  assert.equal(await consent.isChecked(), false);
  await page
    .getByText("先接住情绪，再陪对方理清感受，不急着评判。", { exact: true })
    .waitFor();
  await style.click();
  await page.getByRole("option", { name: "第一人称共鸣", exact: true }).click();
  await page
    .getByText("以“我的理解”“我会建议”表达共鸣，像平等交谈。", { exact: true })
    .waitFor();
  await consent.check();
  await page.getByRole("spinbutton", { name: "提交间隔（秒）" }).fill("45");
  assert.equal(await consent.isChecked(), false);
  await page.reload();
  await page
    .getByRole("button", { name: "开始自动回答", exact: true })
    .waitFor();
  assert.equal(await consent.isChecked(), false);
  assert.equal(
    await page.getByRole("spinbutton", { name: "目标回答数" }).inputValue(),
    "1",
  );
  assert.equal(
    await page.getByRole("spinbutton", { name: "提交间隔（秒）" }).inputValue(),
    "45",
  );
  assert.match(await style.innerText(), /第一人称共鸣/);
  await page.setViewportSize({ width: 1366, height: 768 });
  assert.equal(
    await start.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }),
    true,
    "主要开始操作在桌面首屏可达",
  );
  await page.screenshot({
    path: join(evidence, "answer-config-1366.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: join(evidence, "automatic-answer-1440.png"),
    fullPage: true,
  });
  checks.push(
    "账号登录检查、无发布资格仍可进入自动答题；配置恢复，授权不恢复且配置变化撤销授权",
    "情感风格切换与语气预览生效，第一人称风格刷新后恢复，1366桌面首屏可开始",
  );
  failRead = true;
  await page.reload();
  await page
    .getByText("模拟账号列表读取失败，请重试。", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "先连接百度知道账号", exact: true })
      .count(),
    0,
  );
  failRead = false;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.getByText("本机模拟答主", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "综合", exact: true }).focus();
  await page.keyboard.press("Space");
  assert.equal(
    await page.getByRole("checkbox", { name: "综合", exact: true }).isChecked(),
    true,
  );
  await page.keyboard.press("Space");
  checks.push("账号列表失败保留配置并提供单一重试入口，恢复后可用键盘选择题库");
  await page.getByRole("checkbox", { name: "情感", exact: true }).uncheck();
  await page.getByText("请至少选择一个答题分类。", { exact: true }).waitFor();
  assert.equal(await start.isEnabled(), false);
  await page.getByRole("checkbox", { name: "情感", exact: true }).check();
  await consent.check();
  await start.click();
  await page.getByText("回答ID：qa-aid-confirmed", { exact: true }).waitFor();
  assert.equal(events.filter((e) => e.path === "/msubmit/answer").length, 1);
  assert.equal(events.filter((e) => e.type === "generate").length, 1);
  assert.equal(events.find((e) => e.type === "generate").firstPerson, true);
  assert.ok(
    events
      .filter((e) => e.type === "request")
      .every((e) => e.id === account.id),
  );
  await page.screenshot({
    path: join(evidence, "answer-submitted.png"),
    fullPage: true,
  });
  checks.push(
    "真实应用服务与客户端经模拟会话取题、生成并提交一次，返回回答ID，保留来源与任务记录",
  );
  await consent.check();
  await start.click();
  await page.getByText(/本轮随机取题已结束/).waitFor();
  assert.equal(events.filter((e) => e.path === "/msubmit/answer").length, 1);
  assert.equal(events.filter((e) => e.type === "generate").length, 1);
  checks.push("同一历史问题在新任务中再次出现时，既不重新生成，也不重复提交");
  failResponse = true;
  await consent.check();
  await start.click();
  await page.getByRole("button", { name: "核对结果", exact: true }).waitFor();
  const before = events.filter((e) => e.path === "/msubmit/answer").length;
  await page.setViewportSize({ width: 1366, height: 768 });
  failRead = true;
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await page
    .getByText("模拟账号列表读取失败，请重试。", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "确认继续", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByText("账号暂未读取", { exact: true }).waitFor();
  await auditDialog(page, "继续答题任务", "resume-read-error-1366");
  failRead = false;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  let dialog = await auditDialog(page, "继续答题任务", "resume-1366");
  await dialog.getByText(account.alias, { exact: true }).waitFor();
  const resumeCheck = dialog.getByRole("checkbox", {
    name: "我已核对账号、任务内容和已提交结果",
    exact: true,
  });
  await resumeCheck.focus();
  await page.keyboard.press("Space");
  assert.equal(await resumeCheck.isChecked(), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page
      .getByRole("button", { name: "继续任务", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  dialog = await auditDialog(page, "继续答题任务", "resume-1440");
  assert.equal(await dialog.getByRole("checkbox").isChecked(), false);
  await page
    .getByRole("checkbox", { name: "我已核对账号、任务内容和已提交结果" })
    .check();
  await page.getByRole("button", { name: "确认继续", exact: true }).click();
  await page.getByText(/存在待核对回答/).waitFor();
  assert.equal(
    events.filter((e) => e.path === "/msubmit/answer").length,
    before,
  );
  await page.getByRole("button", { name: "核对结果", exact: true }).click();
  dialog = await auditDialog(page, "核对平台提交结果", "resolve-1440");
  assert.equal(
    await dialog
      .getByRole("button", { name: "登记已提交", exact: true })
      .isDisabled(),
    true,
  );
  const releaseOpen = deferCommand("zhidao.answer.open");
  await page.getByRole("button", { name: "打开百度知道", exact: true }).click();
  await dialog
    .getByRole("button", { name: "正在打开…", exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "取消", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  releaseOpen();
  await dialog
    .getByRole("button", { name: "打开百度知道", exact: true })
    .waitFor();
  assert.deepEqual(events.at(-1), {
    type: "question-window",
    id: account.id,
    questionId: "qa-unknown",
  });
  await page
    .getByRole("textbox", { name: "平台回答ID" })
    .fill("qa-manually-confirmed");
  await page.getByRole("button", { name: "登记已提交", exact: true }).click();
  await page
    .getByText("回答ID：qa-manually-confirmed", { exact: true })
    .waitFor();
  checks.push("成功回执缺少ID暂停，继续任务不重复提交，人工登记结果后保留ID");
  checks.push(
    "继续与核对弹窗：勾选间距、底部操作、键盘授权、关闭焦点恢复及请求中禁止取消均通过",
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({
    path: join(evidence, "automatic-answer-1366.png"),
    fullPage: true,
  });
  assert.equal(
    await page.locator("body").evaluate((el) => el.scrollWidth <= innerWidth),
    true,
  );
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  await page.getByRole("tab", { name: "手动回答", exact: true }).click();
  await page
    .getByRole("textbox", { name: "你的问题", exact: true })
    .fill("我总是担心表达自己的需要会给对方添麻烦，应该如何沟通？");
  const generatedBeforeManual = events.filter(
    (e) => e.type === "generate",
  ).length;
  const submitsBeforeManual = events.filter(
    (e) => e.path === "/msubmit/answer",
  ).length;
  await page.getByRole("button", { name: "生成回答", exact: true }).click();
  await page.getByText("已生成", { exact: true }).waitFor();
  assert.equal(
    events.filter((e) => e.type === "generate").length,
    generatedBeforeManual + 1,
  );
  assert.equal(
    events.filter((e) => e.path === "/msubmit/answer").length,
    submitsBeforeManual,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: join(evidence, "manual-answer-1440.png"),
    fullPage: true,
  });
  checks.push(
    "分类全空有明确恢复提示；手动模式保留情感风格且只生成，不自动提交",
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole("button", { name: /^编辑 / }).click();
  dialog = await auditDialog(page, "编辑问答", "edit-1366");
  const editedAnswer =
    "我会先整理自己的感受，再找平静的时机沟通。\n" +
    "可以先说出一个具体的期待，听听对方的想法。".repeat(50);
  await dialog.getByRole("textbox", { name: "回答内容" }).fill(editedAnswer);
  assert.equal(await dialog.getByRole("checkbox").isDisabled(), true);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: /^编辑 / }).click();
  dialog = page.getByRole("dialog", { name: "编辑问答", exact: true });
  assert.equal(
    await dialog.getByRole("textbox", { name: "回答内容" }).inputValue(),
    editedAnswer,
  );
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .locator(".operation-result-preview")
    .filter({ hasText: "我会先整理自己的感受" })
    .waitFor();
  await page.getByRole("button", { name: /^编辑 / }).click();
  dialog = page.getByRole("dialog", { name: "编辑问答", exact: true });
  const review = dialog.getByRole("checkbox");
  assert.equal(await review.isChecked(), false);
  await review.check();
  const releaseSave = deferCommand("zhidao.item.save");
  await dialog
    .getByRole("button", { name: "保存并确认审核", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "正在保存…", exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "取消", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  releaseSave();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /^移除 / }).click();
  dialog = await auditDialog(page, "移除本地结果", "remove-1366");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: /^移除 / }).click();
  await page.getByRole("button", { name: "确认移除", exact: true }).click();
  await page
    .getByRole("heading", { name: "当前结果列表为空", exact: true })
    .waitFor();
  checks.push(
    "编辑与移除弹窗：长文、固定底部、草稿恢复、审核不恢复、请求中关闭保护与移除后空态均通过",
  );

  failResponse = false;
  questionVersion = 1;
  let releaseGeneration;
  generationGate = {
    promise: new Promise((resolve) => {
      releaseGeneration = resolve;
    }),
  };
  await page.getByRole("tab", { name: "自动回答", exact: true }).click();
  await consent.check();
  await start.click();
  await page
    .getByRole("button", { name: "停止并保留结果", exact: true })
    .click();
  await page.getByRole("button", { name: "正在停止…", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "正在停止…", exact: true })
      .isDisabled(),
    true,
  );
  releaseGeneration();
  generationGate = null;
  await page.getByRole("button", { name: "继续任务", exact: true }).waitFor();
  const beforeResume = events.filter(
    (event) => event.type === "generate",
  ).length;
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "继续答题任务", exact: true });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "确认继续", exact: true }).click();
  await page.getByText("回答ID：qa-aid-confirmed", { exact: true }).waitFor();
  assert.equal(
    events.filter((event) => event.type === "generate").length,
    beforeResume,
  );
  questionVersion = 2;
  rateLimited = true;
  await consent.check();
  await start.click();
  await page.getByText(/模型服务持续限流（HTTP 429）/).waitFor();
  await page.screenshot({
    path: join(evidence, "rate-limit-paused-1366.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  dialog = await auditDialog(page, "继续答题任务", "rate-limit-resume-1366");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  checks.push(
    "真实应用服务模拟生成中停止、保存回答、继续不重生成，以及429暂停保留进度",
  );
  const publishTitle =
    "发布恢复检查：" + "长任务名称与多项结果等待人工核对。".repeat(10);
  const publishRun = service.zhidao.store.create(
    "publish",
    publishTitle,
    { accountId: account.id, itemIds: [] },
    20,
  );
  service.zhidao.store.state(
    publishRun.id,
    "paused",
    "本机模拟的恢复界面检查",
    2,
  );
  const generatedBeforePublish = events.filter(
    (event) => event.type === "generate",
  ).length;
  await navigateTo(page, "发布任务");
  await page
    .getByRole("combobox", { name: "选择历史运营任务", exact: true })
    .click();
  await page.getByRole("option").filter({ hasText: publishTitle }).click();
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  dialog = await auditDialog(page, "继续发布任务", "publish-resume-long-1366");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(
    events.filter((event) => event.type === "generate").length,
    generatedBeforePublish,
  );
  checks.push(
    "共享恢复弹窗覆盖发布任务与长任务名称，检查与取消不会触发模型或发布",
  );
  await navigateTo(page, "账号管理");
  await page.getByRole("tab", { name: "其他账号", exact: true }).click();
  await page.getByRole("button", { name: "自动答题", exact: true }).waitFor();
  await page.screenshot({
    path: join(evidence, "account-entry-1366.png"),
    fullPage: true,
  });
  checks.push(
    "1440×900、1366×768桌面界面、账号操作入口可达，无横向溢出及框架错误层",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, errors, events }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
} finally {
  commandGate?.release();
  await browser?.close();
  service.close();
  await rm(dataPath, { recursive: true, force: true });
}
