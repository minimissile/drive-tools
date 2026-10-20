import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { load } from "js-yaml";
import policy from "./release-policy.cjs";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const root = resolve(process.env.PANXU_RELEASE_DIR ?? `release/${pkg.version}`);
const names = await readdir(root);
const all = process.argv.includes("--all");
const archArg = process.argv.find((arg) => arg.startsWith("--arch="));
const arch = archArg?.slice(7);
assert.ok(
  !arch || ["arm64", "x64"].includes(arch),
  "仅支持 --arch=arm64 或 --arch=x64",
);
assert.ok(!(all && arch), "正式发布 --all 不允许缩小架构校验范围");
const manifests = ["latest.yml", "latest-mac.yml"].filter((name) =>
  names.includes(name),
);
assert.ok(manifests.length, "缺少更新清单；必须配置公开更新仓库后重新打包。");
if (all) {
  const required = Object.keys(policy.getReleasePolicy())
    .map((p) => (p === "mac" ? "latest-mac.yml" : "latest.yml"))
    .sort();
  assert.deepEqual(
    [...manifests].sort(),
    required,
    "正式发布必须完整包含当前发行计划的清单，且不得混入未启用平台。",
  );
}
async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}
for (const name of manifests) {
  const info = load(await readFile(join(root, name), "utf8"));
  assert.equal(info.version, pkg.version, `${name} 版本与 package.json 不一致`);
  assert.ok(
    Array.isArray(info.files) && info.files.length > 0,
    `${name} 缺少 files`,
  );
  const urls = new Set();
  for (const file of info.files) {
    assert.equal(typeof file.url, "string");
    assert.ok(
      /^[a-zA-Z0-9_.-]+$/.test(file.url) &&
        file.url.includes(`-${pkg.version}-`),
      "清单只能引用本版本同目录文件，禁止外部 URL 和路径穿越",
    );
    assert.equal(urls.has(file.url), false, "更新文件重复");
    urls.add(file.url);
    const path = join(root, file.url);
    assert.equal((await stat(path)).size, file.size, `${file.url} 大小不一致`);
    assert.equal(
      await digest(path, "sha512", "base64"),
      file.sha512,
      `${file.url} SHA512 不一致`,
    );
    if (/\.(exe|zip)$/.test(file.url))
      assert.ok(
        names.includes(`${file.url}.blockmap`),
        `${file.url} 缺少 blockmap`,
      );
  }
  const suffixes =
    name === "latest.yml"
      ? ["win-x64.exe"]
      : arch
        ? [`mac-${arch}.zip`, `mac-${arch}.dmg`]
        : ["mac-arm64.zip", "mac-arm64.dmg"];
  for (const suffix of suffixes)
    assert.ok(
      urls.has(`Panxu-Studio-${pkg.version}-${suffix}`),
      `${name} 缺少 ${suffix}`,
    );
  assert.ok(urls.has(info.path), `${name} 的兼容 path 不在 files 中`);
  assert.equal(
    info.sha512,
    info.files.find((file) => file.url === info.path).sha512,
    `${name} 的兼容 SHA512 不一致`,
  );
}
const artifacts = names
  .filter((name) =>
    /^(Panxu-Studio-[a-zA-Z0-9_.-]+\.(?:dmg|exe|zip)(?:\.blockmap)?|latest(?:-mac)?\.yml)$/.test(
      name,
    ),
  )
  .sort();
if (all) {
  const suffixes = Object.entries(policy.getReleasePolicy()).flatMap(
    ([platform, arches]) =>
      arches.flatMap((arch) =>
        (platform === "mac" ? ["dmg", "zip"] : ["exe"]).map(
          (ext) => `${platform}-${arch}.${ext}`,
        ),
      ),
  );
  for (const name of artifacts.filter((name) => !name.startsWith("latest")))
    assert.ok(
      suffixes.some(
        (suffix) =>
          name === `Panxu-Studio-${pkg.version}-${suffix}` ||
          name === `Panxu-Studio-${pkg.version}-${suffix}.blockmap`,
      ),
      "正式发布目录混入未启用平台或架构的产物",
    );
}
for (const name of artifacts)
  assert.ok(
    name.startsWith("latest") ||
      name.startsWith(`Panxu-Studio-${pkg.version}-`),
    "输出目录混入其他版本文件",
  );
await writeFile(
  join(root, "SHA256SUMS.txt"),
  (
    await Promise.all(
      artifacts.map(
        async (name) =>
          `${await digest(join(root, name), "sha256", "hex")}  ${name}`,
      ),
    )
  ).join("\n") + "\n",
);
console.log(
  JSON.stringify({
    version: pkg.version,
    manifests,
    assets: artifacts.length,
    scope: arch ?? "all-architectures",
    verified: "sizes, SHA512, architectures, blockmaps, SHA256SUMS",
  }),
);
