import { _electron as electron } from "playwright-core";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

// Launch only our own packaged fixture with disposable data; no live accounts.
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const root = resolve(process.env.PANXU_RELEASE_DIR ?? `release/${pkg.version}`);
const executable =
  process.env.PANXU_ELECTRON_PATH ??
  (process.platform === "darwin"
    ? join(
        root,
        process.arch === "arm64" ? "mac-arm64" : "mac",
        "盘序.app",
        "Contents",
        "MacOS",
        "盘序",
      )
    : join(root, "win-unpacked", "盘序.exe"));
assert.ok(existsSync(executable), "请先构建本机架构的候选包。");
const dataPath = await mkdtemp(join(tmpdir(), "panxu-production-"));
const evidence = resolve(
  process.env.PANXU_QA_DIR ??
    (await mkdtemp(join(tmpdir(), "panxu-production-evidence-"))),
);
await mkdir(evidence, { recursive: true });
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_URL: "http://127.0.0.1:1",
  PANXU_DEV_ROOT: process.cwd(),
};
delete env.ELECTRON_RUN_AS_NODE;
const errors = [],
  checks = [];
let app;
const launch = () =>
  electron.launch({
    executablePath: executable,
    args: [],
    env,
    timeout: 45000,
  });
try {
  app = await launch();
  let page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  const initial = await page.evaluate(async () => {
    const update = await window.panxu.invoke("updater.state");
    await window.panxu.invoke("updater.configure", { autoCheck: false });
    return { update, snapshot: await window.panxu.invoke("snapshot") };
  });
  assert.match(page.url(), /^file:.*\/dist\/index\.html/);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.openDevTools({
      mode: "detach",
    }),
  );
  const runtime = await app.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    name: app.getName(),
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
    maximized: BrowserWindow.getAllWindows()[0].isMaximized(),
    devToolsOpened:
      BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened(),
  }));
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.version, pkg.version);
  assert.equal(runtime.name, "盘序");
  assert.equal(runtime.userData, dataPath);
  assert.equal(runtime.sessionData, dataPath);
  assert.equal(runtime.devToolsOpened, false);
  assert.equal(runtime.maximized, true);
  assert.equal(initial.update.autoCheck, true);
  assert.equal(initial.update.currentVersion, pkg.version);
  assert.equal(initial.update.repository, "minimissile/drive-tools");
  assert.equal(initial.update.canInstall, true);
  assert.equal(initial.update.reason, null);
  assert.notEqual(initial.update.phase, "disabled");
  const s = initial.snapshot;
  for (const key of [
    "accounts",
    "resources",
    "jobs",
    "pools",
    "drafts",
    "bindings",
    "publications",
    "apiCalls",
  ])
    assert.equal(s[key].length, 0, `${key} 不得包含测试或个人记录`);
  assert.equal(s.settings.openrouterConfigured, false);
  assert.equal(s.settings.bitConfigured, false);
  assert.equal(s.settings.bitUrl, "");
  assert.equal(s.settings.model, "");
  assert.equal(s.settings.vaultPath, null);
  assert.equal(s.settings.previousWorkspace, false);
  assert.ok(s.plans.every((plan) => !plan.configured));
  assert.equal(s.dataPath, dataPath);
  checks.push(
    "全新用户无账号、密钥或业务记录；默认自动检查更新；生产忽略开发 URL、关闭 DevTools、默认最大化",
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "连接与设置", exact: true })
    .click();
  await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  for (const [width, height] of [
    [1440, 1000],
    [840, 900],
  ]) {
    const win = await app.browserWindow(page);
    await win.evaluate(
      (window, size) => {
        window.unmaximize();
        window.setContentSize(...size);
      },
      [width, height],
    );
    await page.screenshot({ path: join(evidence, `settings-${width}.png`) });
  }
  await page.evaluate(() =>
    window.panxu.invoke("settings.save", { dailyAiBudgetMicros: 1000000 }),
  );
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  const restored = await page.evaluate(async () => ({
    snapshot: await window.panxu.invoke("snapshot"),
    update: await window.panxu.invoke("updater.state"),
  }));
  assert.equal(restored.snapshot.settings.dailyAiBudgetMicros, 1000000);
  assert.equal(restored.update.autoCheck, false);
  assert.equal(restored.snapshot.dataPath, dataPath);
  checks.push(
    "重启后本地设置和工作空间保持；全程未执行计费查询、转存、建链或发布",
  );
  assert.deepEqual(errors, []);
  const result = {
    version: pkg.version,
    runtime,
    checks,
    evidence,
    errors,
    nativeUpgradeTested: false,
  };
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app?.close();
}
