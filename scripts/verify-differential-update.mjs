import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { load } from "js-yaml";

// Download-chain integration test using published bytes, not newly built apps.
// Real Mac download selection, GitHub provider paths, blockmaps, Range planner,
// reconstruction, cache and SHA512 validation. Only the app environment, HTTP
// origin/transport and final native installer handoff are isolated.
// No Electron desktop instance, user database, signed bundle or release is changed.
const require = createRequire(import.meta.url);
const { AppUpdater } = require("electron-updater/out/AppUpdater");
const { MacUpdater } = require("electron-updater/out/MacUpdater");
const {
  GitHubProvider,
} = require("electron-updater/out/providers/GitHubProvider");
const {
  ElectronHttpExecutor,
} = require("electron-updater/out/electronHttpExecutor");
const { HttpExecutor } = require("builder-util-runtime");
assert.equal(process.platform, "darwin", "仅适用于 macOS 下载链。");
assert.equal(process.arch, "arm64", "当前发行包仅有 ARM64。");
const oldVersion = process.argv[2] ?? "0.0.1";
const newVersion = process.argv[3] ?? "0.0.2";
for (const version of [oldVersion, newVersion])
  assert.match(version, /^\d+\.\d+\.\d+$/);
const assets = (version) => ({
  zip: resolve(`release/${version}/Panxu-Studio-${version}-mac-arm64.zip`),
  blockmap: resolve(
    `release/${version}/Panxu-Studio-${version}-mac-arm64.zip.blockmap`,
  ),
  manifest: resolve(`release/${version}/latest-mac.yml`),
});
const old = assets(oldVersion),
  target = assets(newVersion);
