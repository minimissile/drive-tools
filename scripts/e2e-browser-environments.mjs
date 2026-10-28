// Browser plugin not available. Reuse the current Vite source service with a
// disposable database, simulated platform pages and blocked external requests.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { fixture } from "../tests/helpers.ts";
import { weiboBrowserFixture } from "../tests/weibo-browser-fixture.ts";
import { chooseOption } from "./e2e-select.mjs";
import { Database } from "../core/database.ts";
import { BrowserEnvironmentQueue } from "../core/browser-environment-queue.ts";
import { BrowserEnvironments } from "../core/browser-environments.ts";
import { SecretStore } from "../core/secrets.ts";
import { inspectBackup, stageRestore } from "../core/backups.ts";
import { createHash } from "node:crypto";

const url = "http://127.0.0.1:8070";
assert.equal(
  (await fetch(`${url}/__panxu_dev`).then((r) => r.json())).root,
  process.cwd(),
);
const evidence = await mkdtemp(join(tmpdir(), "panxu-environments-e2e-"));
const screenshots = join(
  process.cwd(),
  ".impeccable/review/browser-environments",
);
await mkdir(screenshots, { recursive: true });
const f = await fixture();
const originalFetch = globalThis.fetch;
let browser,
  page,
  clearCalls = 0,
  submitCalls = 0,
  proxyFailure = false,
  duplicateIp = false,
  failRead = false,
  environmentReadMode = "normal",
  releaseEnvironmentRead;
const errors = [],
  checks = [],
  preparedEnvironments = [],
  identities = new Map();
