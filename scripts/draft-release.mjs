import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { valid } from "semver";
import updateConfig from "./update-config.cjs";

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});
if (values.help) {
  console.log(`CI 固定版本入口：node scripts/draft-release.mjs
本地自动从 package.json 识别版本和 v<版本> 标签，无须设置 GITHUB_REF。
CI 仍要求 GITHUB_REF 与版本一致；本地若显式设置该变量，也会检查一致性。
先准备所有已启用平台的签名产物，并将对应源码与标签推送到发行仓库。
上传前检查远端标签、标签中的版本及全部更新附件，禁止覆盖已公开版本。
此命令仅上传草稿，不自动提交、创建标签、推送代码或正式公开草稿。
追加 --dry-run 仅查看本地计划，不联网、不核验产物、不写文件或上传。`);
  process.exit(0);
}

const project = resolve(import.meta.dirname, "..");
process.chdir(project);

async function main() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(
    typeof pkg.version === "string" &&
      valid(pkg.version) === pkg.version &&
      /^\d+\.\d+\.\d+$/.test(pkg.version),
    "发布必须使用稳定 x.y.z 版本号。",
  );
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  assert.ok(
    lock.version === pkg.version &&
      lock.packages?.[""]?.version === pkg.version,
    "package.json 与 package-lock.json 的版本不一致，请先完成版本同步。",
  );
  const repository = updateConfig.getUpdateConfig().repository;
  assert.ok(repository, "缺少更新仓库");
  const tag = `v${pkg.version}`;
  if (
    process.env.GITHUB_REF !== undefined ||
    process.env.GITHUB_ACTIONS === "true"
  )
    assert.equal(
      process.env.GITHUB_REF,
      `refs/tags/${tag}`,
      `GITHUB_REF 必须为 refs/tags/${tag}；本地点击运行可不设置该变量。`,
    );
  const root = resolve(
    process.env.PANXU_RELEASE_DIR || `release/${pkg.version}`,
  );
  const notes = join(project, "docs", "releases", `${pkg.version}.md`);
  if (values["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          version: pkg.version,
          tag,
          refSource: process.env.GITHUB_REF ? "GITHUB_REF" : "package.json",
          repository,
          output: root,
          notes,
          stages: [
            "检查公开仓库、同名远端标签及标签中的版本",
            "拒绝覆盖已公开版本，校验全部启用平台的更新附件",
            "创建或更新 GitHub 草稿并上传附件",
          ],
          note: "仅显示计划，未验证远端标签或产物；不联网、不写文件、不提交或上传。",
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`准备上传草稿：${tag} → ${repository}`);
  assert.ok((await readFile(notes, "utf8")).trim(), "版本说明不能为空。");
  const gh = (...args) => {
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error)
      throw new Error(
        "无法运行 GitHub CLI，请先安装 gh 并完成 gh auth login。",
      );
    assert.equal(
      result.status,
      0,
      result.stderr.trim() ||
        "GitHub CLI 执行失败，请检查网络、登录及仓库权限。",
    );
    return result.stdout;
  };
  const metadata = JSON.parse(gh("api", `repos/${repository}`));
  assert.equal(
    metadata.private,
    false,
    "更新仓库必须公开；客户端不携带访问令牌",
  );
  const remoteTag = spawnSync(
    "gh",
    ["api", `repos/${repository}/git/ref/tags/${tag}`],
    { encoding: "utf8" },
  );
  if (remoteTag.error) throw remoteTag.error;
  if (remoteTag.status !== 0) {
    if (/HTTP 404|\(404\)/i.test(remoteTag.stderr))
      throw new Error(
        `发行仓库尚未找到 ${tag} 标签。请先提交 ${pkg.version} 的版本文件、说明及对应源码，再对该提交创建并推送标签：\n` +
          `  git tag ${tag} <版本提交SHA>\n` +
          `  git push origin refs/tags/${tag}\n` +
          `origin 须指向 ${repository}；完成后重新点击 release:draft，无须重新升版或打包。`,
      );
    throw new Error(
      remoteTag.stderr.trim() ||
        "读取远端标签失败，请检查网络、登录及仓库权限。",
    );
  }
  const remotePackage = JSON.parse(
    Buffer.from(
      gh(
        "api",
        `repos/${repository}/contents/package.json?ref=${tag}`,
        "--jq",
        ".content",
      ),
      "base64",
    ).toString("utf8"),
  );
  assert.equal(
    remotePackage.version,
    pkg.version,
    `${tag} 对应源码的版本不一致，请检查标签，禁止将旧源码绑定到新安装包。`,
  );
  const existing = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", repository, "--json", "isDraft,tagName"],
    { encoding: "utf8" },
  );
  if (existing.error) throw existing.error;
  if (existing.status === 0)
    assert.equal(
      JSON.parse(existing.stdout).isDraft,
      true,
      "禁止覆盖已公开发布的版本；请递增版本号",
    );
  else
    assert.match(
      existing.stderr,
      /release not found|HTTP 404|\(404\)/i,
      "无法读取发布状态，请检查令牌和仓库权限",
    );

  execFileSync(process.execPath, ["scripts/verify-updates.mjs", "--all"], {
    stdio: "inherit",
    env: { ...process.env, PANXU_RELEASE_DIR: root },
  });
  if (existing.status !== 0) {
    gh(
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--draft",
      "--verify-tag",
      "--title",
      `盘序 ${pkg.version}`,
      "--notes-file",
      notes,
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
    gh(
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "assets,isDraft",
    ),
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
}

try {
  await main();
} catch (error) {
  console.error(`草稿上传未完成：${error.message}`);
  process.exitCode = 1;
}
