import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  pkg = require("../package.json"),
  update = require("./update-config.cjs").getUpdateConfig();
const arg = (key) => {
  const n = process.argv.indexOf(key);
  return n < 0 ? undefined : process.argv[n + 1];
};
const platform =
  arg("--platform") ?? (process.platform === "darwin" ? "mac" : "win");
const arch = arg("--arch"),
  strict = process.argv.includes("--strict");
if (
  !["mac", "win"].includes(platform) ||
  (arch && !["arm64", "x64"].includes(arch)) ||
  (arch && arch !== (platform === "mac" ? "arm64" : "x64"))
)
  throw new Error("发布目标无效。");
const targets = platform === "mac" ? ["darwin-arm64"] : ["win32-x64"];
const checks = [],
  blockers = [];
function check(condition, label) {
  (condition ? checks : blockers).push(label);
}
check(/^\d+\.\d+\.\d+$/.test(pkg.version), "稳定版本号");
check(!!update.repository, "公开更新仓库已配置");
check(existsSync(`docs/releases/${pkg.version}.md`), "当前版本说明");
for (const target of targets) {
  const dir = join("build/pansou", target),
    binary = join(
      dir,
      target.startsWith("win") ? "pansou-server.exe" : "pansou-server",
    );
  let verified = false;
  if (existsSync(binary) && existsSync(join(dir, "provenance.json"))) {
    const info = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"));
    verified =
      info.target === target &&
      info.binarySha256 ===
        createHash("sha256").update(readFileSync(binary)).digest("hex");
  }
  check(verified, `${target} PanSou 辅助程序及来源摘要`);
}
if (platform === "mac") {
  let ids = "";
  try {
    ids = execFileSync(
      "security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {}
  check(
    /Developer ID Application:/.test(ids),
    "Developer ID Application 签名身份",
  );
  const password = !!(
    process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID
  );
  const api = !!(
    process.env.APPLE_API_KEY &&
    process.env.APPLE_API_KEY_ID &&
    process.env.APPLE_API_ISSUER
  );
  const profile =
    process.env.APPLE_KEYCHAIN_PROFILE ||
    (!password && !api ? "panxu-notary" : undefined);
  check(
    !!profile || password || api,
    "Apple 公证凭据（钥匙串、API 或应用专用密码）",
  );
  if (profile) {
    try {
      execFileSync(
        "xcrun",
        [
          "notarytool",
          "history",
          "--keychain-profile",
          profile,
          "--output-format",
          "json",
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
      );
      checks.push("公证钥匙串与 Apple 连接验证");
    } catch {
      blockers.push("公证钥匙串与 Apple 连接验证失败");
    }
  }
} else {
  check(!!process.env.PANXU_WINDOWS_PUBLISHER, "Windows 签名发布者");
  check(
    !!process.env.CSC_LINK && !!process.env.CSC_KEY_PASSWORD,
    "Windows 代码签名凭据",
  );
}
console.log(
  JSON.stringify(
    {
      version: pkg.version,
      platform,
      targets,
      checks,
      blockers,
      ready: blockers.length === 0,
    },
    null,
    2,
  ),
);
if (strict && blockers.length) process.exitCode = 1;
