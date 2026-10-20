import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

// Actual Squirrel.Mac install/relaunch, confined to signed disposable app copies.
// The only fixture changes are version, isolated app ID, data/cache paths and a
// boot marker. Network feed is loopback; real hash/signature checks stay enabled.
assert.equal(process.platform, "darwin", "此演练仅适用于 macOS。");
assert.equal(
  process.env.PANXU_NATIVE_UPDATE_TEST,
  "1",
  "请显式设置 PANXU_NATIVE_UPDATE_TEST=1。",
);
const require = createRequire(import.meta.url),
  asar = require("@electron/asar");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.version, "0.0.1", "此基线演练仅用于首次 0.0.1 发布。");
const root = resolve(process.env.PANXU_RELEASE_DIR ?? `release/${pkg.version}`);
const source = join(
  root,
  process.arch === "arm64" ? "mac-arm64" : "mac",
  "盘序.app",
);
execFileSync("codesign", ["--verify", "--deep", "--strict", source]);
const fixture = await mkdtemp(join(tmpdir(), "panxu-native-upgrade-"));
const data = join(fixture, "data"),
  boot = join(fixture, "boots.jsonl");
await mkdir(data);
const id = `com.panxu.studio.upgradeqa.${randomUUID().replaceAll("-", "")}`;
const baseline = join(fixture, "installed", "盘序.app");
const target = join(fixture, "target", "盘序.app");
const identity = process.env.CSC_NAME;
assert.ok(identity, "需要 CSC_NAME 指定可用的 Developer ID 签名身份。");
const bootstrap = `import {app as qaApp} from 'electron'; import {appendFileSync as qaAppend} from 'node:fs';
process.env.PANXU_DATA_DIR=${JSON.stringify(data)};
qaApp.whenReady().then(()=>qaAppend(${JSON.stringify(boot)}, JSON.stringify({version:qaApp.getVersion(),pid:process.pid,dataPath:qaApp.getPath('userData')})+${JSON.stringify("\n")}));
`;
for (const [path, version] of [
  [baseline, "0.0.0"],
  [target, pkg.version],
]) {
  await cp(source, path, { recursive: true, verbatimSymlinks: true });
  const contents = join(path, "Contents"),
    resources = join(contents, "Resources");
  const extracted = join(fixture, `asar-${version}`);
  asar.extractAll(join(resources, "app.asar"), extracted);
  const packagePath = join(extracted, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  manifest.version = version;
  await writeFile(packagePath, JSON.stringify(manifest));
  const main = join(extracted, "dist-desktop/main.js");
  await writeFile(main, bootstrap + (await readFile(main, "utf8")));
  await asar.createPackageWithOptions(extracted, join(resources, "app.asar"), {
    unpack: "node_modules/playwright-core/**",
  });
  await rm(extracted, { recursive: true, force: true });
  const plist = join(contents, "Info.plist");
  const metadata = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", plist], {
      encoding: "utf8",
    }),
  );
  if (metadata.ElectronAsarIntegrity?.["Resources/app.asar"]) {
    const hash = createHash("sha256")
      .update(asar.getRawHeader(join(resources, "app.asar")).headerString)
      .digest("hex");
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`,
      plist,
    ]);
  }
  for (const [key, value] of [
    ["CFBundleIdentifier", id],
    ["CFBundleVersion", version],
    ["CFBundleShortVersionString", version],
  ])
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :${key} ${value}`,
      plist,
    ]);
  const config = join(resources, "app-update.yml");
  await writeFile(
    config,
    (await readFile(config, "utf8")).replace(
      /^updaterCacheDirName:.*$/m,
      `updaterCacheDirName: ${id}`,
    ),
  );
  execFileSync("codesign", [
    "--force",
    "--sign",
    identity,
    "--timestamp",
    "--options",
    "runtime",
    "--preserve-metadata=entitlements,flags",
    path,
  ]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", path]);
}
const archive = join(fixture, `Panxu-0.0.1-mac-${process.arch}.zip`);
execFileSync("ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  target,
  archive,
]);
const bytes = await readFile(archive),
  sha512 = createHash("sha512").update(bytes).digest("base64");
