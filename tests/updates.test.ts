import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  UpdateManager,
  updateError,
  type UpdateCandidate,
  type UpdateDriver,
} from "../core/updates";
import { AppError } from "../core/errors";
import { Database } from "../core/database";
import { snapshotBeforeUpdate } from "../core/update-backup";
import type {
  UpdatePreferences,
  UpdateProgress,
  UpdateState,
} from "../shared/updates";
import { fixture as appFixture } from "./helpers";
import { TransferQueue } from "../core/queue";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  overrides: Partial<ConstructorParameters<typeof UpdateManager>[0]> = {},
) {
  const download = deferred<void>();
  const calls = {
    checks: 0,
    downloads: 0,
    installs: 0,
    cancels: 0,
    prepares: 0,
    failures: 0,
  };
  let candidate: UpdateCandidate | null = {
    version: "0.5.0",
    releaseNotes: "Release notes",
    releaseDate: "2026-10-15T12:00:00Z",
  };
  let progress!: (value: UpdateProgress) => void,
    nativeError!: (error: unknown) => void;
  let saved: UpdatePreferences | undefined;
  const states: UpdateState[] = [];
  const driver: UpdateDriver = {
    async check() {
      calls.checks++;
      return candidate;
    },
    download() {
      calls.downloads++;
      return download.promise;
    },
    cancel() {
      calls.cancels++;
      download.reject(new Error("cancelled"));
    },
    install() {
      calls.installs++;
    },
    listen(p, e) {
      progress = p;
      nativeError = e;
      return () => {};
    },
  };
  const opened: string[] = [];
  const manager = new UpdateManager({
    version: "0.4.0",
    platform: "darwin",
    arch: "arm64",
    repository: "owner/releases",
    disabledReason: null,
    canInstall: true,
    driver,
    preferences: {},
    savePreferences(value) {
      saved = value;
    },
    changed: (value) => states.push(value),
    log() {},
    async prepareInstall() {
      calls.prepares++;
      return true;
    },
    installFailed() {
      calls.failures++;
    },
    async openRelease(url) {
      opened.push(url);
    },
    async openLogs() {},
    ...overrides,
  });
  return {
    manager,
    calls,
    states,
    driver,
    opened,
    download,
    progress: (value: UpdateProgress) => progress(value),
    nativeError: (error: unknown) => nativeError(error),
    candidate: (value: UpdateCandidate | null) => {
      candidate = value;
    },
    saved: () => saved,
  };
}

