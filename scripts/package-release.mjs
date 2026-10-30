import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gt, valid } from "semver";
import policy from "./release-policy.cjs";
import {
  canonicalDirectory,
  macBaselinePaths,
  verifyMacBaseline,
} from "./release-baseline.mjs";

const { values } = parseArgs({
  options: {
    platform: { type: "string" },
    arch: { type: "string" },
    mode: { type: "string", default: "full" },
    from: { type: "string" },
    "from-dir": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
});
if (values.help) {
  console.log(`用法：
  node scripts/package-release.mjs --mode full [--platform mac|win] [--arch arm64|x64]
  node scripts/package-release.mjs --mode differential --from <旧版本> [--from-dir <旧版产物目录>]
  追加 --dry-run 仅查看计划，不执行编译、签名、网络请求、测试或文件写入。

两种模式均生成完整签名安装包、更新包和 blockmap，不上传或提升版本。
需要自动升版和准备说明时，使用 npm run release:full 或 npm run release:differential。
差分准备当前支持 macOS ARM64，要求旧版本低于 package.json 当前版本。
默认平台为当前系统；Windows 仍需在 release.config.json 中启用并配置签名。
差分准备先检查旧 ZIP、清单、blockmap；不会自动运行差分演练。
客户端满足缓存与网络条件时优先差分，失败回退全量；full 不强制客户端下载方式。
PANXU_RELEASE_DIR 可指定本次产物目录。`);
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const stable = (version) =>
  typeof version === "string" &&
  valid(version) === version &&
  /^\d+\.\d+\.\d+$/.test(version);
assert.ok(stable(pkg.version), "当前版本必须是稳定 x.y.z 版本号。");
assert.equal(lock.version, pkg.version, "package-lock.json 版本未同步。");
assert.equal(
  lock.packages?.[""]?.version,
  pkg.version,
  "锁文件根包版本未同步。",
);
const platform =
  values.platform ?? { darwin: "mac", win32: "win" }[process.platform];
assert.ok(["mac", "win"].includes(platform), "请指定 --platform mac 或 win。");
const targets = policy.getReleasePolicy();
assert.ok(
  targets[platform],
  "当前发行计划未启用此平台，请检查 release.config.json。",
);
const arch = values.arch ?? targets[platform][0];
assert.ok(targets[platform].includes(arch), "发行计划不支持指定架构。");
const mode = values.mode;
assert.ok(
  ["full", "differential"].includes(mode),
  "--mode 仅支持 full 或 differential。",
);
assert.ok(
  mode === "differential" || (!values.from && !values["from-dir"]),
  "--from 和 --from-dir 仅用于 differential 模式。",
);
let baseline;
if (mode === "differential") {
  assert.ok(
    platform === "mac" && arch === "arm64",
    "差分准备当前仅支持 macOS ARM64。",
  );
  assert.ok(stable(values.from), "差分准备必须指定 --from <稳定旧版本>。");
  assert.ok(
    gt(pkg.version, values.from),
    "旧版本必须低于 package.json 当前版本。",
  );
  const directory = resolve(values["from-dir"] ?? `release/${values.from}`);
  baseline = macBaselinePaths(values.from, directory);
}
const output = resolve(
  process.env.PANXU_RELEASE_DIR || `release/${pkg.version}`,
);

assert.ok(
  !baseline ||
    canonicalDirectory(output) !== canonicalDirectory(baseline.directory),
  "新版输出目录不能覆盖旧版差分基线。",
);
if (values["dry-run"]) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        version: pkg.version,
        platform,
        arch,
        mode,
        output,
        baseline: baseline ?? null,
        stages: [
          ...(baseline ? ["校验旧版本清单、ZIP SHA512 与 blockmap"] : []),
          "签名及公证预检",
          "编译和生成完整签名安装包、更新包及 blockmap",
          "校验包内依赖、签名、公证与更新产物",
        ],
        note: "仅列出计划；尚未校验基线、凭据或产物，不运行测试，不上传。",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
assert.equal(
  process.platform,
  platform === "mac" ? "darwin" : "win32",
  "正式签名打包必须在对应的 macOS 或 Windows 系统执行。",
);
assert.ok(
  !lstatSync("node_modules").isSymbolicLink(),
  "正式打包不能使用符号链接 node_modules；请通过 npm ci 准备真实依赖目录。",
);

if (baseline) {
  await verifyMacBaseline(baseline);
  console.log(
    `差分基线清单、ZIP 摘要和 blockmap 结构检查通过：${baseline.version}。未执行下载演练。`,
  );
}

const env = {
  ...process.env,
  PANXU_REQUIRE_SIGNING: "1",
  PANXU_RELEASE_DIR: output,
};
if (
  platform === "mac" &&
  !env.APPLE_KEYCHAIN_PROFILE &&
  !env.APPLE_APP_SPECIFIC_PASSWORD &&
  !env.APPLE_API_KEY
)
  env.APPLE_KEYCHAIN_PROFILE = "panxu-notary";
const run = (file, args) => {
  const result = spawnSync(file, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(process.execPath, [
  "scripts/release-preflight.mjs",
  "--strict",
  "--platform",
  platform,
  "--arch",
  arch,
]);
run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]);
run(process.execPath, ["node_modules/vite/bin/vite.js", "build"]);
run(process.execPath, ["scripts/build-desktop.mjs"]);
run(process.execPath, [
  require.resolve("electron-builder/cli.js"),
  "--config",
  "electron-builder.config.cjs",
  `--config.directories.output=${output}`,
  `--${platform}`,
  ...(platform === "mac" ? ["dmg", "zip"] : ["nsis"]),
  `--${arch}`,
  "--publish",
  "never",
]);
run(process.execPath, ["scripts/verify-release.mjs"]);
run(process.execPath, ["scripts/verify-updates.mjs", `--arch=${arch}`]);
console.log(
  `更新产物已准备：${output}。完整签名包与 blockmap 共用同一版本；客户端按条件差分或回退全量。`,
);
console.log(
  "构建步骤完成。release:full / release:differential 会继续自动推送和正式发布；固定版本构建不会自行公开。",
);