const manifest = JSON.stringify({
  version: pkg.version,
  files: [{ url: archive.split("/").at(-1), size: bytes.length, sha512 }],
  path: archive.split("/").at(-1),
  sha512,
});
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/latest-mac.yml") {
    response.writeHead(200, { "Content-Type": "application/yaml" });
    response.end(manifest);
  } else if (path === "/" + archive.split("/").at(-1)) {
    response.writeHead(200, { "Content-Length": bytes.length });
    createReadStream(archive).pipe(response);
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let app;
const states = [];
async function until(read, predicate, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(300);
  }
  throw Error("真实更新演练超时。");
}
try {
  const env = { ...process.env, PANXU_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: join(baseline, "Contents/MacOS/盘序"),
    args: [],
    env,
    timeout: 45000,
  });
  const page = await app.firstWindow();
  await page.evaluate(async () => {
    await window.panxu.invoke("updater.configure", { autoCheck: false });
    await window.panxu.invoke("settings.save", {
      dailyAiBudgetMicros: 7654321,
    });
  });
  await app.evaluate(({ app, dialog }, feed) => {
    const { createRequire } = process.getBuiltinModule("node:module");
    const { autoUpdater } = createRequire(app.getAppPath() + "/package.json")(
      "electron-updater",
    );
    autoUpdater.setFeedURL({ provider: "generic", url: feed });
    autoUpdater.disableDifferentialDownload = true;
    // Approve only this disposable fixture's restart confirmation.
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  }, `http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => window.panxu.invoke("updater.check"));
  const state = () => page.evaluate(() => window.panxu.invoke("updater.state"));
  const available = await until(state, (s) =>
    ["available", "current", "error"].includes(s.phase),
  );
  states.push(available);
  assert.equal(available.phase, "available", JSON.stringify(available.error));
  assert.equal(available.currentVersion, "0.0.0");
  await page.evaluate(() => window.panxu.invoke("updater.download"));
  const downloaded = await until(state, (s) =>
    ["downloaded", "error"].includes(s.phase),
  );
  states.push(downloaded);
  assert.equal(
    downloaded.phase,
    "downloaded",
    JSON.stringify(downloaded.error),
  );
  await page
    .evaluate(() => window.panxu.invoke("updater.install"))
    .catch(() => {});
  const boots = async () =>
    (await readFile(boot, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const relaunched = await until(boots, (rows) =>
    rows.some((row) => row.version === pkg.version),
  );
  assert.ok(relaunched.every((row) => row.dataPath === data));
  // Inspect only the disposable database after ShipIt has actually relaunched.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(data, "panxu.db"));
  try {
    const rows = db.prepare("SELECT key,value FROM settings").all();
    assert.ok(
      rows.some(
        (row) =>
          row.key === "dailyAiBudgetMicros" &&
          JSON.parse(row.value) === 7654321,
      ),
    );
    const installation = JSON.parse(
      rows.find((row) => row.key === "updater.lastInstall").value,
    );
    assert.equal(installation.from, "0.0.0");
    assert.equal(installation.to, pkg.version);
    assert.ok(installation.backup.startsWith(data + "/updates/backups/"));
  } finally {
    db.close();
  }
  const result = {
    version: pkg.version,
    fixture,
    appId: id,
    states,
    boots: relaunched,
    actualNativeInstall: true,
    checks: [
      "同一 Developer ID 签名验证",
      "真实 ZIP 下载及 SHA512 校验",
      "Squirrel.Mac 安装及重启",
      "工作空间、设置与升级前快照保留",
    ],
    limitation:
      "隔离副本使用独立应用 ID 与本地更新源；正式 GitHub 发布源尚需发布后验证。",
  };
  await writeFile(
    join(fixture, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app?.close().catch(() => {});
  try {
    for (const line of (await readFile(boot, "utf8")).trim().split("\n")) {
      const { pid } = JSON.parse(line);
      try {
        const command = execFileSync(
          "ps",
          ["-p", String(pid), "-o", "command="],
          { encoding: "utf8" },
        );
        if (command.includes(baseline)) process.kill(pid, "SIGTERM");
      } catch {}
    }
  } catch {}
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
