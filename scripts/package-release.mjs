import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import policy from "./release-policy.cjs";
const require = createRequire(import.meta.url),
  arg = (key) => {
    const i = process.argv.indexOf(key);
    return i < 0 ? undefined : process.argv[i + 1];
  };
const platform = arg("--platform"),
  arch = arg("--arch");
const targets = policy.getReleasePolicy();
if (
  !["mac", "win"].includes(platform) ||
  (arch && !["arm64", "x64"].includes(arch)) ||
  (arch && arch !== (platform === "mac" ? "arm64" : "x64"))
)
  throw Error("发布目标无效。");
if (!targets[platform])
  throw Error("当前发行计划未启用此平台，请先检查 release.config.json。");
if (platform === "mac" && process.platform !== "darwin")
  throw Error("macOS 正式签名需要在 macOS 上执行。");
const env = { ...process.env, PANXU_REQUIRE_SIGNING: "1" };
if (
  platform === "mac" &&
  !env.APPLE_KEYCHAIN_PROFILE &&
  !env.APPLE_APP_SPECIFIC_PASSWORD &&
  !env.APPLE_API_KEY
)
  env.APPLE_KEYCHAIN_PROFILE = "panxu-notary";
const run = (file, args) => {
  const r = spawnSync(file, args, { env, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run(process.execPath, [
  "scripts/release-preflight.mjs",
  "--strict",
  "--platform",
  platform,
  ...(arch ? ["--arch", arch] : []),
]);
run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]);
run(process.execPath, ["node_modules/vite/bin/vite.js", "build"]);
run(process.execPath, ["scripts/build-desktop.mjs"]);
run(process.execPath, [
  require.resolve("electron-builder/cli.js"),
  "--config",
  "electron-builder.config.cjs",
  `--${platform}`,
  ...(platform === "mac" ? ["dmg", "zip"] : ["nsis"]),
  ...(arch ? [`--${arch}`] : platform === "mac" ? ["--arm64"] : ["--x64"]),
  "--publish",
  "never",
]);
run(process.execPath, ["scripts/verify-release.mjs"]);
run(process.execPath, [
  "scripts/verify-updates.mjs",
  ...(arch ? [`--arch=${arch}`] : []),
]);
