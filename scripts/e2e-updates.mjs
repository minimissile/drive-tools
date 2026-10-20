import { _electron as electron } from "playwright-core";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// Browser plugin not available: use the project's Electron/Playwright workflow.
// Real renderer, preload and controller; only network/OS installer ports are fake.
const require = createRequire(import.meta.url);
const dataPath = await mkdtemp(join(tmpdir(), "panxu-update-e2e-"));
const evidence =
  process.env.PANXU_QA_DIR ??
  (await mkdtemp(join(tmpdir(), "panxu-update-evidence-")));
await mkdir(evidence, { recursive: true });
const bundle = join(dataPath, "update-controller.cjs");
await build({
  stdin: {
    contents:
      'export { UpdateManager } from "./core/updates"; export { AppError } from "./core/errors";',
    resolveDir: process.cwd(),
  },
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
});
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
  executablePath: require("electron"),
  args: [dev ? join(process.cwd(), "dist-dev") : process.cwd()],
  env,
  timeout: 45000,
});
const checks = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  assert.match(await page.title(), /盘序/);
  if (dev) assert.equal(new URL(page.url()).origin, "http://127.0.0.1:5173");
  else assert.match(page.url(), /dist\/index.html/);
  await page.evaluate(() =>
    window.panxu.invoke("updater.configure", { autoCheck: false }),
  );
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  await nav("连接与设置").click();
  await page.getByText("开发模式不检查或安装更新", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "检查更新", exact: true })
      .isDisabled(),
    true,
  );
  checks.push(
    "development build explains its disabled status without a network request",
  );
  await app.evaluate(async ({ ipcMain, BrowserWindow }, bundle) => {
    const { createRequire } = process.getBuiltinModule("node:module");
    const { UpdateManager, AppError } = createRequire(bundle)(bundle);
    const qa = (globalThis.__panxuUpdateQa = {
      checks: 0,
      downloads: 0,
      installs: 0,
      mode: "available",
      busy: false,
      opened: [],
      preferences: {},
      notes:
        "更清楚的更新进度\n任务完成后安全重启\n<img src=invalid onerror=alert(1)>",
    });
    const manager = new UpdateManager({
      version: "0.4.0",
      platform: process.platform,
      arch: process.arch,
      repository: "panxu-tests/releases",
      disabledReason: null,
      canInstall: true,
      preferences: { autoCheck: false },
      savePreferences(value) {
        qa.preferences = value;
      },
      log() {},
      changed(value) {
        BrowserWindow.getAllWindows()[0].webContents.send(
          "panxu:update",
          value,
        );
      },
      async prepareInstall() {
        if (qa.busy)
          throw new AppError(
            "UPDATE_TASKS_RUNNING",
            "仍有任务或操作正在进行，请完成或停止任务后再安装更新。",
          );
        return true;
      },
      installFailed() {},
      async openRelease(url) {
        qa.opened.push(url);
      },
      async openLogs() {},
      driver: {
        async check() {
          qa.checks++;
          if (qa.mode === "offline")
            throw new Error("net::ERR_CONNECTION_RESET");
          if (qa.mode === "current") return null;
          return {
            version: "0.5.0",
            releaseDate: "2026-10-15T12:00:00Z",
            releaseNotes: qa.notes,
          };
        },
        download() {
          qa.downloads++;
          return new Promise((resolve, reject) => {
            qa.resolve = resolve;
            qa.reject = reject;
          });
        },
        cancel() {
          qa.reject(new Error("cancelled"));
        },
        install() {
          qa.installs++;
        },
        listen(progress, error) {
          qa.progress = progress;
          qa.nativeError = error;
          return () => {};
        },
      },
    });
    // The fixture wraps the real IPC handler only inside this disposable process.
    const original = ipcMain._invokeHandlers.get("panxu:invoke");
    ipcMain.removeHandler("panxu:invoke");
    ipcMain.handle("panxu:invoke", async (event, request) => {
      if (!request.method.startsWith("updater."))
        return original(event, request);
      try {
        return {
          ok: true,
          value: await manager.invoke(request.method, request.args),
        };
      } catch (error) {
        return {
          ok: false,
          error: { code: error.code ?? "FAILED", message: error.message },
        };
      }
    });
    qa.manager = manager;
  }, bundle);
  await page.reload();
  await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.getByRole("heading", { name: "新版本 0.5.0" }).waitFor();
  assert.equal(await page.locator(".update-notes img").count(), 0);
  await app.evaluate(() => {
    globalThis.__panxuUpdateQa.notes =
      "更清楚的更新进度\n任务完成后安全重启\n保留本地工作空间与历史内容";
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page
    .getByRole("button", { name: "跳过此版本提醒", exact: true })
    .click();
  await page
    .getByRole("button", { name: "已跳过此版本提醒", exact: true })
    .waitFor();
  await nav("资源库").click();
  assert.equal(await page.locator(".update-banner").count(), 0);
  await nav("连接与设置").click();
  await page.getByLabel("自动检查新版本", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".update-options input").checked,
  );
  assert.equal(
    await app.evaluate(() => globalThis.__panxuUpdateQa.preferences.autoCheck),
    true,
  );
  checks.push(
    "check, safe notes, skip reminder and persistent auto-check preference",
  );
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await page.getByRole("progressbar", { name: "更新下载进度" }).waitFor();
  await app.evaluate(() =>
    globalThis.__panxuUpdateQa.progress({
      percent: 42,
      total: 100000000,
      transferred: 42000000,
      bytesPerSecond: 2000000,
    }),
  );
  await page.getByText("已下载 42%", { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 900),
  );
  await page.screenshot({ path: join(evidence, "updates-downloading.png") });
  await nav("资源库").click();
  await page.getByRole("button", { name: "查看更新", exact: true }).click();
  await page.getByRole("button", { name: "取消下载", exact: true }).click();
  await page.getByRole("button", { name: "下载更新", exact: true }).waitFor();
  checks.push("progress rendering, global banner navigation, cancellation");
  await app.evaluate(() => {
    globalThis.__panxuUpdateQa.mode = "offline";
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.getByText("UPDATE_NETWORK_FAILED", { exact: true }).waitFor();
  await app.evaluate(() => {
    globalThis.__panxuUpdateQa.mode = "available";
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await page.getByRole("progressbar").waitFor();
  await app.evaluate(() =>
    globalThis.__panxuUpdateQa.reject(new Error("sha512 checksum mismatch")),
  );
  await page.getByText("UPDATE_VERIFICATION_FAILED", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "重启并安装", exact: true }).count(),
    0,
  );
  checks.push("network failure retry and corrupt package installation block");
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await page.getByRole("progressbar").waitFor();
  await app.evaluate(() => globalThis.__panxuUpdateQa.resolve());
  await page.getByRole("button", { name: "重启并安装", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 760),
  );
  await page.screenshot({
    path: join(evidence, "updates-downloaded-compact.png"),
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await app.evaluate(() => {
    globalThis.__panxuUpdateQa.busy = true;
  });
  await page.getByRole("button", { name: "重启并安装", exact: true }).click();
  await page.getByText("UPDATE_TASKS_RUNNING", { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(() => globalThis.__panxuUpdateQa.installs),
    0,
  );
  await app.evaluate(() => {
    globalThis.__panxuUpdateQa.busy = false;
  });
  await page.getByRole("button", { name: "重启并安装", exact: true }).click();
  await page.getByText("正在准备安装。", { exact: false }).waitFor();
  assert.equal(
    await app.evaluate(() => globalThis.__panxuUpdateQa.installs),
    1,
  );
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  checks.push(
    "download completion, busy-task install block, explicit install dispatch, compact layout and clean console",
  );
  console.log(
    JSON.stringify(
      {
        checks,
        errors,
        evidence,
        environment:
          "Electron / Playwright, 1280×900 and 840×760; Browser plugin not available",
        installer: "simulated; no OS update or external requests",
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
