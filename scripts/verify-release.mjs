import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { load } from "js-yaml";
import { execFileSync, spawnSync } from "node:child_process";
import updateConfig from "./update-config.cjs";
const require = createRequire(import.meta.url),
  asar = require("@electron/asar"),
  root = resolve(
    process.env.PANXU_RELEASE_DIR ??
      `release/${JSON.parse(await readFile("package.json", "utf8")).version}`,
  );
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const expectedUpdate = updateConfig.getUpdateConfig();
const allowUnnotarized = process.argv.includes("--allow-unnotarized");
if (allowUnnotarized)
  assert.ok(
    process.platform === "darwin" && expectedUpdate.signed,
    "未公证交付选项仅适用于已启用签名的 macOS 构建；不会跳过签名校验",
  );
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
  const runtime = JSON.parse(
    asar.extractFile(path, "dist-desktop/update-config.json").toString(),
  );
  assert.deepEqual(
    runtime,
    expectedUpdate,
    "构建与打包时的更新源或签名模式不一致，请重新执行完整打包命令",
  );
  const resources = dirname(path);
  const target = path.includes("win-unpacked")
    ? "win32-x64"
    : path.includes("mac-arm64")
      ? "darwin-arm64"
      : "darwin-x64";
  const helperDir = join(resources, "pansou", target);
  const helper = join(
    helperDir,
    target.startsWith("win") ? "pansou-server.exe" : "pansou-server",
  );
  assert.ok(existsSync(helper), `缺少 ${target} 辅助程序`);
  assert.deepEqual(
    await readFile(join(helperDir, "provenance.json")),
    await readFile(join("build/pansou", target, "provenance.json")),
    "辅助程序来源记录不一致",
  );
  for (const name of ["LICENSE.txt", "THIRD_PARTY_NOTICES.txt"])
    assert.deepEqual(
      await readFile(join(resources, "pansou", name)),
      await readFile(join("build/pansou", name)),
    );
  if (runtime.repository) {
    const feed = load(
      await readFile(join(dirname(path), "app-update.yml"), "utf8"),
    );
    assert.equal(feed.provider, "github");
    assert.equal(`${feed.owner}/${feed.repo}`, runtime.repository);
    assert.equal(feed.private, false);
    assert.equal(feed.token, undefined, "客户端不能包含发布令牌");
    if (runtime.signed && path.includes("win-unpacked")) {
      assert.ok(
        Array.isArray(feed.publisherName) &&
          feed.publisherName.includes(process.env.PANXU_WINDOWS_PUBLISHER),
        "Windows 更新配置缺少签名发布者",
      );
    }
  }
  if (
    runtime.signed &&
    process.platform === "darwin" &&
    path.includes(".app")
  ) {
    const appPath = path.slice(0, path.indexOf(".app") + 4);
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "pipe",
    });
    execFileSync("codesign", ["--verify", "--strict", helper], {
      stdio: "pipe",
    });
    const identity = spawnSync(
      "codesign",
      ["--display", "--verbose=4", appPath],
      { encoding: "utf8" },
    );
    assert.equal(identity.status, 0);
    assert.match(
      identity.stderr,
      /Authority=Developer ID Application:/,
      "macOS 必须使用 Developer ID Application 签名",
    );
    assert.match(
      identity.stderr,
      /Identifier=com\.panxu\.studio\n/,
      "正式应用标识不正确",
    );
    if (!allowUnnotarized) {
      execFileSync("xcrun", ["stapler", "validate", appPath], { stdio: "pipe" });
      execFileSync(
        "spctl",
        ["--assess", "--type", "execute", "--verbose=2", appPath],
        { stdio: "pipe" },
      );
    }
  }
  for (const source of sources)
    assert.deepEqual(
      asar.extractFile(path, source),
      await readFile(source),
      `归档与构建不一致：${path} / ${source}`,
    );
}
const artifacts = (await readdir(root)).filter((name) =>
  /\.(dmg|exe|zip)$/.test(name),
);
assert.ok(artifacts.length, "没有找到安装包");
if (expectedUpdate.signed && process.platform === "win32") {
  const script =
    '$s = Get-AuthenticodeSignature -LiteralPath $env:PANXU_VERIFY_EXECUTABLE; if ($s.Status -ne "Valid") { throw "Invalid installer signature" }; $cn = $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false); if ($cn -cne $env:PANXU_WINDOWS_PUBLISHER) { throw "Unexpected installer publisher" }';
  for (const name of artifacts.filter((name) => name.endsWith(".exe")))
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, PANXU_VERIFY_EXECUTABLE: join(root, name) },
        stdio: "pipe",
      },
    );
}
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
      notarization: allowUnnotarized
        ? "未公证交付：显式跳过票据及 Gatekeeper 验收，签名校验仍强制执行"
        : "默认要求签名的 macOS 应用通过公证票据及 Gatekeeper 验收",
    },
    null,
    2,
  ),
);
