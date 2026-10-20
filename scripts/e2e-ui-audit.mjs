import { openAccountForm } from "./e2e-account-form.mjs";
// Browser plugin unavailable. Current-source Electron, disposable DB and blocked external services.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const evidence = await mkdtemp(join(tmpdir(), "panxu-ui-audit-"));
const dataPath = join(evidence, "data");
await mkdir(dataPath);
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_URL: "http://127.0.0.1:5173",
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
console.log(`Audit evidence: ${evidence}`);
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await app.evaluate(({ session }) => {
    globalThis.__auditExternal = 0;
    globalThis.fetch = async () => {
      globalThis.__auditExternal++;
      throw new Error("QA external request blocked");
    };
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const u = new URL(details.url);
      cb({
        cancel:
          ["http:", "https:"].includes(u.protocol) &&
          u.origin !== "http://127.0.0.1:5173",
      });
    });
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1320, 900),
  );
  const seed = await page.evaluate(async () => {
    const a = await window.panxu.invoke("account.add", {
      provider: "quark",
      alias: "交互审核测试账号",
    });
    const rows = [];
    for (let i = 0; i < 63; i++)
      rows.push(
        await window.panxu.invoke("resource.save", {
          title:
            i === 0
              ? "界面审核 · 超长标题与版本保留资料：从录入、转存、拆分到内容审阅和发布的完整流程"
              : "界面审核资料 " + i,
          sourceText: "https://pan.quark.cn/s/audit-ui-" + i,
          category: "审核资料",
          tags: ["模拟"],
          summary: "本机测试资料，未调用真实网盘。",
          accountId: a.id,
          directory: "/盘序资源",
          rightsConfirmed: false,
          enqueue: false,
        }),
      );
    return { a, rows };
  });
  const db = new DatabaseSync(join(dataPath, "panxu.db"));
  const time = new Date().toISOString();
  for (const [i, row] of seed.rows.slice(0, 7).entries())
    db.prepare(
      "INSERT INTO jobs(id,copy_id,kind,target_id,stage,checkpoint,error,logs,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "qa-job-" + i,
      row.copyId,
      "transfer",
      row.copyId,
      i === 6 ? "failed" : "completed",
      "new",
      i === 6 ? "审核模拟：网络中断，请核对远端结果后恢复。" : null,
      "[]",
      time,
      time,
    );
  db.close();
  await page.reload();
  await page.locator(".resource-row").first().waitFor();
  await nav("录入资源").click();
  const title = page.getByLabel("资源标题", { exact: true });
  await title.fill("审核切页暂存标题");
  await page
    .getByLabel("网盘分享链接", { exact: true })
    .fill("https://pan.quark.cn/s/audit-unsaved");
  await page.getByLabel("资源说明").fill("长说明验证。".repeat(2000));
  const coverBuffer = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext("2d").fillRect(0, 0, 32, 32);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: "draft-cover.png",
    mimeType: "image/png",
    buffer: coverBuffer,
  });
  await page.getByAltText("待保存封面").waitFor();
  await nav("账号管理").click();
  await nav("录入资源").click();
  assert.equal(await title.inputValue(), "审核切页暂存标题");
  await page.getByAltText("待保存封面").waitFor();
  await page.reload();
  await title.waitFor();
  assert.equal(await title.inputValue(), "审核切页暂存标题");
  await page.getByAltText("待保存封面").waitFor();
  assert.equal(
    await page.getByText("我有权保存和分享该资源", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "保存资料草稿", exact: true }).click();
  await page.locator(".resource-row").first().waitFor();
  await nav("录入资源").click();
  assert.equal(await title.inputValue(), "");
  checks.push("录入长文本切页与重载恢复，已移除权利勾选，保存后清理暂存");
  await nav("批量录入").click();
  const csv = page.getByLabel("批量资源CSV");
  await csv.fill(
    "标题,链接,分类\nCSV暂存,https://pan.quark.cn/s/audit-csv,审核",
  );
  await nav("资源库").click();
  await nav("批量录入").click();
  assert.match(await csv.inputValue(), /CSV暂存/);
  checks.push("CSV输入切页保留，预检与提交保持显式");
  await nav("流量发现").click();
  await page.getByLabel("手工词池名称").fill("未保存词池");
  await page.getByLabel("手工词池关键词").fill("暂存关键词");
  await nav("资源库").click();
  await nav("流量发现").click();
  assert.equal(
    await page.getByLabel("手工词池名称").inputValue(),
    "未保存词池",
  );
  checks.push("手工词池未保存输入切页保留");
  await nav("连接与设置").click();
  await page.getByLabel("比特接口地址").fill("http://127.0.0.1:23456");
  await nav("资源库").click();
  await nav("连接与设置").click();
  assert.equal(
    await page.getByLabel("比特接口地址").inputValue(),
    "http://127.0.0.1:23456",
  );
  await page.getByRole("button", { name: "保存比特地址", exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.panxu.invoke("snapshot"))).settings
      .bitUrl,
    "http://127.0.0.1:23456",
  );
  await page.getByRole("link", { name: "备份与更新", exact: true }).click();
  await page.screenshot({ path: join(evidence, "settings-maintenance.png") });
  checks.push("设置输入切页保留、分区保存、备份更新定位");
  await nav("转存任务").click();
  await page.getByRole("tab", { name: /需要处理 1/, selected: true }).waitFor();
  assert.equal(await page.locator(".task-panel").count(), 1);
  await page.getByRole("tab", { name: /已完成 6/ }).click();
  assert.equal(await page.locator(".completed-task").count(), 6);
  assert.equal(await page.locator(".task-panel:visible").count(), 0);
  await page.locator(".completed-task > summary").first().click();
  assert.equal(await page.locator(".task-panel:visible").count(), 1);
  await page.getByRole("tab", { name: /需要处理 1/ }).click();
  await page.screenshot({ path: join(evidence, "tasks-attention.png") });
  checks.push("异常任务默认直达，状态数量准确，完成记录按需展开");
  // Server-side resource search through the common Base UI combobox.
  await nav("流量发现").click();
  await page.getByRole("button", { name: "展开当前资源", exact: true }).click();
  await page.getByLabel("当前资源", { exact: true }).fill("界面审核资料 50");
  await page
    .getByRole("option", { name: "界面审核资料 50", exact: true })
    .click();
  assert.equal(
    (await page.evaluate(() => JSON.parse(localStorage.getItem("panxu-ui-v1"))))
      .resourceId,
    seed.rows[50].resourceId,
  );
  checks.push("公共可搜索资源选择器查找并选中全库资源");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 760),
  );
  await nav("资源库").click();
  await page.locator(".resource-row").first().click();
  await page.getByRole("dialog", { name: "资源档案", exact: true }).waitFor();
  assert.ok(
    await page
      .getByRole("dialog", { name: "资源档案", exact: true })
      .evaluate((n) => n.scrollTop < 4),
  );
  await page
    .getByRole("dialog", { name: "资源档案", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .waitFor();
  await page.screenshot({ path: join(evidence, "library-detail-840.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.ok(
    await page.evaluate(() => document.activeElement?.matches(".resource-row")),
  );
  checks.push("原生840窗口选择即呈现档案，Esc返回并恢复列表焦点");
  for (const name of [
    "资源库",
    "AI 资源导出",
    "录入资源",
    "批量录入",
    "批量转存",
    "资料拆分",
    "转存任务",
    "搜索运营",
    "流量发现",
    "分享统计",
    "内容工作室",
    "发布准备",
    "账号管理",
    "连接与设置",
  ]) {
    await nav(name).click();
    await page.locator("main h1").waitFor();
    assert.ok(
      await page
        .locator("main")
        .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
      name,
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      name,
    );
  }
  await nav("内容工作室").click();
  assert.equal(
    await page.getByRole("combobox", { name: "创作渠道", exact: true }).count(),
    1,
  );
  assert.equal(await page.locator(".platform-nav").count(), 0);
  await page.screenshot({ path: join(evidence, "studio-840.png") });
  checks.push("14模块原生840窗口无页面溢出，工作室默认紧凑渠道");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
  );
  await page.getByRole("button", { name: "切换功能", exact: true }).click();
  await nav("连接与设置").click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({ path: join(evidence, "settings-200-percent.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  checks.push("原生840窗口200%缩放下设置可滚动且无页面横向溢出");
  await nav("录入资源").click();
  const placeholder = await title.evaluate((el) => {
    const x = getComputedStyle(el, "::placeholder");
    return { color: x.color, opacity: x.opacity };
  });
  assert.equal(placeholder.opacity, "1");
  assert.equal(placeholder.color, "rgb(93, 108, 132)");
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
    "light only",
  );
  checks.push("提示文本不透明且使用校正颜色；系统暗色下仍白色，减少动态效果");
  // Renderer-only fault injection: no backend or real data mutation.
  const pattern = "**/src/api/client.ts*";
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "return window.panxu.invoke",
      'if (method === "snapshot" && !window.__qaBootFailed) { window.__qaBootFailed = true; return Promise.reject(new Error("模拟本地读取失败")); } return window.panxu.invoke',
    );
    await route.fulfill({ response, body });
  });
  await page.reload();
  await page.getByRole("heading", { name: "本地知识库暂未打开" }).waitFor();
  assert.equal(
    await page.getByText("正在打开本地知识库…", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.locator("main h1").filter({ hasText: "录入" }).waitFor();
  checks.push("初始化读取失败停止假加载，点击重试恢复而不需重启");
  await page.unroute(pattern);
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "return window.panxu.invoke",
      'if (method === "snapshot" && window.__qaNextSnapshotFail) { window.__qaNextSnapshotFail = false; return Promise.reject(new Error("模拟提交后视图刷新失败")); } if (method === "account.add" && args.alias === "模拟确认只提交一次") { window.__qaSaveCount = (window.__qaSaveCount || 0) + 1; return new Promise(resolve => setTimeout(async () => { const result = await window.panxu.invoke(method, args); window.__qaNextSnapshotFail = true; resolve(result); }, 250)); } if (method === "resource.page" && args.query === "界面审核资料 1") { window.__qaSlowStarted = true; return new Promise(resolve => setTimeout(async () => { const result = await window.panxu.invoke(method, args); window.__qaSlowResolved = true; resolve(result); }, 700)); } if (method === "resource.page" && !window.__qaPageFailed) { window.__qaPageFailed = true; return Promise.reject(new Error("模拟资源列表读取失败")); } return window.panxu.invoke',
    );
    await route.fulfill({ response, body });
  });
  await page.reload();
  await nav("资源库").click();
  await page
    .getByText("模拟资源列表读取失败", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "没有找到匹配资源" }).count(),
    0,
  );
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.locator(".resource-row").first().waitFor();
  checks.push("列表读取失败不会冒充空库，显式重试恢复");
  await page.getByRole("searchbox").fill("界面审核资料 1");
  await page.waitForFunction(() => window.__qaSlowStarted);
  await page.getByRole("searchbox").fill("肯定没有匹配的审核资料");
  await page.getByRole("heading", { name: "没有找到匹配资源" }).waitFor();
  await page.waitForFunction(() => window.__qaSlowResolved);
  assert.equal(await page.locator(".resource-row").count(), 0);
  checks.push("慢读取晚于新筛选返回时不会覆盖当前结果");
  await nav("账号管理").click();
  await openAccountForm(page);
  await page.getByLabel("新增账号别名").fill("模拟确认只提交一次");
  const submit = page.locator('.account-connect button[type="submit"]');
  await submit.click();
  assert.equal(await submit.isDisabled(), true);
  await page.getByLabel("新增账号别名").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__qaSaveCount), 1);
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page
    .getByRole("heading", { name: "模拟确认只提交一次", exact: true })
    .waitFor();
  checks.push(
    "提交中禁止重复操作，提交成功后的刷新失败不丢返回值，重试只读取视图",
  );
  await nav("资源库").click();
  await page.getByRole("searchbox").fill("");
  await page.locator(".resource-row").first().waitFor();
  await page.unroute(pattern);
  await page.screenshot({ path: join(evidence, "library-recovered-840.png") });
  assert.deepEqual(errors, []);
  assert.equal(await app.evaluate(() => globalThis.__auditExternal), 0);
  console.log(JSON.stringify({ checks, errors, evidence, dataPath }, null, 2));
} catch (error) {
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
