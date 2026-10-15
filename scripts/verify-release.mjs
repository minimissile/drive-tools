import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  asar = require("@electron/asar"),
  root = resolve(process.env.PANXU_RELEASE_DIR ?? "release");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const sources = [];
async function walk(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (!path.endsWith(".map")) sources.push(path.replaceAll("\\", "/"));
  }
}
await walk("dist");
await walk("dist-desktop");
const candidates = ["mac-arm64", "mac", "mac-universal"].map((dir) =>
  join(root, dir, "盘序.app", "Contents", "Resources", "app.asar"),
);
candidates.push(join(root, "win-unpacked", "resources", "app.asar"));
const archives = candidates.filter(existsSync);
assert.ok(archives.length, "没有找到应用归档");
for (const path of archives) {
  const files = asar.listPackage(path);
  assert.equal(
    files.some((file) =>
      /(?:^|[/\\])(?:panxu\.db(?:-|$)|\.env(?:$|\.)|Cookies|workspace-location\.json|A-Vault)(?:[/\\]|$)/i.test(
        file,
      ),
    ),
    false,
    "归档不能包含用户数据",
  );
  assert.equal(
    JSON.parse(asar.extractFile(path, "package.json").toString()).version,
    pkg.version,
  );
  for (const source of sources)
    assert.deepEqual(
      asar.extractFile(path, source),
      await readFile(source),
      `归档与构建不一致：${path} / ${source}`,
    );
}
const artifacts = (await readdir(root)).filter((name) =>
  /\.(dmg|exe)$/.test(name),
);
assert.ok(artifacts.length, "没有找到安装包");
const sums = [];
for (const name of artifacts) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(root, name)))
    hash.update(chunk);
  sums.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(join(root, "SHA256SUMS.txt"), sums.join("\n") + "\n");
console.log(
  JSON.stringify(
    {
      version: pkg.version,
      archives: archives.length,
      filesPerArchive: sources.length,
      artifacts,
      checksums: join(root, "SHA256SUMS.txt"),
      userDataIncluded: false,
    },
    null,
    2,
  ),
);