test("updates: disabled builds do not contact the update host", async () => {
  const f = fixture({ disabledReason: "development", canInstall: false });
  await f.manager.check();
  f.manager.start();
  assert.equal(f.manager.getState().phase, "disabled");
  assert.equal(f.calls.checks, 0);
  await assert.rejects(f.manager.download(), /正式构建/);
  f.manager.dispose();
});
test("updates: checks do not download, release notes stay bounded plain text, snapshots are detached", async () => {
  const f = fixture();
  f.candidate({
    version: "0.5.0",
    releaseNotes: "<script>untrusted</script>" + "x".repeat(15000),
  });
  await f.manager.check();
  assert.equal(f.calls.downloads, 0);
  const state = f.manager.getState();
  assert.equal(state.phase, "available");
  assert.equal(state.release!.notes.length, 12000);
  state.release!.version = "mutated";
  assert.equal(f.manager.getState().release!.version, "0.5.0");
});
test("updates: concurrent checks share one request and automatic checks obey preferences and cooldown", async () => {
  let checks = 0;
  const gate = deferred<UpdateCandidate | null>();
  const f = fixture();
  f.driver.check = () => {
    checks++;
    return gate.promise;
  };
  const a = f.manager.check(),
    b = f.manager.check();
  assert.equal(checks, 1);
  gate.resolve(null);
  await Promise.all([a, b]);
  assert.equal(f.manager.getState().phase, "current");
  await f.manager.check(false);
  assert.equal(checks, 1);
  await f.manager.invoke("updater.configure", { autoCheck: false });
  await f.manager.check(false);
  assert.equal(checks, 1);
  await f.manager.check(true);
  assert.equal(checks, 2);
  assert.equal(f.saved()!.autoCheck, false);
});
test("updates: cooldown persists across restarts and expires after six hours", async () => {
  let now = Date.parse("2026-10-15T12:00:00Z");
  const f = fixture({
    now: () => now,
    preferences: {
      autoCheck: true,
      skippedVersion: null,
      lastCheckedAt: new Date(now).toISOString(),
    },
  });
  await f.manager.check(false);
  assert.equal(f.calls.checks, 0);
  now += 6 * 60 * 60 * 1000;
  await f.manager.check(false);
  assert.equal(f.calls.checks, 1);
});
test("updates: a stalled version check leaves the checking state within 45 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.driver.check = () => new Promise(() => {});
  const operation = f.manager.check();
  t.mock.timers.tick(45000);
  await operation;
  assert.equal(f.manager.getState().error!.code, "UPDATE_NETWORK_FAILED");
});
test("updates: downgrade, same version, malformed versions and prereleases are rejected", async () => {
  for (const version of [
    "0.3.0",
    "0.4.0",
    "0.5.0-beta.1",
    "0.5.0+build",
    "v0.5.0",
    "invalid",
    "../../escape",
  ]) {
    const f = fixture();
    f.candidate({ version });
    await f.manager.check();
    assert.equal(f.manager.getState().error!.code, "UPDATE_VERSION_REJECTED");
    await assert.rejects(f.manager.download());
  }
});
test("updates: skipping one release persists without suppressing explicit checks", async () => {
  const f = fixture();
  await f.manager.check();
  await f.manager.invoke("updater.skip");
  assert.equal(f.saved()!.skippedVersion, "0.5.0");
  await f.manager.check();
  assert.equal(f.manager.getState().release!.version, "0.5.0");
  f.candidate({ version: "0.6.0" });
  await f.manager.check();
  assert.notEqual(
    f.manager.getState().release!.version,
    f.manager.getState().skippedVersion,
  );
});
test("updates: download is deduplicated, progress is sanitized, install requires verified completion", async () => {
  const f = fixture();
  await f.manager.check();
  const a = f.manager.download(),
    b = f.manager.download();
  assert.equal(f.calls.downloads, 1);
  await assert.rejects(f.manager.install());
  f.progress({
    percent: 200,
    total: NaN,
    transferred: -1,
    bytesPerSecond: Infinity,
  });
  assert.deepEqual(f.manager.getState().progress, {
    percent: 100,
    total: 0,
    transferred: 0,
    bytesPerSecond: 0,
  });
  f.download.resolve();
  await Promise.all([a, b]);
  await f.manager.check();
  assert.equal(f.calls.checks, 1);
  assert.equal(f.manager.getState().phase, "downloaded");
  await f.manager.install();
  assert.equal(f.calls.prepares, 1);
  assert.equal(f.calls.installs, 1);
  await assert.rejects(f.manager.invoke("updater.download"));
  assert.equal(f.manager.getState().phase, "installing");
  await assert.rejects(f.manager.install());
  assert.equal(f.calls.installs, 1);
});
test("updates: cancellation returns to available and never installs", async () => {
  const f = fixture();
  await f.manager.check();
  const operation = f.manager.download();
  f.manager.cancel();
  f.manager.cancel();
  await operation;
  assert.equal(f.calls.cancels, 1);
  assert.equal(f.manager.getState().phase, "available");
  assert.equal(f.calls.installs, 0);
});
test("updates: failed network download can retry, but invalid hashes require a new check", async () => {
  const f = fixture();
  await f.manager.check();
  const operation = f.manager.download();
  f.download.reject(
    new Error("net::ERR_CONNECTION_RESET private-url?token=secret"),
  );
  await operation;
  assert.equal(f.manager.getState().error!.retry, "download");
  assert.equal(JSON.stringify(f.manager.getState()).includes("secret"), false);
  f.driver.download = async () => {};
  await f.manager.download();
  assert.equal(f.manager.getState().phase, "downloaded");
  const damaged = fixture();
  await damaged.manager.check();
  const bad = damaged.manager.download();
  damaged.download.reject(new Error("sha512 checksum mismatch"));
  await bad;
  assert.equal(
    damaged.manager.getState().error!.code,
    "UPDATE_VERIFICATION_FAILED",
  );
  await assert.rejects(damaged.manager.download());
  await assert.rejects(damaged.manager.install());
});
test("updates: installation cancellation, active work, snapshot errors and native errors preserve the running app", async () => {
  for (const prepare of [
    async () => false,
    async () => {
      throw new AppError("UPDATE_TASKS_RUNNING", "任务正在进行");
    },
    async () => {
      throw new Error("ENOSPC");
    },
  ]) {
    const f = fixture({ prepareInstall: prepare });
    await f.manager.check();
    const download = f.manager.download();
    f.download.resolve();
    await download;
    await f.manager.install();
    assert.equal(f.calls.installs, 0);
    assert.ok(["downloaded", "error"].includes(f.manager.getState().phase));
  }
  const f = fixture();
  await f.manager.check();
  const download = f.manager.download();
  f.download.resolve();
  await download;
  await f.manager.install();
  f.nativeError(new Error("code signature mismatch"));
  assert.equal(f.calls.failures, 1);
  assert.equal(f.manager.getState().error!.code, "UPDATE_VERIFICATION_FAILED");
});
test("updates: development/unsigned builds offer the fixed release URL, never arbitrary URLs or installers", async () => {
  const f = fixture({ canInstall: false });
  await f.manager.check();
  await assert.rejects(f.manager.download());
  await f.manager.invoke("updater.openRelease");
  assert.equal(
    f.opened[0],
    "https://github.com/owner/releases/releases/tag/v0.5.0",
  );
  await assert.rejects(
    f.manager.invoke("updater.openRelease", { url: "https://evil.invalid" }),
  );
  await assert.rejects(
    f.manager.invoke("updater.configure", {
      autoCheck: true,
      repository: "evil/feed",
    }),
  );
  await assert.rejects(f.manager.invoke("updater.arbitrary"));
});
test("updates: disposed managers ignore late responses, background errors are contained", async () => {
  const f = fixture();
  const gate = deferred<UpdateCandidate | null>();
  f.driver.check = () => gate.promise;
  const check = f.manager.check();
  const count = f.states.length;
  f.manager.dispose();
  gate.resolve(null);
  await check;
  assert.equal(f.states.length, count);
  const broken = fixture({
    savePreferences() {
      throw new Error("disk failure");
    },
  });
  await broken.manager.invoke("updater.check");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broken.manager.getState().phase, "error");
});
test("updates: errors redact upstream details and distinguish actionable causes", () => {
  for (const [message, code] of [
    ["ENOSPC", "UPDATE_DISK_FULL"],
    ["EPERM", "UPDATE_PERMISSION_DENIED"],
    ["404", "UPDATE_NOT_PUBLISHED"],
    ["No published versions on GitHub", "UPDATE_NOT_PUBLISHED"],
    ["ETIMEDOUT", "UPDATE_NETWORK_FAILED"],
  ])
    assert.equal(updateError(new Error(message), "check").code, code);
});
test("updates: consistent local snapshots retain data and encrypted secrets, prune only owned snapshots", async () => {
  const folder = await mkdtemp(join(tmpdir(), "panxu-update-backup-"));
  const db = new Database(join(folder, "panxu.db"));
  try {
    db.setSetting("sentinel", { preserved: true });
    db.run(
      "INSERT INTO secrets(key,value) VALUES(?,?)",
      "test-key",
      "encrypted-local-value",
    );
    const first = await snapshotBeforeUpdate(db, folder);
    const other = join(folder, "updates/backups/manual-keep.db");
    await writeFile(other, "manual");
    const copy = new Database(first);
    assert.deepEqual(copy.setting("sentinel", null), { preserved: true });
    assert.equal(
      copy.get<{ value: string }>(
        "SELECT value FROM secrets WHERE key=?",
        "test-key",
      )!.value,
      "encrypted-local-value",
    );
    assert.equal(
      copy.get<{ integrity_check: string }>("PRAGMA integrity_check")!
        .integrity_check,
      "ok",
    );
    copy.close();
    if (process.platform !== "win32")
      assert.equal((await stat(first)).mode & 0o777, 0o600);
    for (let i = 0; i < 4; i++) await snapshotBeforeUpdate(db, folder);
    assert.equal(
      (await readdir(join(folder, "updates/backups"))).filter(
        (name) => name.startsWith("before-update-") && name.endsWith(".db"),
      ).length,
      3,
    );
    assert.equal(await readFile(other, "utf8"), "manual");
  } finally {
    db.close();
    await rm(folder, { force: true, recursive: true });
  }
});
test("updates: the real service blocks active operations, queued tasks and workspace switching; a stopped queue cannot launch work", async () => {
  const f = await appFixture();
  try {
    f.app.assertUpdateIdle();
    assert.throws(() => f.app.assertUpdateIdle(1), {
      code: "UPDATE_TASKS_RUNNING",
    });
    const saved = await f.add();
    assert.throws(() => f.app.assertUpdateIdle(), {
      code: "UPDATE_TASKS_RUNNING",
    });
    f.app.queue.stop();
    await TransferQueue.prototype.pump.call(f.app.queue);
    assert.equal(f.provider.transfers, 0);
    await f.app.invoke("job.cancel", { id: saved.jobId });
    f.app.assertUpdateIdle();
    f.app.db.setSetting("restorePreviousDataPath", f.dir);
    await f.app.invoke("system.previousWorkspace");
    assert.throws(() => f.app.assertUpdateIdle(), {
      code: "UPDATE_TASKS_RUNNING",
    });
  } finally {
    await f.cleanup();
  }
});
test("updates: release configuration cannot use arbitrary hosts, private tokens or malformed repo paths", () => {
  const require = createRequire(import.meta.url);
  const { getUpdateConfig } = require("../scripts/update-config.cjs");
  assert.deepEqual(
    getUpdateConfig({
      PANXU_UPDATE_REPOSITORY: "owner/releases",
      PANXU_REQUIRE_SIGNING: "1",
    }),
    { repository: "owner/releases", signed: true },
  );
  for (const repository of [
    "https://example.com/feed",
    "owner/repo.git",
    "../path",
    "owner/repo/escape",
    "owner:token/repo",
  ])
    assert.throws(() =>
      getUpdateConfig({ PANXU_UPDATE_REPOSITORY: repository }),
    );
});
test("updates: release verifier rejects missing archives, wrong versions, tampering and external asset paths", async () => {
  const folder = await mkdtemp(join(tmpdir(), "panxu-update-assets-"));
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  try {
    const files = [];
    for (const suffix of ["mac-arm64.zip", "mac-arm64.dmg"]) {
      const url = `Panxu-Studio-${version}-${suffix}`,
        bytes = Buffer.from(suffix);
      await writeFile(join(folder, url), bytes);
      if (suffix.endsWith(".zip"))
        await writeFile(join(folder, `${url}.blockmap`), "blockmap");
      files.push({
        url,
        size: bytes.length,
        sha512: createHash("sha512").update(bytes).digest("base64"),
      });
    }
    const info = {
      version,
      files,
      path: files[0].url,
      sha512: files[0].sha512,
    };
    const manifest = join(folder, "latest-mac.yml");
    const run = (all = false) =>
      execFileSync(
        process.execPath,
        ["scripts/verify-updates.mjs", ...(all ? ["--all"] : [])],
        { env: { ...process.env, PANXU_RELEASE_DIR: folder }, stdio: "pipe" },
      );
    await writeFile(manifest, JSON.stringify(info));
    run();
    run(true); // 0.0.1 releases Apple Silicon macOS first.
    await rm(join(folder, `${files[0].url}.blockmap`));
    assert.throws(() => run());
    await writeFile(join(folder, `${files[0].url}.blockmap`), "blockmap");
    const winUrl = `Panxu-Studio-${version}-win-x64.exe`,
      winBytes = Buffer.from("installer");
    await writeFile(join(folder, winUrl), winBytes);
    await writeFile(join(folder, `${winUrl}.blockmap`), "blockmap");
    const winFile = {
      url: winUrl,
      size: winBytes.length,
      sha512: createHash("sha512").update(winBytes).digest("base64"),
    };
    await writeFile(
      join(folder, "latest.yml"),
      JSON.stringify({
        version,
        files: [winFile],
        path: winUrl,
        sha512: winFile.sha512,
      }),
    );
    assert.throws(() => run(true)); // Disabled Windows assets cannot enter this release.
    await rm(join(folder, "latest.yml"));
    assert.throws(() => run(true)); // An orphan Windows installer is also rejected.
    await rm(join(folder, winUrl));
    await rm(join(folder, `${winUrl}.blockmap`));
    run(true);
    await writeFile(manifest, JSON.stringify({ ...info, version: "99.99.99" }));
    assert.throws(() => run());
    await writeFile(
      manifest,
      JSON.stringify({
        ...info,
        files: [{ ...files[0], url: "../../escape.zip" }],
      }),
    );
    assert.throws(() => run());
    await writeFile(manifest, JSON.stringify(info));
    await writeFile(join(folder, files[0].url), "tampered");
    assert.throws(() => run());
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
});
