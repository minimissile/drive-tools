import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { load } from "js-yaml";

export function macBaselinePaths(version, directory) {
  assert.match(version, /^\d+\.\d+\.\d+$/, "基线必须使用稳定版本号。");
  const root = resolve(directory);
  const zip = join(root, `Panxu-Studio-${version}-mac-arm64.zip`);
  return {
    version,
    directory: root,
    zip,
    blockmap: `${zip}.blockmap`,
    manifest: join(root, "latest-mac.yml"),
  };
}

// Resolve existing ancestors as output directories may not exist yet.
export function canonicalDirectory(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code !== "ENOENT" || dirname(path) === path) throw error;
    return join(canonicalDirectory(dirname(path)), basename(path));
  }
}

export async function verifyMacBaseline(baseline) {
  const manifest = load(readFileSync(baseline.manifest, "utf8"));
  assert.equal(manifest?.version, baseline.version, "旧版更新清单版本不一致。");
  const info =
    Array.isArray(manifest.files) &&
    manifest.files.find((file) => file.url === basename(baseline.zip));
  assert.ok(
    info && typeof info.sha512 === "string",
    "旧版清单缺少 ZIP 的 SHA512。",
  );
  const zipStat = lstatSync(baseline.zip);
  assert.ok(zipStat.isFile(), "旧版 ZIP 必须是普通文件。");
  assert.equal(zipStat.size, info.size, "旧版 ZIP 大小与清单不一致。");
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(baseline.zip)) hash.update(chunk);
  assert.equal(hash.digest("base64"), info.sha512, "旧版 ZIP SHA512 不一致。");
  const blockmap = JSON.parse(
    gunzipSync(readFileSync(baseline.blockmap), {
      maxOutputLength: 32 * 1024 * 1024,
    }).toString("utf8"),
  );
  assert.equal(blockmap.version, "2", "旧版 blockmap 格式不支持。");
  assert.ok(
    Array.isArray(blockmap.files) && blockmap.files.length > 0,
    "旧版 blockmap 缺少文件。",
  );
  let end = 0;
  for (const file of blockmap.files) {
    assert.ok(
      Number.isSafeInteger(file.offset) && file.offset === end,
      "旧版 blockmap 偏移不连续。",
    );
    assert.ok(
      Array.isArray(file.sizes) &&
        file.sizes.length > 0 &&
        file.sizes.every((size) => Number.isSafeInteger(size) && size > 0),
      "旧版 blockmap 大小无效。",
    );
    assert.ok(
      Array.isArray(file.checksums) &&
        file.checksums.length === file.sizes.length &&
        file.checksums.every(
          (checksum) => typeof checksum === "string" && checksum.length > 0,
        ),
      "旧版 blockmap 校验条目不完整。",
    );
    end += file.sizes.reduce((sum, size) => sum + size, 0);
    assert.ok(
      Number.isSafeInteger(end) && end <= zipStat.size,
      "旧版 blockmap 超出 ZIP 范围。",
    );
  }
  assert.equal(end, zipStat.size, "旧版 blockmap 未覆盖完整 ZIP。");
  return baseline;
}
