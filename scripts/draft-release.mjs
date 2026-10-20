import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import updateConfig from "./update-config.cjs";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const repository = updateConfig.getUpdateConfig().repository;
assert.ok(repository, "缺少更新仓库");
assert.equal(
  process.env.GITHUB_REF,
  `refs/tags/v${pkg.version}`,
  "标签与版本不一致",
);
const root = resolve(process.env.PANXU_RELEASE_DIR ?? `release/${pkg.version}`);
execFileSync(process.execPath, ["scripts/verify-updates.mjs", "--all"], {
  stdio: "inherit",
});
const gh = (...args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const metadata = JSON.parse(gh("api", `repos/${repository}`));
assert.equal(metadata.private, false, "更新仓库必须公开；客户端不携带访问令牌");
const tag = `v${pkg.version}`;
const existing = spawnSync(
  "gh",
  ["release", "view", tag, "--repo", repository, "--json", "isDraft,tagName"],
  { encoding: "utf8" },
);
if (existing.status === 0)
  assert.equal(
    JSON.parse(existing.stdout).isDraft,
    true,
    "禁止覆盖已公开发布的版本；请递增版本号",
  );
else {
  assert.match(
    existing.stderr,
    /not found|404/i,
    "无法读取发布状态，请检查令牌和仓库权限",
  );
  gh(
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--draft",
    "--title",
    `盘序 ${pkg.version}`,
    "--notes-file",
    `docs/releases/${pkg.version}.md`,
  );
}
const assets = (await readdir(root)).filter(
  (name) =>
    /^Panxu-Studio-[a-zA-Z0-9_.-]+\.(?:dmg|exe|zip)(?:\.blockmap)?$/.test(
      name,
    ) || ["latest.yml", "latest-mac.yml", "SHA256SUMS.txt"].includes(name),
);
gh(
  "release",
  "upload",
  tag,
  "--repo",
  repository,
  "--clobber",
  ...assets.map((name) => join(root, name)),
);
// Confirm every local asset reached the draft before a maintainer publishes it.
const remote = JSON.parse(
  gh("release", "view", tag, "--repo", repository, "--json", "assets,isDraft"),
);
assert.equal(remote.isDraft, true);
for (const name of assets)
  assert.ok(
    remote.assets.some((asset) => asset.name === name),
    `远端缺少 ${name}`,
  );
console.log(
  `更新文件已完整上传到草稿：https://github.com/${repository}/releases。验收后在 GitHub 发布草稿，客户端才会看到更新。`,
);
