import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { syncMacDevIdentity } = await import(
  new URL("../scripts/dev-macos.mjs", import.meta.url).href
);

test(
  "macOS development bundle names persist across starts without changing other fields",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "panxu-dev-identity-"));
    try {
      const contents = join(
        root,
        "node_modules/electron/dist/Electron.app/Contents",
      );
      await mkdir(join(contents, "MacOS"), { recursive: true });
      const path = join(contents, "Info.plist");
      await writeFile(
        path,
        `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleName</key><string>Electron</string>
      <key>CFBundleDisplayName</key><string>Electron</string>
      <key>CFBundleIdentifier</key><string>com.github.Electron</string>
      <key>CFBundleExecutable</key><string>Electron</string>
      <key>CFBundleVersion</key><string>44.7.2</string>
    </dict></plist>`,
      );
      const options = {
        root,
        executable: join(contents, "MacOS/Electron"),
        productName: "盘序 & 资料",
        appId: "com.panxu.studio",
        register: async () => {},
      };
      assert.equal((await syncMacDevIdentity(options)).changed, true);
      const plist = JSON.parse(
        execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
          encoding: "utf8",
        }),
      );
      assert.equal(plist.CFBundleName, options.productName);
      assert.equal(plist.CFBundleDisplayName, options.productName);
      assert.equal(plist.CFBundleIdentifier, "com.panxu.studio.dev");
      assert.equal(plist.CFBundleExecutable, "Electron");
      assert.equal(plist.CFBundleVersion, "44.7.2");
      const saved = await readFile(path, "utf8");
      assert.equal((await syncMacDevIdentity(options)).changed, false);
      assert.equal(await readFile(path, "utf8"), saved);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("development name sync refuses a runtime outside the project's dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "panxu-dev-identity-boundary-"));
  try {
    await mkdir(join(root, "node_modules"));
    const contents = join(root, "external/Electron.app/Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    const path = join(contents, "Info.plist");
    await writeFile(path, "untouched");
    await assert.rejects(
      syncMacDevIdentity({
        root,
        executable: join(contents, "MacOS/Electron"),
        productName: "盘序",
        appId: "com.panxu.studio",
      }),
      /当前项目/,
    );
    assert.equal(await readFile(path, "utf8"), "untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
