import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { valid, prerelease } from "semver";
import updateConfig from "./update-config.cjs";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.ok(
  valid(pkg.version) === pkg.version &&
    !prerelease(pkg.version) &&
    !pkg.version.includes("+"),
  "正式发布必须使用不带前后缀的稳定 SemVer 版本号",
);
assert.equal(
  process.env.GITHUB_REF,
  `refs/tags/v${pkg.version}`,
  "Git 标签必须与 package.json 版本完全一致",
);
assert.equal(
  process.env.PANXU_REQUIRE_SIGNING,
  "1",
  "正式发布必须启用签名检查",
);
assert.ok(updateConfig.getUpdateConfig().repository, "缺少公开更新仓库");
for (const key of ["CSC_LINK", "CSC_KEY_PASSWORD"])
  assert.ok(process.env[key], `缺少发布密钥 ${key}`);
if (process.platform === "darwin")
  for (const key of [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ])
    assert.ok(process.env[key], `缺少公证凭据 ${key}`);
if (process.platform === "win32")
  assert.ok(process.env.PANXU_WINDOWS_PUBLISHER, "缺少 Windows 签名主体");
await readFile(`docs/releases/${pkg.version}.md`, "utf8");
console.log(`发布预检通过：v${pkg.version}，签名强制启用。`);
