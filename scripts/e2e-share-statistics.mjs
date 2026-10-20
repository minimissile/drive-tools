import { chooseOption } from "./e2e-select.mjs";
// Browser plugin not available. Exercise the real Electron renderer and IPC
// using the existing Playwright workflow with isolated, offline sessions.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const dataPath = await mkdtemp(join(tmpdir(), "panxu-share-statistics-e2e-"));
const evidence =
  process.env.PANXU_QA_DIR ??
  (await mkdtemp(join(tmpdir(), "panxu-share-statistics-evidence-")));
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
      throw new Error("统计测试禁止外部网络请求");
    };
  });
  assert.match(await page.title(), /盘序/);
  if (dev) assert.equal(new URL(page.url()).origin, "http://127.0.0.1:5173");
  else assert.match(page.url(), /dist\/index.html/);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "分享统计", exact: true }).click();
  await page
    .getByRole("heading", { name: "还没有分享统计", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(evidence, "01-share-statistics-empty.png"),
  });
  checks.push("页面身份、首屏、空态及账号入口");
  const accounts = await page.evaluate(async () => {
    const result = [];
    for (const [provider, alias] of [
      ["quark", "夸克资料账号"],
      ["uc", "UC资料账号"],
      ["baidu", "百度资料账号"],
      ["xunlei", "迅雷待重新登录账号"],
    ])
      result.push(
        await window.panxu.invoke("account.add", { provider, alias }),
      );
    return result;
  });
  await app.evaluate(async ({ session }, accounts) => {
    globalThis.__shareStatisticsQa = { phase: 0, calls: [], failure: false };
    for (const a of accounts.filter((a) => a.provider !== "xunlei")) {
      const s = session.fromPartition(`persist:panxu-${a.id}`);
      await s.protocol.handle("https", (request) => {
        const url = new URL(request.url),
          qa = globalThis.__shareStatisticsQa;
        qa.calls.push({
          accountId: a.id,
          path: url.pathname,
          method: request.method,
        });
        const response = (data) =>
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (url.pathname === "/account/info")
          return response({
            success: true,
            code: "OK",
            data: { user_id: `qa-${a.id}`, nickname: "统计验收本人" },
          });
        if (url.pathname === "/api/gettemplatevariable")
          return response({
            errno: 0,
            result: {
              uk: `qa-${a.id}`,
              bdstoken: "fixture-only",
              username: "本人",
            },
          });
        if (qa.failure && a.provider === "quark")
          return response({
            code: 500,
            status: 500,
            message: "测试中的网络失败",
          });
        if (url.pathname === "/share/record")
          return response({
            errno: 0,
            total: 1,
            list: [
              {
                shareId: "baidu-stat",
                title: "百度分享统计示例",
                shortlink: "https://pan.baidu.com/s/1baidu-stat",
                status: 0,
                vCnt: 109,
                tCnt: 5,
                dCnt: 0,
                ctime: 1792020000,
              },
            ],
          });
        if (url.pathname.endsWith("share/mypage/detail")) {
          const rows =
            a.provider === "quark"
              ? Array.from({ length: qa.phase ? 54 : 55 }, (_, i) => ({
                  share_id: `q-${i}`,
                  title:
                    i === 0
                      ? "从零开始的设计工具安装指南"
                      : i === 1
                        ? "安装课程 · 第一讲"
                        : `实用软件资料 ${String(i).padStart(2, "0")}`,
                  share_url: `https://pan.quark.cn/s/q-${i}?pwd=not-exported`,
                  status: 1,
                  click_pv:
                    i === 0
                      ? 120 + qa.phase * 10
                      : i === 2
                        ? undefined
                        : 55 - i,
                  save_pv: i === 0 ? 18 : 0,
                  download_pv: i === 0 ? 9 : 0,
                  created_at: 1792020000000,
                }))
              : [
                  {
                    share_id: "uc-stat",
                    title: "UC多端传输使用说明",
                    share_url: "https://drive.uc.cn/s/uc-stat",
                    status: 1,
                    click_pv: 18,
                    save_pv: 2,
                  },
                ];
          return response({
            code: 0,
            status: 200,
            data: { list: rows },
            metadata: { _total: rows.length },
          });
        }
        throw new Error(`测试未允许的请求：${url.pathname}`);
      });
    }
  }, accounts);
  const db = new DatabaseSync(join(dataPath, "panxu.db"));
  for (const a of accounts)
    db.prepare(
      "UPDATE accounts SET uid=?,status='connected',verified_at=? WHERE id=?",
    ).run(`qa-${a.id}`, new Date().toISOString(), a.id);
  const thunder = accounts.find((a) => a.provider === "xunlei");
  const snapshotAt = "2026-10-16T01:00:00.000Z";
  const metric = (value, precision = "exact") => ({ value, precision });
  db.prepare(
    "INSERT INTO share_statistics(account_id,share_id,owner_uid,data,synced_at) VALUES(?,?,?,?,?)",
  ).run(
    thunder.id,
    "thunder-stat",
    `qa-${thunder.id}`,
    JSON.stringify({
      shareId: "thunder-stat",
      title: "迅雷历史分享快照",
      url: "https://pan.xunlei.com/s/thunder-stat",
      state: "active",
      createdAt: snapshotAt,
      expiresAt: null,
      metrics: {
        views: metric(100, "at_least"),
        saves: metric(null, "unknown"),
        downloads: metric(null, "unknown"),
      },
    }),
    snapshotAt,
  );
  db.prepare(
    "INSERT INTO share_statistics_syncs(account_id,status,attempted_at,succeeded_at,share_count) VALUES(?,'success',?,?,1)",
  ).run(thunder.id, snapshotAt, snapshotAt);
  const quark = accounts.find((a) => a.provider === "quark");
  db.prepare(
    "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,created_at,updated_at) VALUES('stat-resource','设计工具安装资料','https://pan.quark.cn/s/source-stat','source-stat','quark','工具','[]','本人资料',?,?)",
  ).run(snapshotAt, snapshotAt);
  db.prepare(
    "INSERT INTO copies(id,resource_id,account_id,directory,status,share_id,share_url,share_owner_uid,created_at,updated_at) VALUES('stat-copy','stat-resource',?,'/盘序资源/设计工具','ready','q-0','https://pan.quark.cn/s/q-0',?,?,?)",
  ).run(quark.id, `qa-${quark.id}`, snapshotAt, snapshotAt);
  db.prepare(
    "INSERT INTO split_items(id,copy_id,file_id,file,ancestors,path,depth,status,share_id,share_url,owner_uid) VALUES('stat-child','stat-copy','file','{}','[]','课程 / 第一讲',1,'ready','q-1','https://pan.quark.cn/s/q-1',?)",
  ).run(`qa-${quark.id}`);
  await page.reload();
  await page.getByRole("heading", { name: "分享统计", exact: true }).waitFor();
  await page.getByRole("button", { name: "同步筛选账号", exact: true }).click();
  await page
    .getByText("同步完成：3个账号成功，1个失败，0个跳过。", { exact: true })
    .waitFor();
  await page
    .locator(".share-stats-summary .panel")
    .first()
    .getByText("58", { exact: true })
    .waitFor();
  await page
    .locator(".share-stats-table tbody tr")
    .first()
    .getByText("首次同步，无增量", { exact: true })
    .first()
    .waitFor();
  checks.push("真实IPC与三盘只读适配同步；迅雷认证失败保留历史快照");
  await page.screenshot({
    path: join(evidence, "02-share-statistics-overview.png"),
  });
  await chooseOption(page.getByLabel("统计网盘"), "baidu");
  const baiduRow = page
    .locator(".share-stats-table tbody tr")
    .filter({ hasText: "百度分享统计示例" });
  await baiduRow.waitFor();
  assert.equal(
    await baiduRow.locator("td").nth(2).locator("strong").textContent(),
    "109",
  );
  assert.equal(
    await baiduRow.locator("td").nth(4).locator("strong").textContent(),
    "0",
  );
  await chooseOption(page.getByLabel("统计网盘"), "uc");
  const ucRow = page
    .locator(".share-stats-table tbody tr")
    .filter({ hasText: "UC多端传输使用说明" });
  await ucRow.waitFor();
  assert.equal(
    await ucRow.locator("td").nth(4).locator("strong").textContent(),
    "未返回",
  );
  await chooseOption(page.getByLabel("统计网盘"), "xunlei");
  await page
    .locator(".share-stats-table")
    .getByText("100+", { exact: true })
    .waitFor();
  checks.push("四盘过滤与真实0、缺失指标、100+下限分别显示");
  await chooseOption(page.getByLabel("统计网盘"), "quark");
  await chooseOption(page.getByLabel("统计范围"), "managed");
  await page
    .locator(".share-stats-summary .panel")
    .first()
    .getByText("2", { exact: true })
    .waitFor();
  await page
    .getByRole("searchbox", { name: "搜索分享标题、链接或关联资料…" })
    .fill("第一讲");
  await page
    .locator(".share-stats-summary .panel")
    .first()
    .getByText("1", { exact: true })
    .waitFor();
  await page
    .locator(".share-stats-table")
    .getByText("项目资料：设计工具安装资料 · 拆分链接", { exact: true })
    .waitFor();
  checks.push("整份资料与拆分子链接关联、路径搜索");
  await page.getByRole("searchbox").fill("");
  await chooseOption(page.getByLabel("统计范围"), "all");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("第 2 / 2 页 · 共 55 个分享", { exact: true }).waitFor();
  const exportPath = join(evidence, "statistics-export.csv");
  await app.evaluate(({ dialog }, exportPath) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: exportPath,
    });
  }, exportPath);
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  await page
    .getByText("已导出当前筛选的全部分享统计。", { exact: true })
    .waitFor();
  const exported = await readFile(exportPath, "utf8");
  assert.equal(exported.split("\r\n").length, 57);
  assert.ok(!exported.includes("not-exported"));
  checks.push("分页与全部筛选结果CSV导出，无提取码");
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  db.prepare(
    "UPDATE share_statistics_syncs SET attempted_at='1970-01-01T00:00:00.000Z' WHERE account_id=?",
  ).run(quark.id);
  await app.evaluate(() => {
    globalThis.__shareStatisticsQa.phase = 1;
  });
  await page.getByRole("button", { name: "同步筛选账号", exact: true }).click();
  const topRow = page
    .locator(".share-stats-table tbody tr")
    .filter({ hasText: "从零开始的设计工具安装指南" });
  await topRow.getByText("较上次 +10", { exact: true }).waitFor();
  await page.locator(".main-content").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: join(evidence, "03-share-statistics-delta.png"),
  });
  await chooseOption(page.getByLabel("分享状态"), "missing");
  await page
    .locator(".share-stats-table")
    .getByText("已不在列表", { exact: true })
    .waitFor();
  checks.push("二次同步快照增量、消失分享历史保留");
  await chooseOption(page.getByLabel("分享状态"), "all");
  await page
    .locator(".share-stats-summary .panel")
    .first()
    .getByText("54", { exact: true })
    .waitFor();
  await page.setViewportSize({ width: 900, height: 800 });
  await page.screenshot({
    path: join(evidence, "04-share-statistics-compact.png"),
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(evidence, "05-share-statistics-mobile.png"),
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  const requests = await app.evaluate(
    () => globalThis.__shareStatisticsQa.calls,
  );
  assert.ok(requests.every((r) => r.method === "GET"));
  assert.ok(requests.every((r) => !r.path.startsWith("/s/")));
  checks.push(
    "900px与390px无页面溢出、无框架错误、控制台健康、未打开分享页或写远端数据",
  );
  db.close();
  console.log(JSON.stringify({ checks, errors, evidence, dataPath }, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: join(evidence, "failure.png"), fullPage: true })
    .catch(() => {});
  console.error(
    JSON.stringify({ checks, errors, evidence, dataPath }, null, 2),
  );
  throw error;
} finally {
  await app.close();
}
