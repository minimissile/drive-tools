import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gt, valid } from "semver";

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function publishRelease({
  run,
  repository,
  version,
  output,
  notes,
  env,
  publish = true,
}) {
  const tag = `v${version}`;
  const gh = async (...args) =>
    (await run("gh", args, { capture: true, env })).stdout;
  let releaseId;
  const getRelease = async () => {
    const result = await run(
      "gh",
      [
        "api",
        releaseId
          ? `repos/${repository}/releases/${releaseId}`
          : `repos/${repository}/releases/tags/${tag}`,
      ],
      { capture: true, optional: true, env },
    );
    if (result.code === 0) {
      const found = JSON.parse(result.stdout);
      releaseId = found.id;
      return found;
    }
    if (/HTTP 404|\(404\)/i.test(result.stderr)) {
      // GitHub's tag endpoint omits unpublished drafts. Discover them through
      // the authenticated list, then use the immutable release ID for reads.
      const pages = JSON.parse(
        await gh(
          "api",
          "--paginate",
          "--slurp",
          `repos/${repository}/releases?per_page=100`,
        ),
      );
      const matches = pages.flat().filter((entry) => entry.tag_name === tag);
      assert.ok(
        matches.length <= 1,
        "同版本存在多个草稿，无法确定应续跑的发行记录。",
      );
      if (!matches.length) return null;
      releaseId = matches[0].id;
      return matches[0];
    }
    throw new Error(result.stderr || "无法读取 GitHub 发行状态。");
  };
  const sums = new Map(
    (await readFile(join(output, "SHA256SUMS.txt"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const match = line.match(/^([a-f0-9]{64})  ([a-zA-Z0-9_.-]+)$/);
        assert.ok(match, "SHA256SUMS.txt 格式无效。");
        return [match[2], match[1]];
      }),
  );
  const names = (await readdir(output))
    .filter(
      (name) =>
        /^Panxu-Studio-[a-zA-Z0-9_.-]+\.(?:dmg|exe|zip)(?:\.blockmap)?$/.test(
          name,
        ) || ["latest.yml", "latest-mac.yml", "SHA256SUMS.txt"].includes(name),
    )
    .sort();
  assert.ok(names.length > 1, "没有可上传的更新附件。");
  const assets = [];
  for (const name of names) {
    const path = join(output, name);
    const sha256 = await digest(path);
    if (name !== "SHA256SUMS.txt")
      assert.equal(
        sha256,
        sums.get(name),
        `${name} 在核验后发生变化，未上传。`,
      );
    assets.push({ name, size: (await stat(path)).size, sha256 });
  }
  async function verifyRemote(release) {
    assert.deepEqual(
      release.assets.map((asset) => asset.name).sort(),
      names,
      "远端附件集合不完整或混入其他文件，未公开发布。",
    );
    const missingDigests = [];
    for (const asset of assets) {
      const remote = release.assets.find((entry) => entry.name === asset.name);
      assert.equal(remote.size, asset.size, `${asset.name} 远端大小不一致。`);
      if (remote.digest?.startsWith("sha256:"))
        assert.equal(
          remote.digest,
          `sha256:${asset.sha256}`,
          `${asset.name} 远端 SHA256 不一致。`,
        );
      else missingDigests.push(asset);
    }
    if (!missingDigests.length) return;
    const temporary = await mkdtemp(join(tmpdir(), "panxu-release-verify-"));
    try {
      await gh(
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--dir",
        temporary,
        ...missingDigests.flatMap((asset) => ["--pattern", asset.name]),
      );
      for (const asset of missingDigests)
        assert.equal(
          await digest(join(temporary, asset.name)),
          asset.sha256,
          `${asset.name} 远端下载 SHA256 不一致。`,
        );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  let release = await getRelease();
  if (release && !release.draft) {
    await verifyRemote(release);
    assert.equal(
      release.prerelease,
      false,
      "同版本已公开为预发布，自动入口不会修改已公开版本。",
    );
    return {
      published: true,
      url: release.html_url,
      publishedAt: release.published_at,
    };
  }
  if (!release)
    await gh(
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--draft",
      "--verify-tag",
      "--title",
      `盘序 ${version}`,
      "--notes-file",
      notes,
    );
  else
    await gh(
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--notes-file",
      notes,
      "--title",
      `盘序 ${version}`,
    );
  release = await getRelease();
  assert.equal(release?.draft, true, "无法确认待上传的草稿状态，未修改附件。");
  const pendingAssets = assets.filter((asset) => {
    const remote = release.assets.find((entry) => entry.name === asset.name);
    return (
      !remote ||
      remote.state !== "uploaded" ||
      remote.size !== asset.size ||
      remote.digest !== `sha256:${asset.sha256}`
    );
  });
  if (pendingAssets.length) {
    console.log(`上传 ${pendingAssets.length} 个缺失或变化的发行附件：${tag}`);
    await run(
      "gh",
      [
        "release",
        "upload",
        tag,
        "--repo",
        repository,
        "--clobber",
        ...pendingAssets.map((asset) => join(output, asset.name)),
      ],
      { env },
    );
  } else console.log(`复用远端 ${assets.length} 个已上传且摘要一致的附件。`);
  release = await getRelease();
  assert.equal(
    release?.draft,
    true,
    "上传期间草稿状态已改变，已停止自动公开。",
  );
  await verifyRemote(release);
  console.log("远端附件集合、大小和 SHA256 核验通过。");
  if (!publish)
    return {
      published: false,
      url: `https://github.com/${repository}/releases`,
    };
  const latest = await run(
    "gh",
    ["api", `repos/${repository}/releases/latest`],
    { capture: true, optional: true, env },
  );
  if (latest.code === 0) {
    const latestVersion = JSON.parse(latest.stdout).tag_name?.replace(/^v/, "");
    assert.ok(
      !valid(latestVersion) || !gt(latestVersion, version),
      "远端已有更高稳定版本，禁止将旧版本设为最新。",
    );
  } else
    assert.match(
      latest.stderr,
      /HTTP 404|\(404\)/i,
      "无法检查当前最新版本，未公开草稿。",
    );
  await gh(
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    "--prerelease=false",
    "--latest",
    "--verify-tag",
  );
  release = await getRelease();
  assert.ok(
    release && !release.draft && !release.prerelease,
    "GitHub 正式发布状态未确认，重试同一命令即可继续核对。",
  );
  await verifyRemote(release);
  return {
    published: true,
    url: release.html_url,
    publishedAt: release.published_at,
  };
}
