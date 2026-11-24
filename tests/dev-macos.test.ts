import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { restoreMacElectronBundle, syncMacDevIdentity } = await import(
  new URL("../scripts/dev-macos.mjs", import.meta.url).href
);

test(
  "macOS branding uses a reusable copy and leaves the Electron installer layout intact",
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
      await mkdir(join(contents, "Resources"), { recursive: true });
      await mkdir(join(root, "build"));
      await writeFile(join(root, "build", "icon.icns"), "test-icon");
      await writeFile(join(root, "build", "icon-dev.icns"), "test-dev-icon");
      await writeFile(join(contents, "MacOS/Electron"), "test-runtime");
      await writeFile(
        join(contents, "Resources/original.icns"),
        "original-icon",
      );
      await symlink("original.icns", join(contents, "Resources/current.icns"));
      let path = join(contents, "Info.plist");
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
      const sourcePlist = await readFile(path, "utf8");
      const options = {
        root,
        executable: join(contents, "MacOS/Electron"),
        productName: "盘序 & 资料",
        appId: "com.panxu.studio",
        register: async () => {},
      };
      const identity = await syncMacDevIdentity(options);
      assert.equal(identity.changed, true);
      assert.equal(
        identity.bundle,
        await realpath(
          join(root, "node_modules/.cache/panxu-dev-runtime/盘序 & 资料.app"),
        ),
      );
      path = join(identity.bundle, "Contents", "Info.plist");
      assert.equal(
        await readFile(
          join(identity.bundle, "Contents/Resources/panxu-dev.icns"),
          "utf8",
        ),
        "test-dev-icon",
      );
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
      assert.equal(
        await readFile(join(contents, "Info.plist"), "utf8"),
        sourcePlist,
      );
      assert.equal((await lstat(join(contents, ".."))).isSymbolicLink(), false);
      assert.equal(await readFile(options.executable, "utf8"), "test-runtime");
      assert.equal(
        await readFile(
          join(identity.bundle, "Contents/Resources/current.icns"),
          "utf8",
        ),
        "original-icon",
      );
      const saved = await readFile(path, "utf8");
      assert.equal((await syncMacDevIdentity(options)).changed, false);
      assert.equal(await readFile(path, "utf8"), saved);

      // A package reinstall can extract a fresh physical Electron.app normally.
      await rm(join(contents, ".."), { recursive: true });
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await mkdir(join(contents, "Resources"), { recursive: true });
      await writeFile(
        join(contents, "Info.plist"),
        sourcePlist.replace("44.7.2", "44.8.0"),
      );
      await writeFile(options.executable, "updated-electron-runtime");
      const refreshed = await syncMacDevIdentity(options);
      assert.equal(refreshed.changed, true);
      assert.equal(
        await readFile(refreshed.executable, "utf8"),
        "updated-electron-runtime",
      );
      assert.equal((await lstat(join(contents, ".."))).isSymbolicLink(), false);
      assert.match(await readFile(path, "utf8"), /44\.8\.0/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "legacy Electron.app aliases are restored before Electron's installer runs",
  { skip: process.platform !== "darwin" },
  async () => {
    for (const targetExists of [true, false]) {
      const root = await mkdtemp(join(tmpdir(), "panxu-dev-alias-"));
      try {
        const dist = join(root, "node_modules/electron/dist");
        await mkdir(dist, { recursive: true });
        const canonical = join(dist, "Electron.app");
        const legacy = join(dist, "盘序.app");
        if (targetExists) {
          await mkdir(legacy);
          await writeFile(join(legacy, "runtime"), "existing-runtime");
        }
        await symlink("盘序.app", canonical);
        await restoreMacElectronBundle({ root, productName: "盘序" });
        if (targetExists) {
          assert.equal((await lstat(canonical)).isDirectory(), true);
          assert.equal(
            await readFile(join(canonical, "runtime"), "utf8"),
            "existing-runtime",
          );
        } else {
          await assert.rejects(lstat(canonical), { code: "ENOENT" });
          // A normal installer can now create Electron.app instead of traversing a link.
          await mkdir(canonical);
        }
        await restoreMacElectronBundle({ root, productName: "盘序" });
        assert.equal((await lstat(canonical)).isSymbolicLink(), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "legacy alias recovery preserves links to unknown runtimes",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "panxu-dev-alias-boundary-"));
    try {
      const dist = join(root, "node_modules/electron/dist");
      await mkdir(dist, { recursive: true });
      const canonical = join(dist, "Electron.app");
      await symlink("other.app", canonical);
      await assert.rejects(
        restoreMacElectronBundle({ root, productName: "盘序" }),
        /未知位置/,
      );
      assert.equal((await lstat(canonical)).isSymbolicLink(), true);
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
