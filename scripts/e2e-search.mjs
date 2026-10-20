// Browser plugin not available. Validate the real Electron renderer with the
// repository's existing Playwright workflow and an isolated, offline workspace.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  dataPath = await mkdtemp(join(tmpdir(), "panxu-search-e2e-"));
const evidence =
  process.env.PANXU_QA_DIR ??
  (await mkdtemp(join(tmpdir(), "panxu-search-evidence-")));
await mkdir(evidence, { recursive: true });
const dev = process.env.PANXU_E2E_DEV === "1";
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  ...(dev
    ? { PANXU_DEV_URL: "http://127.0.0.1:5173", PANXU_DEV_ROOT: process.cwd() }
    : {}),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: process.env.PANXU_ELECTRON_PATH ?? require("electron"),
  args: [dev ? join(process.cwd(), "dist-dev") : process.cwd()],
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
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  await page.evaluate(() =>
    window.panxu.invoke("updater.configure", { autoCheck: false }),
  );
  await app.evaluate(() => {
    globalThis.fetch = async () => {
      throw new Error("搜索运营测试已阻止外部请求");
    };
  });
  assert.match(await page.title(), /盘序/);
  if (dev) assert.equal(new URL(page.url()).origin, "http://127.0.0.1:5173");
  else assert.match(page.url(), /dist\/index.html/);
  const initial = await page.evaluate(async () => {
    const account = await window.panxu.invoke("account.add", {
      provider: "quark",
      alias: "搜索运营测试本人",
    });
    const saved = await window.panxu.invoke("resource.save", {
      title: "Obsidian 入门资料",
      sourceText: "https://pan.quark.cn/s/search-fixture-source",
      category: "工具教程",
      tags: ["Obsidian"],
      summary: "本人整理的安装图解与使用记录。",
      accountId: account.id,
      directory: "/盘序资源",
      rightsConfirmed: true,
      enqueue: false,
    });
    const pool = await window.panxu.invoke("pool.manual", {
      name: "搜索教程词池",
      resourceId: saved.resourceId,
      words: "Obsidian Windows 安装教程\nObsidian 模板怎么使用",
    });
    return { account, saved, pool };
  });
  const db = new DatabaseSync(join(dataPath, "panxu.db")),
    time = new Date().toISOString();
  const file = {
    id: "fixture-file",
    parentId: "fixture-folder",
    name: "安装图解.pdf",
    isDirectory: false,
    size: 120,
  };
  db.prepare(
    "UPDATE accounts SET uid='fixture-owner',status='connected',verified_at=? WHERE id=?",
  ).run(time, initial.account.id);
  db.prepare(
    "UPDATE copies SET status='ready',owner_uid='fixture-owner',folder_id='fixture-folder',files=?,verified_at=?,share_id='whole-share',share_url='https://pan.quark.cn/s/fixture-whole',share_owner_uid='fixture-owner',share_version=1,share_verified_at=? WHERE id=?",
  ).run(JSON.stringify([file]), time, time, initial.saved.copyId);
  db.prepare(
    "INSERT INTO jobs(id,copy_id,kind,target_id,stage,checkpoint,created_at,updated_at) VALUES('fixture-preview',?,'split_preview','fixture-run','completed','complete',?,?)",
  ).run(initial.saved.copyId, time, time);
  db.prepare(
    "INSERT INTO split_runs(id,copy_id,depth,mode,status,job_id,created_at) VALUES('fixture-run',?,3,'all','ready','fixture-preview',?)",
  ).run(initial.saved.copyId, time);
  db.prepare(
    "INSERT INTO split_items(id,copy_id,file_id,file,ancestors,path,depth,status,share_id,share_url,owner_uid,verified_at,share_version) VALUES('fixture-child',?,?,?,'[]','安装图解.pdf',1,'ready','child-share','https://pan.quark.cn/s/fixture-child','fixture-owner',?,1)",
  ).run(initial.saved.copyId, file.id, JSON.stringify(file), time);
  db.exec("INSERT INTO split_run_items VALUES('fixture-run','fixture-child')");
  db.close();
  await page.reload();
  await page.locator(".resource-list").waitFor();
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  await nav("搜索运营").click();
  await page
    .getByRole("heading", { name: "从一个关键词开始", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "从词池创建", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "从词池创建搜索选题" });
  await dialog
    .getByRole("checkbox", { name: "Obsidian Windows 安装教程", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "创建所选选题", exact: true })
    .click();
  await page
    .getByRole("button")
    .filter({ hasText: "Obsidian Windows 安装教程" })
    .click();
  dialog = page.getByRole("dialog", { name: "为选题关联本人资料" });
  await dialog.waitFor();
  await dialog
    .getByRole("button")
    .filter({ hasText: "Obsidian 入门资料" })
    .click();
  await dialog
    .getByRole("radio", { name: "安装图解.pdf", exact: true })
    .check();
  await dialog.getByRole("button", { name: "保存关联", exact: true }).click();
  await page
    .getByRole("button", { name: "使用本地教程模板", exact: true })
    .click();
  await page.getByRole("textbox", { name: "内容正文", exact: true }).waitFor();
  assert.match(
    await page
      .getByRole("textbox", { name: "内容正文", exact: true })
      .inputValue(),
    /目标问题：Obsidian Windows 安装教程/,
  );
  assert.equal(
    await page
      .getByRole("combobox", { name: "创作渠道", exact: true })
      .inputValue(),
    "CSDN",
  );
  checks.push("已有词池 → 去重选题 → 已核验子资料关联 → 内容工作室 CSDN 教程");
  await page
    .getByRole("textbox", { name: "内容正文", exact: true })
    .fill("适用环境：Windows。本人已核对安装步骤与图解；此为隔离测试稿。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByLabel("已人工审阅", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="已人工审阅"]')?.checked,
  );
  await page.getByRole("button", { name: "准备发布", exact: true }).click();
  await page.getByText("配套拆分资料：安装图解.pdf", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByText("https://pan.quark.cn/s/fixture-whole", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByText("https://pan.quark.cn/s/fixture-child", { exact: true })
      .count(),
    1,
  );
  const context = await page.evaluate(async () => {
    const list = await window.panxu.invoke("search.list");
    const detail = await window.panxu.invoke("search.get", {
      id: list.items[0].id,
    });
    return { topic: detail.topic, draft: detail.draft };
  });
  const pubDb = new DatabaseSync(join(dataPath, "panxu.db"));
  pubDb
    .prepare(
      "INSERT INTO browser_bindings(id,platform,alias,window_id,editor_url) VALUES('fixture-binding','csdn','本人技术账号','test-window','https://editor.csdn.net/')",
    )
    .run();
  pubDb
    .prepare(
      "INSERT INTO publications(id,draft_id,draft_version,binding_id,status,created_at) VALUES('fixture-open',?,?,'fixture-binding','opened',?)",
    )
    .run(context.draft.id, context.draft.version, time);
  pubDb.close();
  await page.reload();
  await page
    .getByLabel("发布内容链接")
    .fill("https://blog.csdn.net/fixture/article/details/123");
  await page
    .getByRole("button", { name: "人工标记已发布", exact: true })
    .click();
  await page
    .getByRole("button", { name: "查看搜索选题与效果 →", exact: true })
    .click();
  await page.getByRole("button", { name: "录入效果数据", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "录入效果数据" });
  await dialog
    .getByRole("spinbutton", { name: "阅读量", exact: true })
    .fill("0");
  await dialog
    .getByRole("spinbutton", { name: "有效拉新", exact: true })
    .fill("2");
  await dialog
    .getByRole("spinbutton", { name: "已结算人民币 / 元", exact: true })
    .fill("8.00");
  await dialog.getByRole("textbox", { name: "数据来源" }).fill("隔离测试报表");
  await dialog
    .getByRole("button", { name: "保存本次数据", exact: true })
    .click();
  await page.getByText("¥8.00", { exact: true }).first().waitFor();
  assert.equal(
    await page.locator(".search-metrics strong").nth(0).innerText(),
    "0",
  );
  assert.equal(
    await page.locator(".search-metrics strong").nth(1).innerText(),
    "—",
  );
  const detail = await page.evaluate(
    (id) => window.panxu.invoke("search.get", { id }),
    context.topic.id,
  );
  assert.equal(detail.topic.stage, "published");
  assert.equal(detail.effects[0].revenueCents, 800);
  assert.equal(detail.effects[0].saves, null);
  assert.equal(detail.draft.splitItemId, "fixture-child");
  assert.equal(detail.draft.version, 2);
  checks.push(
    "新草稿版本保留关联 → 人工审阅 → 发布准备展示正确子链接 → 回填文章 → 效果零值与未知值持久化",
  );
  await page.locator(".toast").waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: join(evidence, "search-effects-desktop.png"),
    fullPage: true,
  });
  await nav("搜索运营").click();
  await page.locator(".search-board").waitFor();
  await page.screenshot({
    path: join(evidence, "search-board-desktop.png"),
    fullPage: true,
  });
  await nav("资料拆分").click();
  await page.getByRole("treeitem").first().waitFor();
  await page.getByRole("treeitem").first().click();
  await page.getByRole("button", { name: "用于创作 →", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "把拆分资料用于创作" });
  await dialog.waitFor();
  checks.push("原三级目录树保留；本人拆分结果新增用于创作入口");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await nav("搜索运营").click();
  await page.locator(".search-board").waitFor();
  await page.getByRole("button", { name: "新建选题", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "新建搜索选题" });
  await dialog
    .getByRole("textbox", { name: "目标关键词" })
    .fill("尚未关联的测试选题");
  await dialog.getByRole("button", { name: "创建选题", exact: true }).click();
  await page
    .getByRole("dialog", { name: "为选题关联本人资料" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await nav("搜索运营").click();
  await page.locator(".search-board").waitFor();
  await page
    .getByRole("button")
    .filter({ hasText: "尚未关联的测试选题" })
    .waitFor();
  await page.setViewportSize({ width: 760, height: 900 });
  await page.screenshot({
    path: join(evidence, "search-board-narrow.png"),
    fullPage: true,
  });
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(widths.scroll <= widths.client + 2, JSON.stringify(widths));
  await page.reload();
  await page.locator(".search-board").waitFor();
  assert.ok(
    (await page.evaluate(() => window.panxu.invoke("search.list"))).items.some(
      (t) => t.keyword === "尚未关联的测试选题",
    ),
  );
  checks.push("看板与窄窗口显示、重启后选题与效果仍保留");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        browser: "Browser plugin not available; repository Electron Playwright",
        dataPath,
        evidence,
        checks,
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("EVIDENCE", evidence);
  if (page) {
    console.error((await page.locator("body").innerText()).slice(-16000));
    await page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
  }
  throw error;
} finally {
  await app.close();
}
