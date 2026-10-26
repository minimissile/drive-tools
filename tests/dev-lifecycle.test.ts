import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const lifecycleUrl = pathToFileURL(
  join(process.cwd(), "scripts/dev-lifecycle.mjs"),
).href;
const { acquireDevLock, stopDevChild } = await import(lifecycleUrl);

test("同一项目不同端口/数据目录的跨进程启动被拒绝，原锁仍有效", async () => {
  const root = await mkdtemp(join(tmpdir(), "panxu-dev-lock-"));
  const release = await acquireDevLock(root);
  try {
    for (const port of [8070, 5187]) {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {acquireDevLock} from ${JSON.stringify(lifecycleUrl)}; try {await acquireDevLock(process.argv[1]);process.exit(9);} catch(e) {console.error(e.message);process.exitCode=2;}`,
          root,
        ],
        {
          env: {
            ...process.env,
            PANXU_DEV_PORT: String(port),
            PANXU_DATA_DIR: join(root, `data-${port}`),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (data) => (stderr += data));
      assert.equal((await once(child, "exit"))[0], 2);
      assert.match(stderr, /已有开发服务运行/);
    }
    await assert.rejects(acquireDevLock(root), /已有开发服务运行/);
    const alias = `${root}-alias`;
    await symlink(root, alias, "junction");
    try {
      await assert.rejects(acquireDevLock(alias), /已有开发服务运行/);
    } finally {
      await rm(alias);
    }
  } finally {
    await release();
    await rm(root, { recursive: true, force: true });
  }
});

test("正常释放和异常退出遗留的过期锁均可再次启动", async () => {
  const root = await mkdtemp(join(tmpdir(), "panxu-dev-stale-"));
  try {
    const release = await acquireDevLock(root);
    await release();
    const lockPath = join(root, ".panxu-dev.lock");
    await mkdir(lockPath);
    const expired = new Date(Date.now() - 60000);
    await utimes(lockPath, expired, expired);
    const releaseRecovered = await acquireDevLock(root);
    await releaseRecovered();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("清理等待本轮子进程退出；无关进程保持运行", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  try {
    await stopDevChild(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
  } finally {
    await stopDevChild(unrelated);
  }
});

test("无响应的本轮子进程也被回收，不遗留程序", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await once(child.stdout!, "data");
  await stopDevChild(child, 50);
  assert.equal(child.signalCode, "SIGKILL");
});

test("开发父进程 IPC 断开后，桌面生命周期处理会退出子进程", async () => {
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "desktop/dev-parent.ts"),
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {watchDevParent} from ${JSON.stringify(moduleUrl)}; watchDevParent(process,()=>process.exit(0)); process.send('ready'); setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  try {
    await once(child, "message");
    const ended = once(child, "exit");
    child.disconnect();
    assert.equal((await ended)[0], 0);
  } finally {
    await stopDevChild(child);
  }
});