async function digest(path) {
  const hash = createHash("sha512");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("base64");
}
const manifest = await readFile(target.manifest);
const info = load(manifest.toString());
assert.equal(info.version, newVersion);
const zipInfo = info.files.find((file) => file.url === basename(target.zip));
assert.ok(zipInfo, "清单缺少目标 ZIP。");
assert.equal((await stat(target.zip)).size, zipInfo.size);
assert.equal(await digest(target.zip), zipInfo.sha512);
const oldInfo = load(await readFile(old.manifest, "utf8"));
const oldZipInfo = oldInfo.files.find((file) => file.url === basename(old.zip));
assert.ok(oldZipInfo, "旧版清单缺少 ZIP。");
assert.equal(await digest(old.zip), oldZipInfo.sha512);
const work = await mkdtemp(join(tmpdir(), "panxu-differential-"));
const evidence = resolve(
  process.env.PANXU_QA_DIR ?? `release-evidence/${newVersion}/differential`,
);
await mkdir(evidence, { recursive: true });
const downloadBase = "/minimissile/drive-tools/releases/download";
const routes = new Map([
  [`${downloadBase}/v${oldVersion}/${basename(old.blockmap)}`, old.blockmap],
  [
    `${downloadBase}/v${newVersion}/${basename(target.blockmap)}`,
    target.blockmap,
  ],
  [`${downloadBase}/v${newVersion}/${basename(target.zip)}`, target.zip],
]);
let current;
const failures = [];
const server = createServer((req, res) => {
  void serve(req, res).catch((error) => {
    failures.push(error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
async function serve(req, res) {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  const metric = current.metrics;
  metric.paths.push(path);
  if (path.endsWith("/releases.atom")) {
    res.writeHead(200, { "Content-Type": "application/atom+xml" });
    res.end(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>v${newVersion}</id><title>Panxu ${newVersion}</title><link href="https://github.com/minimissile/drive-tools/releases/tag/v${newVersion}"/><content>Published release fixture</content></entry></feed>`,
    );
    return;
  }
  if (
    [
      "/repos/minimissile/drive-tools/releases/latest",
      "/minimissile/drive-tools/releases/latest",
    ].includes(path)
  ) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: `v${newVersion}` }));
    return;
  }
  if (path === `${downloadBase}/v${newVersion}/latest-mac.yml`) {
    res.writeHead(200, { "Content-Type": "application/yaml" });
    res.end(manifest);
    return;
  }
  const file = routes.get(path);
  if (
    !file ||
    (current.mode === "missing-old-blockmap" && file === old.blockmap)
  ) {
    metric.notFound.push(path);
    res.writeHead(404);
    res.end();
    return;
  }
  const isZip = file === target.zip;
  const size = (await stat(file)).size;
  let start = 0,
    end = size - 1;
  if (isZip && req.headers.range) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    assert.ok(match, "应使用 GitHub 相同的单区间请求。");
    start = Number(match[1]);
    end = Number(match[2]);
    assert.ok(start >= 0 && end >= start && end < size);
    metric.rangeRequests++;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
  } else {
    if (isZip) metric.fullZipRequests++;
    res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes" });
  }
  let flip =
    isZip &&
    ((current.mode === "corrupt-range" &&
      !!req.headers.range &&
      !metric.corrupted) ||
      (current.mode === "corrupt-full" && !req.headers.range));
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      if (isZip) metric.zipBytes += chunk.length;
      else metric.blockmapBytes += chunk.length;
      if (flip && chunk.length) {
        chunk = Buffer.from(chunk);
        chunk[0] ^= 1;
        flip = false;
        metric.corrupted = true;
      }
      callback(null, chunk);
    },
  });
  const stream = createReadStream(file, { start, end });
  stream.on("error", (error) => res.destroy(error));
  meter.on("error", (error) => res.destroy(error));
  res.on("close", () => stream.destroy());
  stream.pipe(meter).pipe(res);
}
class LoopbackHttpExecutor extends ElectronHttpExecutor {
  createRequest(options, callback) {
    assert.equal(options.hostname, "127.0.0.1", "隔离测试禁止访问外部服务。");
    assert.equal(options.protocol, "http:");
    // Electron owns its connection pool. Avoid Node's global keep-alive socket
    // accumulating HttpExecutor timeout hooks across many fixture Range requests.
    return httpRequest({ ...options, agent: false }, callback);
  }
  addRedirectHandlers(...args) {
    return HttpExecutor.prototype.addRedirectHandlers.call(this, ...args);
  }
}
const report = {
  oldVersion,
  newVersion,
  fullZipBytes: zipInfo.size,
  updaterVersion: require("electron-updater/package.json").version,
  generatedAt: new Date().toISOString(),
  scenarios: [],
  scope:
    "Real Mac download/reconstruction/hash/fallback chain with published artifacts and a loopback HTTP origin; no native installation or GUI",
  realGitHubDownload: false,
};
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}/`;
  for (const mode of [
    "differential",
    "no-cache",
    "missing-old-blockmap",
    "corrupt-range",
    "corrupt-full",
  ]) {
    const scenario = join(work, mode);
    const cache = join(scenario, "cache", "download-chain");
    const data = join(scenario, "data");
    await mkdir(cache, { recursive: true });
    await mkdir(data, { recursive: true });
    const config = join(scenario, "app-update.yml");
    await writeFile(config, "updaterCacheDirName: download-chain\n");
    if (!["no-cache", "corrupt-full"].includes(mode))
      await copyFile(
        old.zip,
        join(cache, "update.zip"),
        constants.COPYFILE_FICLONE,
      );
    current = {
      mode,
      metrics: {
        paths: [],
        notFound: [],
        rangeRequests: 0,
        fullZipRequests: 0,
        zipBytes: 0,
        blockmapBytes: 0,
        corrupted: false,
      },
    };
    const messages = [],
      errors = [];
    const updater = new AppUpdater(null, {
      version: oldVersion,
      name: "Panxu Differential QA",
      isPackaged: true,
      userDataPath: data,
      baseCachePath: join(scenario, "cache"),
      appUpdateConfigPath: config,
      whenReady: async () => {},
      quit() {
        throw new Error("禁止退出或安装应用。");
      },
    });
    // Run the unmodified Mac download method without constructing Electron's native updater.
    Object.setPrototypeOf(updater, MacUpdater.prototype);
    updater.httpExecutor = new LoopbackHttpExecutor(null);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.logger = Object.fromEntries(
      ["info", "warn", "error", "debug"].map((level) => [
        level,
        (text) => {
          // Keep status evidence, not signed URLs, fixture paths, or full chunk plans.
          if (
            typeof text === "string" &&
            /Full:|fallback|falling back|checksum|sha512|New version/i.test(
              text,
            )
          )
            messages.push({
              level,
              text: text
                .replaceAll(work, "<temporary>")
                .replaceAll(origin, "<loopback>/"),
            });
        },
      ]),
    );
    updater.on("error", (error) => errors.push(error.code ?? error.message));
    updater.on("download-progress", () => {});
    let handedOff = null;
    updater.updateDownloaded = async (_fileInfo, event) => {
      // Stop precisely before Squirrel.Mac; downloaded bytes remain real and verified.
      handedOff = event.downloadedFile;
      updater.dispatchUpdateDownloaded(event);
      return [];
    };
    const provider = new GitHubProvider(
      { provider: "github", owner: "minimissile", repo: "drive-tools" },
      updater,
      { executor: updater.httpExecutor, platform: "darwin" },
    );
    provider.baseUrl = new URL(origin);
    provider.baseApiUrl = new URL(origin);
    updater.clientPromise = Promise.resolve(provider);
    assert.equal(updater.disableDifferentialDownload, false);
    assert.equal(
      updater._testOnlyOptions,
      null,
      "不得启用会改变回退行为的上游测试开关。",
    );
    const checked = await updater.checkForUpdates();
    assert.equal(checked.isUpdateAvailable, true);
    assert.equal(checked.updateInfo.version, newVersion);
    let caught;
    try {
      await updater.downloadUpdate();
    } catch (error) {
      caught = error;
    }
    const metric = current.metrics;
    if (mode === "corrupt-full") {
      assert.ok(caught, "损坏的全量包必须失败。");
      assert.equal(handedOff, null);
      assert.match(caught.message, /sha512|checksum/i);
      assert.equal(metric.fullZipRequests, 1);
    } else {
      assert.ifError(caught);
      assert.ok(handedOff?.startsWith(cache + "/"));
      assert.equal(await digest(handedOff), zipInfo.sha512);
      assert.equal(await digest(join(cache, "update.zip")), zipInfo.sha512);
      if (mode === "differential") {
        assert.ok(metric.rangeRequests > 0, "必须真实发生 Range 请求。");
        assert.equal(metric.fullZipRequests, 0, "成功案不得隐藏回退全量。");
        assert.ok(metric.zipBytes > 0 && metric.zipBytes < zipInfo.size);
        assert.ok(
          metric.paths.includes(
            `${downloadBase}/v${oldVersion}/${basename(old.blockmap)}`,
          ),
        );
      } else {
        assert.equal(metric.fullZipRequests, 1);
        if (mode === "no-cache") assert.equal(metric.rangeRequests, 0);
        else {
          assert.ok(
            messages.some((m) => /fallback to full download/i.test(m.text)),
          );
          if (mode === "missing-old-blockmap")
            assert.ok(metric.notFound.some((p) => p.includes(oldVersion)));
          if (mode === "corrupt-range")
            assert.ok(metric.rangeRequests > 0 && metric.corrupted);
        }
      }
    }
    const result = {
      mode,
      passed: true,
      zipBytes: metric.zipBytes,
      blockmapBytes: metric.blockmapBytes,
      rangeRequests: metric.rangeRequests,
      fullZipRequests: metric.fullZipRequests,
      sha512Verified: mode !== "corrupt-full",
      corruptedPackageRejected: mode === "corrupt-full",
      savedPercent:
        mode === "differential"
          ? Number((100 * (1 - metric.zipBytes / zipInfo.size)).toFixed(2))
          : null,
      nativeInstallInvoked: false,
      messages,
      errors,
    };
    report.scenarios.push(result);
    console.log(
      JSON.stringify({
        mode,
        passed: result.passed,
        zipBytes: result.zipBytes,
        blockmapBytes: result.blockmapBytes,
        rangeRequests: result.rangeRequests,
        fullZipRequests: result.fullZipRequests,
        savedPercent: result.savedPercent,
        sha512Verified: result.sha512Verified,
        corruptedPackageRejected: result.corruptedPackageRejected,
      }),
    );
    updater.removeAllListeners();
    await rm(scenario, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], "隔离 HTTP 服务发生异常。");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = { code: error.code, message: error.message };
  throw error;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(work, { recursive: true, force: true });
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  `差分下载链验证完成：${report.scenarios.length} 项，证据 ${join(evidence, "result.json")}`,
);