const nativeState = (a) => ({
  hasSession: true,
  uid:
    identities.get(
      f.app.environments.forAccount({ kind: "website", id: a.id }).id,
    )?.[a.provider] ?? (a.provider === "weibo" ? "2234567890" : "34567"),
  nickname: a.alias,
  checkedAt: new Date().toISOString(),
  windowOpen: false,
  error: null,
});
f.ports.websiteSessions = {
  isOpen: () => false,
  login: async () => {},
  clear: async () => {
    clearCalls++;
  },
  invalidate: async () => {},
  status: async (a) => nativeState(a),
  verify: async (a) => nativeState(a),
  open: async () => {},
  openPost: async () => {},
};
f.ports.weiboPublisher = {
  prepare: async (_a, payload) => ({
    uid: payload.uid,
    imageCount: payload.images.length,
    visibility: payload.visibility,
  }),
  submit: async (_a, payload, before) => {
    await before();
    submitCalls++;
    return {
      status: "submitted",
      url: `https://weibo.com/${payload.uid}/Local99`,
      postId: "Local99",
    };
  },
};
f.ports.browserEnvironments = {
  prepare: async (env) => {
    preparedEnvironments.push(env.id);
  },
  assertIdle: async () => {},
  checkNetwork: async (env) => {
    if (proxyFailure) throw Error("模拟代理连接失败");
    return duplicateIp
      ? "203.0.113.10"
      : env.name.includes("二")
        ? "203.0.113.11"
        : "203.0.113.10";
  },
};
f.ports.zhidaoSession = {
  login: async () => {},
  clear: async () => {
    clearCalls++;
  },
  close: async () => {},
  setCookie: async () => {},
  request: async (_id, target) => ({
    status: 200,
    body: JSON.stringify(
      new URL(target).pathname === "/api/logininfo"
        ? {
            isLogin: true,
            userId: "baidu-user-77",
            userName: "模拟知道",
            stoken: "local-only",
          }
        : {
            code: 0,
            data: {
              hasPermission: false,
              isBanned: false,
              quota: 0,
              usedQuota: 0,
            },
          },
    ),
  }),
};
globalThis.fetch = async () => {
  throw Error("E2E blocks real remote HTTP and paid APIs");
};
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
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
    if (method === "environments.list" && failRead)
      throw Error("模拟环境读取失败，请重试");
    if (method === "environments.list" && environmentReadMode === "empty")
      return [];
    if (method === "environments.list" && environmentReadMode === "hold")
      await new Promise((resolve) => {
        releaseEnvironmentRead = resolve;
      });
    return f.app.invoke(method, args);
  });
  await page.addInitScript(() => {
    window.panxu = {
      invoke: (method, args) => window.invokeQa(method, args),
      onChanged: () => () => {},
      onUpdateChanged: () => () => {},
    };
    localStorage.setItem(
      "panxu-ui-v1",
      JSON.stringify({ page: "browser-environments" }),
    );
  });
  await page.goto(url);
  await page
    .getByRole("heading", { name: "指纹浏览器", exact: true })
    .waitFor();
  const newEnvironment = async (name) => {
    await page.getByRole("button", { name: "新建环境", exact: true }).click();
    await page
      .getByRole("textbox", { name: "环境名称", exact: true })
      .fill(name);
    await chooseOption(
      page.getByRole("combobox", { name: "浏览器引擎", exact: true }),
      "electron",
    );
    await page
      .getByRole("checkbox", { name: "要求独立代理出口", exact: true })
      .uncheck();
    await page.getByRole("button", { name: "保存环境", exact: true }).click();
    await page.locator(".environment-row").filter({ hasText: name }).waitFor();
    return f.app.environments.list().find((e) => e.name === name);
  };
  const envA = await newEnvironment("跨平台运营 A"),
    envB = await newEnvironment("跨平台运营 B · 长名称用于桌面布局验收");
  checks.push("通过实际 UI 创建环境，表单与列表刷新正常");
  await page.getByRole("tab", { name: "其他账号", exact: true }).click();
  const addWebsite = async (provider, alias) => {
    await chooseOption(
      page.getByRole("combobox", { name: "其他账号平台", exact: true }),
      provider,
    );
    await page
      .getByRole("textbox", { name: "账号备注（可选）", exact: true })
      .fill(alias);
    await chooseOption(
      page.getByRole("combobox", { name: "账号浏览器环境", exact: true }),
      envA.id,
    );
    await page.getByRole("button", { name: "登录新账号", exact: true }).click();
    const row = page.locator(".website-account-row").filter({ hasText: alias });
    await row.waitFor();
    await row.getByRole("button", { name: "检查登录", exact: true }).click();
    await row.getByText("已识别会话", { exact: true }).waitFor();
    return (await f.app.websiteAccounts.list()).find((a) => a.alias === alias);
  };
  const weibo = await addWebsite("weibo", "微博运营 A"),
    marketing = await addWebsite("baidu-marketing", "百度营销 A");
  const zhidao = await f.app.invoke("zhidao.account.add", {
    alias: "百度知道 A",
    environmentId: envA.id,
  });
  await f.app.invoke("zhidao.account.check", { id: zhidao.id });
  assert.equal(
    f.app.environments.list().find((e) => e.id === envA.id).accounts.length,
    3,
  );
  assert.equal(
    f.app.environments.link({ kind: "website", id: marketing.id }).identityId,
    f.app.environments.link({ kind: "zhidao", id: zhidao.id }).identityId,
  );
  checks.push(
    "微博、百度营销和知道共用同一环境，百度业务共享登录身份但权益独立",
  );
  const beforeCount = (await f.app.websiteAccounts.list()).length;
  await assert.rejects(
    f.app.invoke("websiteAccounts.add", {
      provider: "weibo",
      environmentId: envA.id,
    }),
    /已关联该平台/,
  );
  assert.equal((await f.app.websiteAccounts.list()).length, beforeCount);
  checks.push("同环境同平台重复身份被阻止，失败不会留下半条账号记录");
  await page.getByRole("button", { name: "指纹浏览器", exact: true }).click();
  await page
    .locator(".environment-row")
    .filter({ hasText: "跨平台运营 A" })
    .getByText("百度知道 A", { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(screenshots, "environments-1440.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "其他账号", exact: true }).click();
  const marketingRow = page
    .locator(".website-account-row")
    .filter({ hasText: "百度营销 A" });
  await marketingRow.getByRole("button", { name: "移除", exact: true }).click();
  await page
    .getByRole("dialog", { name: "移除其他账号" })
    .getByRole("button", { name: "确认移除", exact: true })
    .click();
  await marketingRow.waitFor({ state: "hidden" });
  assert.equal(clearCalls, 0);
  assert.equal(
    f.app.environments.forAccount({ kind: "website", id: weibo.id }).id,
    envA.id,
  );
  assert.equal(
    f.app.environments.forAccount({ kind: "zhidao", id: zhidao.id }).id,
    envA.id,
  );
  checks.push("通过实际 UI 移除一个平台账号，其他账号、环境与会话均保留");
  const second = await f.app.invoke("websiteAccounts.add", {
    provider: "weibo",
    alias: "微博运营 B",
    environmentId: envB.id,
  });
  identities.set(envB.id, { weibo: "3234567890" });
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve));
  const holding = f.app.environments.run(
    { kind: "website", id: weibo.id },
    async () => {
      entered();
      await gate;
    },
  );
  await started;
  await assert.rejects(
    f.app.invoke("zhidao.account.check", { id: zhidao.id }),
    /环境正在执行其他平台操作/,
  );
  await assert.rejects(
    f.app.invoke("environments.bind", {
      kind: "website",
      id: weibo.id,
      environmentId: envB.id,
      confirmed: true,
    }),
    /正在操作/,
  );
  await f.app.invoke("websiteAccounts.check", { id: second.id });
  release();
  await holding;
  checks.push("同环境跨平台互斥、配置迁移互斥，不同环境可以并发操作");
  let releaseQueue, queueEntered;
  const queueGate = new Promise((resolve) => (releaseQueue = resolve)),
    queueReady = new Promise((resolve) => (queueEntered = resolve));
  const blocker = f.app.environments.run(
    { kind: "website", id: weibo.id },
    async () => {
      queueEntered();
      await queueGate;
    },
  );
  await queueReady;
  let cancelledExecuted = false;
  const cancelled = f.app.environmentQueue.schedule(
    [{ kind: "zhidao", id: zhidao.id }],
    "取消验证",
    async () => {
      cancelledExecuted = true;
    },
  );
  const cancellation = assert.rejects(cancelled, /已取消排队/);
  const waiting = f.app.environmentQueue
    .list()
    .find((job) => job.label === "取消验证");
  assert.equal(waiting.status, "queued");
  await f.app.invoke("environments.cancelJob", { id: waiting.id });
  await cancellation;
  assert.equal(cancelledExecuted, false);
  let serialExecuted = false;
  const serial = f.app.environmentQueue.schedule(
    [{ kind: "zhidao", id: zhidao.id }],
    "串行验证",
    async () => {
      serialExecuted = true;
    },
  );
  await f.app.environmentQueue.schedule(
    [{ kind: "website", id: second.id }],
    "跨环境验证",
    async () => {},
  );
  assert.equal(serialExecuted, false);
  releaseQueue();
  await blocker;
  await serial;
  assert.equal(serialExecuted, true);
  const third = await f.app.invoke("websiteAccounts.add", {
    provider: "baidu-marketing",
    alias: "并发上限验证",
  });
  let releaseParallel;
  const parallelGate = new Promise((resolve) => (releaseParallel = resolve));
  let parallel = 0,
    maximum = 0;
  const startedParallel = [];
  const scheduled = [
    { kind: "website", id: weibo.id },
    { kind: "website", id: second.id },
    { kind: "website", id: third.id },
  ].map((ref) =>
    f.app.environmentQueue.schedule([ref], "并发上限", async () => {
      parallel++;
      maximum = Math.max(maximum, parallel);
      startedParallel.push(ref.id);
      await parallelGate;
      parallel--;
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(startedParallel.length, 2);
  assert.equal(
    f.app.environmentQueue.list().filter((job) => job.status === "queued")
      .length,
    1,
  );
  releaseParallel();
  await Promise.all(scheduled);
  assert.equal(maximum, 2);
  checks.push("环境队列按环境串行、全局最多两项并发，取消排队不会执行平台操作");
  const draft = await f.app.invoke("weiboPosts.save", {
    accountId: weibo.id,
    text: "环境重绑定保护的本地模拟文案",
    visibility: "self",
  });
  await f.app.invoke("weiboPosts.fill", { id: draft.id, confirmed: true });
  await f.app.invoke("websiteAccounts.remove", {
    id: second.id,
    confirmed: true,
  });
  identities.set(envB.id, { weibo: "2234567890" });
  await page.getByRole("tab", { name: "其他账号", exact: true }).click();
  await page
    .locator(".website-account-row")
    .filter({ hasText: "微博运营 A" })
    .getByRole("button", { name: "环境", exact: true })
    .click();
  await chooseOption(
    page.getByRole("combobox", { name: "目标浏览器环境", exact: true }),
    envB.id,
  );
  await page
    .getByRole("dialog", { name: "关联浏览器环境" })
    .getByRole("button", { name: "确认关联", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "关联浏览器环境" })
    .waitFor({ state: "hidden" });
  assert.equal(
    f.app.environments.forAccount({ kind: "website", id: weibo.id }).id,
    envB.id,
  );
  const blocked = await f.app.invoke("weiboPosts.submit", {
    id: draft.id,
    confirmed: true,
  });
  assert.match(blocked.message, /环境或登录身份已变化/);
  assert.equal(submitCalls, 0);
  checks.push("准备后的账号重绑定使旧任务失效，即使 UID 相同也不会提交");
  const proxyOne = await f.app.invoke("environments.save", {
    name: "独立代理一",
    engine: "electron",
    proxy: { mode: "http", host: "127.0.0.1", port: 18080 },
    proxyUsername: "local-user",
    proxyPassword: "local-password",
    requireProxy: true,
  });
  const proxyTwo = await f.app.invoke("environments.save", {
    name: "独立代理二",
    engine: "electron",
    proxy: { mode: "http", host: "127.0.0.1", port: 18081 },
    requireProxy: true,
  });
  await f.app.invoke("environments.checkNetwork", { id: proxyOne.id });
  duplicateIp = true;
  await assert.rejects(
    f.app.invoke("environments.checkNetwork", { id: proxyTwo.id }),
    /相同出口 IP/,
  );
  duplicateIp = false;
  await f.app.invoke("environments.checkNetwork", { id: proxyTwo.id });
  proxyFailure = true;
  await assert.rejects(
    f.app.invoke("environments.checkNetwork", { id: proxyOne.id }),
    /模拟代理连接失败/,
  );
  proxyFailure = false;
  assert.equal(
    JSON.stringify(f.app.environments.list()).includes("local-password"),
    false,
  );
  assert.equal(
    JSON.stringify(f.app.environments.list()).includes("local-user"),
    false,
  );
  checks.push("独立出口重复与代理失败被阻止；列表不暴露加密代理凭据");
  let signature = "fingerprint-v1";
  const bitContext = await browser.newContext();
  await bitContext.route("**/*", async (route) => {
    const request = route.request(),
      u = new URL(request.url());
    if (
      u.origin === "https://weibo.com" &&
      u.pathname === "/ajax/statuses/update"
    ) {
      submitCalls++;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: 1,
          data: { mblogid: "Local88", user: { idstr: "1234567890" } },
        }),
      });
    }
    if (
      u.origin === "https://zhidao.baidu.com" &&
      u.pathname === "/api/logininfo"
    )
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          isLogin: true,
          userId: "bit-baidu-user",
          userName: "模拟指纹知道",
          stoken: "local-only",
        }),
      });
    if (
      u.origin === "https://zhidao.baidu.com" &&
      u.pathname === "/qa/api/bulkqa/userinfo"
    )
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          code: 0,
          data: {
            hasPermission: false,
            isBanned: false,
            quota: 0,
            usedQuota: 0,
          },
        }),
      });
    if (u.origin === "https://zhidao.baidu.com")
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><meta charset=utf-8><title>本地模拟知道</title>模拟平台",
      });
    if (u.origin === "https://weibo.com")
      return route.fulfill({
        contentType: "text/html",
        body: weiboBrowserFixture,
      });
    return route.abort();
  });
  f.app.bit.environmentConfiguration = async () => ({
    signature,
    proxy: "direct",
    stopWhileNetError: false,
  });
  f.app.bit.assertProfileIdle = async () => {};
  f.app.bit.withProfile = async (_id, action) => action(bitContext);
  const bitEnv = await f.app.invoke("environments.save", {
    name: "模拟指纹环境",
    engine: "bitbrowser",
    profileId: "fixture-profile-001",
    requireProxy: false,
  });
  await f.app.invoke("binding.save", {
    platform: "csdn",
    alias: "CSDN 共用环境账号",
    windowId: bitEnv.profileId,
    editorUrl: "https://editor.csdn.net/md/",
    linkPermission: "none",
    ruleNote: "",
    confirmCapabilities: false,
    capabilities: { formats: [], linkPositions: [] },
  });
  const bitAccount = await f.app.invoke("websiteAccounts.add", {
    provider: "weibo",
    alias: "指纹微博",
    environmentId: bitEnv.id,
  });
  await f.app.invoke("websiteAccounts.check", { id: bitAccount.id });
  const post = await f.app.invoke("weiboPosts.save", {
    accountId: bitAccount.id,
    text: "本地浏览器完整提交与回执验证",
    visibility: "self",
  });
  f.ports.readWeiboImages = async () => [
    {
      name: "fixture.png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9U8AAAAASUVORK5CYII=",
        "base64",
      ),
    },
  ];
  await f.app.invoke("weiboPosts.images", { id: post.id });
  const filledPost = await f.app.invoke("weiboPosts.fill", {
    id: post.id,
    confirmed: true,
  });
  assert.equal(filledPost.stage, "filled", filledPost.message);
  const submitted = await f.app.invoke("weiboPosts.submit", {
    id: post.id,
    confirmed: true,
  });
  assert.equal(submitted.stage, "submitted");
  assert.match(submitted.url, /1234567890\/Local88$/);
  assert.equal(submitCalls, 1);
  const next = await f.app.invoke("weiboPosts.save", {
    accountId: bitAccount.id,
    text: "指纹配置变化后的旧任务保护",
    visibility: "self",
  });
  const filledNext = await f.app.invoke("weiboPosts.fill", {
    id: next.id,
    confirmed: true,
  });
  assert.equal(filledNext.stage, "filled", filledNext.message);
  signature = "fingerprint-v2";
  assert.match(
    (await f.app.invoke("weiboPosts.submit", { id: next.id, confirmed: true }))
      .message,
    /环境或登录身份已变化/,
  );
  assert.equal(submitCalls, 1);
  checks.push(
    "指纹环境真实浏览器模拟页面：核验、填写、提交、CDP 回执保存完整通过；指纹配置变化阻止旧任务提交",
  );
  const bitZhidao = await f.app.invoke("zhidao.account.add", {
    alias: "指纹环境知道",
    environmentId: bitEnv.id,
  });
  const bitZhidaoChecked = await f.app.invoke("zhidao.account.check", {
    id: bitZhidao.id,
  });
  assert.equal(bitZhidaoChecked.uid, "bit-baidu-user");
  assert.equal(
    f.app.environments.forAccount({ kind: "zhidao", id: bitZhidao.id }).id,
    bitEnv.id,
  );
  assert.ok(
    bitContext
      .pages()
      .some((page) => page.url().startsWith("https://weibo.com/")),
  );
  assert.ok(
    bitContext
      .pages()
      .some((page) => page.url().startsWith("https://zhidao.baidu.com/")),
  );
  checks.push(
    "同一指纹浏览器上下文同时保留微博和知道页面，知道请求在浏览器内执行",
  );
  await f.app.invoke("websiteAccounts.login", { id: bitAccount.id });
  assert.equal(
    f.app.environments.identityCurrent({ kind: "website", id: bitAccount.id }),
    false,
  );
  checks.push("重新登录会使该登录体系的核验结果失效");
  await page.getByRole("button", { name: "指纹浏览器", exact: true }).click();
  await page
    .locator(".environment-row")
    .filter({ hasText: "模拟指纹环境" })
    .waitFor();
  if (await page.getByRole("button", { name: "关闭提示", exact: true }).count())
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await page.locator(".main-content").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: join(screenshots, "environments-populated-1440.png"),
    fullPage: true,
  });
  const topEnvironment = page
    .locator(".environment-row")
    .filter({ hasText: "跨平台运营 A" });
  const editTrigger = topEnvironment.getByRole("button", {
    name: "编辑",
    exact: true,
  });
  await editTrigger.click();
  const environmentName = page.getByRole("textbox", {
    name: "环境名称",
    exact: true,
  });
  assert.equal(
    await environmentName.evaluate((el) => document.activeElement === el),
    true,
  );
  assert.ok(
    await environmentName.evaluate(
      (el) =>
        el.getBoundingClientRect().top >= 0 &&
        el.getBoundingClientRect().bottom <= innerHeight,
    ),
  );
  await page.screenshot({
    path: join(screenshots, "environment-edit-1440.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.activeElement?.matches("button") &&
      document.activeElement.textContent?.trim() === "编辑",
  );
  assert.ok(
    await editTrigger.evaluate(
      (el) =>
        el.getBoundingClientRect().top >= 0 &&
        el.getBoundingClientRect().bottom <= innerHeight,
    ),
  );
  await topEnvironment
    .getByRole("button", { name: "关联账号", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("combobox", { name: "账号浏览器环境", exact: true })
      .getAttribute("data-value"),
    envA.id,
  );
  await page.getByText(/新账号将关联到“跨平台运营 A”/).waitFor();
  await page
    .locator(".website-account-row")
    .filter({ hasText: "微博运营 A" })
    .getByRole("button", { name: "环境", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("combobox", { name: "目标浏览器环境", exact: true })
      .getAttribute("data-value"),
    envA.id,
  );
  await page
    .getByRole("dialog", { name: "关联浏览器环境" })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.locator(".main-content").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: join(screenshots, "environment-account-handoff-1440.png"),
    fullPage: false,
  });
  checks.push(
    "长列表编辑自动定位并聚焦、取消返回触发按钮；环境关联入口预选新账号及已有账号目标环境",
  );
  await page.getByRole("button", { name: "指纹浏览器", exact: true }).click();
  await page
    .getByRole("heading", { name: "环境任务调度", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(screenshots, "environment-jobs-1440.png"),
    fullPage: false,
  });
  failRead = true;
  await page.getByRole("tab", { name: "其他账号", exact: true }).click();
  await page.getByText(/模拟环境读取失败/).waitFor();
  assert.ok(await page.locator(".website-account-row").count());
  failRead = false;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.getByText(/模拟环境读取失败/).waitFor({ state: "hidden" });
  await page.locator(".main-content").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: join(screenshots, "accounts-1440.png"),
    fullPage: true,
  });
  await page
    .locator(".website-account-row")
    .filter({ hasText: "微博运营 A" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(screenshots, "accounts-weibo-1440.png"),
    fullPage: false,
  });
  await page
    .getByRole("heading", { name: "其他发布平台", exact: true })
    .scrollIntoViewIfNeeded();
  await page.getByText("CSDN 共用环境账号", { exact: true }).waitFor();
  await page.screenshot({
    path: join(screenshots, "publishing-accounts-1440.png"),
    fullPage: false,
  });
  const mainNavigation = page.getByRole("navigation", { name: "主导航" });
  failRead = true;
  await mainNavigation
    .getByRole("button", { name: "连接与设置", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "设置分区" })
    .getByRole("link", { name: "发布映射", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "暂时无法读取浏览器环境", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(screenshots, "binding-environment-error-1440.png"),
    fullPage: false,
  });
  failRead = false;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await chooseOption(
    page.getByRole("combobox", { name: "发布浏览器环境", exact: true }),
    bitEnv.profileId,
  );
  await page
    .getByRole("heading", { name: "暂时无法读取浏览器环境", exact: true })
    .waitFor({ state: "hidden" });
  await mainNavigation
    .getByRole("button", { name: "账号管理", exact: true })
    .click();
  environmentReadMode = "empty";
  await mainNavigation
    .getByRole("button", { name: "连接与设置", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "设置分区" })
    .getByRole("link", { name: "发布映射", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "尚未接入指纹浏览器环境", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(screenshots, "binding-environment-empty-1440.png"),
    fullPage: false,
  });
  environmentReadMode = "normal";
  await page
    .getByRole("button", { name: "管理指纹浏览器", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "指纹浏览器", exact: true })
    .waitFor();
  environmentReadMode = "hold";
  await mainNavigation
    .getByRole("button", { name: "连接与设置", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "设置分区" })
    .getByRole("link", { name: "发布映射", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "正在读取可用浏览器环境…", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("combobox", { name: "发布浏览器环境", exact: true })
      .isDisabled(),
    true,
  );
  environmentReadMode = "normal";
  releaseEnvironmentRead();
  await page
    .getByRole("heading", { name: "正在读取可用浏览器环境…", exact: true })
    .waitFor({ state: "hidden" });
  checks.push(
    "发布映射区分环境加载、真实空态和失败；重试后恢复可选环境，空态可进入环境管理",
  );
  await mainNavigation
    .getByRole("button", { name: "账号管理", exact: true })
    .click();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole("button", { name: "指纹浏览器", exact: true }).click();
  await page.getByRole("button", { name: "新建环境", exact: true }).click();
  assert.equal(
    await environmentName.evaluate((el) => document.activeElement === el),
    true,
  );
  assert.ok(
    await environmentName.evaluate(
      (el) =>
        el.getBoundingClientRect().top >= 0 &&
        el.getBoundingClientRect().bottom <= innerHeight,
    ),
  );
  await page.screenshot({
    path: join(screenshots, "environment-form-1366.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "保存环境", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(screenshots, "environment-form-footer-1366.png"),
    fullPage: false,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  checks.push("1440×900 和 1366×768 实际源码布局、读取失败保留内容及重试通过");
  // Check legacy migration against a disposable v16 file, including exact persistent partition names.
  const legacyPath = join(evidence, "legacy.db"),
    legacy = new Database(legacyPath);
  legacy.db.exec(
    "DROP TABLE browser_environment_jobs;DROP TABLE browser_environment_accounts;DROP TABLE browser_environment_identities;DROP TABLE browser_environments;PRAGMA user_version=16;",
  );
  legacy.run(
    "INSERT INTO website_accounts(id,provider,alias,uid,status,created_at,updated_at) VALUES('web_legacy','weibo','原微博','1234567890','connected','now','now')",
  );
  legacy.close();
  const migrated = new Database(legacyPath),
    registry = new BrowserEnvironments(
      migrated,
      new SecretStore(migrated, f.codec),
      f.ports,
      "/temporary/workspace",
      () => {},
    );
  const expected = createHash("sha256")
    .update("/temporary/workspace\0weibo\0web_legacy")
    .digest("hex")
    .slice(0, 24);
  assert.equal(
    registry.forAccount({ kind: "website", id: "web_legacy" }).profileId,
    `persist:panxu-weibo-${expected}`,
  );
  assert.equal(
    Number(migrated.db.prepare("PRAGMA user_version").get().user_version),
    18,
  );
  const interrupted = {
    id: "envjob_interrupted",
    label: "重启恢复",
    environmentIds: [],
    accounts: [],
    status: "running",
    message: "旧操作",
    createdAt: "now",
    updatedAt: "now",
  };
  migrated.run(
    "INSERT INTO browser_environment_jobs(id,status,data,created_at,updated_at) VALUES(?,?,?,?,?)",
    interrupted.id,
    "running",
    JSON.stringify(interrupted),
    "now",
    "now",
  );
  const recoveredQueue = new BrowserEnvironmentQueue(
    migrated,
    registry,
    () => {},
  );
  assert.equal(recoveredQueue.list()[0].status, "attention");
  assert.equal(recoveredQueue.isBusy, false);
  recoveredQueue.close();
  migrated.close();
  checks.push(
    "v16→v18 迁移保留账号 UID 与原有分区；中断任务仅标记待核对，不自动重发",
  );
  const originalChooseDirectory = f.ports.chooseDirectory;
  const backupSelection = join(evidence, "exports");
  await mkdir(backupSelection);
  f.ports.chooseDirectory = async () => backupSelection;
  const interruptedBackupJob = {
    id: "envjob_backup_interrupted",
    label: "备份恢复验证",
    accounts: [],
    environmentIds: [],
    status: "running",
    message: "本地模拟未完成任务",
    createdAt: "now",
    updatedAt: "now",
  };
  f.app.db.run(
    "INSERT INTO browser_environment_jobs(id,status,data,created_at,updated_at) VALUES(?,?,?,?,?)",
    interruptedBackupJob.id,
    "running",
    JSON.stringify(interruptedBackupJob),
    "now",
    "now",
  );
  const beforeRestore = f.app.environments.stamp({
    kind: "website",
    id: weibo.id,
  });
  const originalIdentityVerified = f.app.environments.identityCurrent({
    kind: "website",
    id: weibo.id,
  });
  const backupFolder = await f.app.invoke("system.backup");
  const backupInfo = await inspectBackup(backupFolder);
  const restored = await stageRestore(
    backupFolder,
    f.dir,
    backupInfo.databaseSha256,
  );
  f.ports.chooseDirectory = originalChooseDirectory;
  const restoredDb = new Database(join(restored.dataPath, "panxu.db"));
  try {
    const restoredRegistry = new BrowserEnvironments(
      restoredDb,
      new SecretStore(restoredDb, f.codec),
      f.ports,
      restored.dataPath,
      () => {},
    );
    const restoredWeibo = restoredRegistry.link({
      kind: "website",
      id: weibo.id,
    });
    assert.equal(restoredWeibo.uid, weibo.uid);
    assert.equal(
      restoredRegistry.forAccount({ kind: "website", id: weibo.id }).profileId,
      f.app.environments.forAccount({ kind: "website", id: weibo.id })
        .profileId,
    );
    assert.equal(
      restoredRegistry.identityCurrent({ kind: "website", id: weibo.id }),
      false,
    );
    assert.throws(
      () =>
        restoredRegistry.assertStamp(
          { kind: "website", id: weibo.id },
          beforeRestore,
        ),
      /环境或登录身份已变化/,
    );
    assert.equal(restoredDb.get("SELECT COUNT(*) AS n FROM secrets").n, 0);
    assert.equal(restoredRegistry.get(proxyOne.id).network, undefined);
    assert.equal(restoredRegistry.get(proxyOne.id).hasProxyCredentials, false);
    const recovered = JSON.parse(
      restoredDb.get(
        "SELECT data FROM browser_environment_jobs WHERE id=?",
        interruptedBackupJob.id,
      ).data,
    );
    assert.equal(recovered.status, "attention");
    assert.equal(
      restoredDb.get(
        "SELECT status FROM browser_environment_jobs WHERE id=?",
        interruptedBackupJob.id,
      ).status,
      "attention",
    );
    assert.equal(
      restoredRegistry.list().length,
      f.app.environments.list().length,
    );
  } finally {
    restoredDb.close();
  }
  assert.equal(
    f.app.environments.identityCurrent({ kind: "website", id: weibo.id }),
    originalIdentityVerified,
  );
  checks.push(
    "v18 导出→预检→复制恢复保留环境与账号关系，不携带凭据，清核验/出口并阻止旧准备及自动重发；原工作空间不变",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(
      { checks, errors, screenshots, clearCalls, submitCalls },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, evidence, screenshots },
      null,
      2,
    ),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
  console.error("Environment E2E evidence:", evidence);
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  await browser?.close();
  await f.cleanup();
}
