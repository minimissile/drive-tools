import { navigateTo } from "./e2e-navigation.mjs";
// Browser plugin unavailable. Exercise source Electron with disposable data and controlled local reads.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const evidence = await mkdtemp(join(tmpdir(), "panxu-data-states-"));
const dataPath = join(evidence, "data");
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
const checks = [],
  errors = [];
let page;
console.log(`Data state evidence: ${evidence}`);
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ session }) => {
    globalThis.__stateExternal = 0;
    globalThis.fetch = async () => {
      globalThis.__stateExternal++;
      throw Error("State QA blocks external services");
    };
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      const u = new URL(d.url);
      cb({
        cancel:
          ["http:", "https:"].includes(u.protocol) &&
          u.origin !== "http://127.0.0.1:8070",
      });
    });
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  await page.evaluate(async () => {
    const a = await window.panxu.invoke("account.add", {
      provider: "quark",
      alias: "状态验收本人账号",
    });
    for (let i = 0; i < 4; i++)
      await window.panxu.invoke("resource.save", {
        title: `异步状态资料 ${i}`,
        sourceText: `https://pan.quark.cn/s/state-${i}`,
        category: "设计素材",
        tags: ["本地模拟"],
        summary: "用于检查慢读取、失败恢复与列表占位。",
        accountId: a.id,
        directory: "/测试",
        rightsConfirmed: false,
        enqueue: false,
      });
  });
  await page.addInitScript(() => {
    window.__stateModes = JSON.parse(
      sessionStorage.getItem("qa-state-modes") ?? "{}",
    );
    window.__statePending = [];
    window.__stateCalls = {};
  });
  const clientSource = await fetch(
    "http://127.0.0.1:8070/src/api/client.ts",
  ).then((r) => r.text());
  const instrumented = clientSource.replace(
    "return window.panxu.invoke",
    `window.__stateCalls[method] = (window.__stateCalls[method] || 0) + 1;
    if (window.__stateModes[method] === "fail") return Promise.reject(new Error("模拟本地读取失败：" + method));
    if (window.__stateModes[method] === "hold") return new Promise((resolve, reject) => window.__statePending.push({ method, resolve: () => window.panxu.invoke(method, args).then(resolve,reject) }));
    return window.panxu.invoke`,
  );
  assert.notEqual(instrumented, clientSource);
  await page.route("**/src/api/client.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: instrumented,
    }),
  );
  await page.reload();
  await page.locator(".resource-row").first().waitFor();
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  const mode = async (method, value) =>
    page.evaluate(
      ({ method, value }) => {
        window.__stateModes[method] = value;
      },
      { method, value },
    );
  const release = async (method) => {
    await mode(method, "");
    await page.evaluate((method) => {
      const jobs = window.__statePending.filter((p) => p.method === method);
      window.__statePending = window.__statePending.filter(
        (p) => p.method !== method,
      );
      for (const p of jobs) p.resolve();
    }, method);
  };
  const pending = (method) =>
    page.waitForFunction(
      (method) => window.__statePending.some((p) => p.method === method),
      method,
    );
  const shot = async (name) => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const data = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(join(evidence, name + ".png"), Buffer.from(data, "base64"));
  };
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1320, 900),
  );
  await nav("账号管理").click();
  await mode("resource.page", "hold");
  await nav("资源库").click();
  await pending("resource.page");
  await page.locator(".data-loading-list").waitFor();
  assert.equal(await page.locator(".data-skeleton-row").count(), 4);
  assert.equal(
    await page.getByRole("heading", { name: "没有找到匹配资源" }).count(),
    0,
  );
  assert.equal(await page.getByLabel("选择本页可检查分享").isDisabled(), true);
  assert.doesNotMatch(
    await page.getByRole("navigation", { name: "资源翻页" }).innerText(),
    /第 1/,
  );
  await shot("library-initial-loading-1320");
  await release("resource.page");
  await page.locator(".resource-row").first().waitFor();
  checks.push(
    "首次资源读取使用有内边距的列表占位，无假空态、假0条或可用批量操作",
  );
  const region = page.locator(".resource-list-body");
  const before = await region.boundingBox();
  await mode("resource.page", "hold");
  await page.getByRole("searchbox").fill("异步状态资料 1");
  await pending("resource.page");
  assert.equal(await page.locator(".resource-row").count(), 4);
  assert.equal(await page.locator(".data-loading-list").count(), 0);
  assert.equal((await region.boundingBox()).height, before.height);
  assert.match(
    await page.locator(".library-result-count").innerText(),
    /正在更新资源/,
  );
  await shot("library-refresh-retains-content-1320");
  await release("resource.page");
  await page.waitForFunction(
    () => document.querySelectorAll(".resource-row").length === 1,
  );
  checks.push(
    "筛选慢响应保留已有内容和列表高度，刷新提示归入工具栏，禁止旧列表的批量检查",
  );
  await page.getByRole("searchbox").fill("肯定没有结果的关键词");
  const empty = page.getByRole("heading", {
    name: "没有找到匹配资源",
    exact: true,
  });
  await empty.waitFor();
  const state = region.locator(".data-state--empty");
  const stateBox = await state.boundingBox(),
    regionBox = await region.boundingBox();
  assert.ok(
    Math.abs(
      stateBox.y + stateBox.height / 2 - (regionBox.y + regionBox.height / 2),
    ) < 3,
  );
  await shot("library-empty-centered-1320");
  await mode("resource.page", "hold");
  await page.getByRole("searchbox").fill("另一个尚未完成的查询");
  await pending("resource.page");
  assert.equal(await empty.count(), 0);
  await region.locator(".data-state--loading").waitFor();
  await release("resource.page");
  await empty.waitFor();
  checks.push(
    "无结果状态使用列表区域的居中布局；下一次请求未完成时不提前显示无结果",
  );
  await mode("resource.page", "fail");
  await page.getByRole("searchbox").fill("失败后的查询");
  await region.getByRole("alert").waitFor();
  assert.equal(await empty.count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "重试读取", exact: true }).count(),
    1,
  );
  await shot("library-read-error-1320");
  await mode("resource.page", "");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await empty.waitFor();
  await page
    .getByRole("button", { name: "清除筛选，查看全部资源", exact: true })
    .click();
  await page.locator(".resource-row").first().waitFor();
  checks.push(
    "读取失败完整占据结果区、不冒充空库；唯一重试入口恢复查询并保留筛选",
  );
  await mode("batch.candidates", "hold");
  await nav("批量转存").click();
  await pending("batch.candidates");
  await page.getByRole("heading", { name: "正在读取待转存草稿…" }).waitFor();
  await release("batch.candidates");
  await page
    .getByRole("checkbox", { name: "批量选择异步状态资料 1", exact: true })
    .waitFor();
  await mode("batch.candidates", "fail");
  await page.getByRole("searchbox").fill("模拟草稿查询失败");
  await page
    .getByRole("alert")
    .filter({ hasText: "batch.candidates" })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "没有符合条件的草稿" }).count(),
    0,
  );
  await mode("batch.candidates", "");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.getByRole("heading", { name: "没有符合条件的草稿" }).waitFor();
  checks.push(
    "批量草稿加载有统一占位，失败与真实无结果分离；未执行转存预检或远端操作",
  );
  await mode("resourceExport.history", "hold");
  await navigateTo(page, "AI 资源导出");
  await pending("resourceExport.history");
  await page
    .getByRole("heading", { name: "正在读取导出记录…", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "还没有导出记录" }).count(),
    0,
  );
  await page
    .getByRole("heading", { name: "正在读取导出记录…", exact: true })
    .scrollIntoViewIfNeeded();
  await shot("export-history-loading-1320");
  await page
    .getByRole("heading", { name: "正在恢复导出工作区…", exact: true })
    .scrollIntoViewIfNeeded();
  await shot("export-workspace-loading-1320");
  await release("resourceExport.history");
  await page.getByRole("heading", { name: "还没有导出记录" }).waitFor();
  await nav("资源库").click();
  await mode("resourceExport.history", "fail");
  await navigateTo(page, "AI 资源导出");
  await page
    .getByRole("alert")
    .filter({ hasText: "resourceExport.history" })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "还没有导出记录" }).count(),
    0,
  );
  await mode("resourceExport.history", "");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.getByRole("heading", { name: "还没有导出记录" }).waitFor();
  checks.push("导出历史的局部加载、空态和读取失败统一，失败可原地恢复");
  await mode("search.list", "hold");
  await nav("搜索运营").click();
  await pending("search.list");
  await page.getByRole("heading", { name: "正在读取搜索选题…" }).waitFor();
  await release("search.list");
  await page.getByRole("heading", { name: "从一个关键词开始" }).waitFor();
  await nav("资源库").click();
  await mode("search.list", "fail");
  await nav("搜索运营").click();
  await page.getByRole("alert").filter({ hasText: "search.list" }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "从一个关键词开始" }).count(),
    0,
  );
  await mode("search.list", "");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.getByRole("heading", { name: "从一个关键词开始" }).waitFor();
  checks.push("搜索运营慢读取使用区域占位，失败不显示引导空态且可重试");
  await mode("traffic.knowledge.list", "hold");
  await nav("流量发现").click();
  await page.getByRole("tab", { name: "本地知识库", exact: true }).click();
  await pending("traffic.knowledge.list");
  await page
    .getByRole("heading", { name: "正在读取本地知识库…", exact: true })
    .waitFor();
  await release("traffic.knowledge.list");
  await page.getByRole("heading", { name: "暂无匹配的知识库资料" }).waitFor();
  await mode("traffic.knowledge.list", "fail");
  await page.getByRole("button", { name: "刷新本地", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "traffic.knowledge.list" })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "暂无匹配的知识库资料" }).count(),
    0,
  );
  await shot("knowledge-error-1320");
  await mode("traffic.knowledge.list", "");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.getByRole("heading", { name: "暂无匹配的知识库资料" }).waitFor();
  checks.push("知识库复用读取生命周期，失败不再冒充空库，支持本地重试");
  await page.evaluate(() =>
    sessionStorage.setItem(
      "qa-state-modes",
      JSON.stringify({ "updater.state": "hold" }),
    ),
  );
  await page.reload();
  await nav("连接与设置").click();
  await pending("updater.state");
  await page
    .getByRole("heading", { name: "正在读取版本状态…", exact: true })
    .scrollIntoViewIfNeeded();
  await shot("update-state-loading-1320");
  await release("updater.state");
  await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  await page.evaluate(() =>
    sessionStorage.setItem(
      "qa-state-modes",
      JSON.stringify({ "updater.state": "fail" }),
    ),
  );
  await page.reload();
  await nav("连接与设置").click();
  await page.getByRole("heading", { name: "版本状态暂未读取成功" }).waitFor();
  await mode("updater.state", "");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  checks.push(
    "更新状态首读失败停止持续加载，重试只读取本地状态，不检查或下载远端更新",
  );
  await page.evaluate(() =>
    sessionStorage.setItem(
      "qa-state-modes",
      JSON.stringify({ snapshot: "hold" }),
    ),
  );
  await page.reload();
  await pending("snapshot");
  await page.getByRole("heading", { name: "正在打开本地知识库…" }).waitFor();
  await shot("boot-loading-1320");
  await release("snapshot");
  await page.locator("main h1").waitFor();
  await page.evaluate(() =>
    sessionStorage.setItem(
      "qa-state-modes",
      JSON.stringify({ snapshot: "fail" }),
    ),
  );
  await page.reload();
  await page.getByRole("heading", { name: "本地知识库暂未打开" }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "正在打开本地知识库…" }).count(),
    0,
  );
  assert.equal(await page.getByRole("alert").count(), 1);
  await mode("snapshot", "");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.locator("main h1").waitFor();
  checks.push("应用启动使用同一加载/失败组件，错误后原地恢复而不需重启");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 900),
  );
  await nav("资源库").click();
  await page.getByRole("searchbox").fill("小窗口无匹配资料");
  await empty.waitFor();
  await shot("library-empty-840");
  await mode("resource.page", "fail");
  await page.getByRole("searchbox").fill("小窗口读取失败");
  await region.getByRole("alert").waitFor();
  await shot("library-error-840");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
  );
  await page
    .getByRole("button", { name: "重试读取", exact: true })
    .scrollIntoViewIfNeeded();
  assert.ok(
    await page.locator("main").evaluate((n) => n.scrollWidth <= n.clientWidth),
  );
  await shot("library-error-840-zoom200");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mode("resource.page", "hold");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await pending("resource.page");
  assert.equal(
    await region
      .locator(".spin")
      .evaluate((n) => getComputedStyle(n).animationName),
    "none",
  );
  await shot("library-loading-840-zoom200");
  await release("resource.page");
  checks.push(
    "840px与200%下长提示和操作可达；减少动态效果保留文字反馈并停止转动",
  );
  const bridgeErrors = [];
  const nextWindow = app.waitForEvent("window");
  await app.evaluate(({ BrowserWindow }) => {
    const browserWindow = new BrowserWindow({
      show: false,
      width: 840,
      height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    void browserWindow.loadURL("http://127.0.0.1:8070/");
  });
  const withoutBridge = await nextWindow;
  withoutBridge.on("pageerror", (error) => bridgeErrors.push(error.message));
  await withoutBridge.goto("http://127.0.0.1:8070/");
  await withoutBridge
    .getByRole("heading", { name: "请在盘序桌面程序中打开", exact: true })
    .waitFor();
  await withoutBridge.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.deepEqual(bridgeErrors, []);
  await withoutBridge.close();
  checks.push("缺少桌面桥接时显示既有打开方式提示，不启动本地读取或产生异常");
  assert.deepEqual(errors, []);
  assert.equal(await app.evaluate(() => globalThis.__stateExternal), 0);
  console.log(JSON.stringify({ checks, errors, evidence, dataPath }, null, 2));
} catch (e) {
  console.error(
    await page
      ?.evaluate(() => ({
        heading: document.querySelector("main h1")?.innerText,
        pending: window.__statePending?.map((p) => p.method),
        body: document.body.innerText.slice(-1800),
      }))
      .catch(() => null),
  );
  await page
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => {});
  throw e;
} finally {
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify({ checks, errors, dataPath }, null, 2),
  );
  await app.close();
}
