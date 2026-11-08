import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Database, databaseSchemaVersion, id } from "../core/database";
import { fileHash, inspectBackup } from "../core/backups";
import { VideoService, type VideoServiceOptions } from "../core/video-service";
import type { RenderLocalVideoOptions } from "../core/video-renderer";
import type { LocalVideoResult, VideoProjectInput } from "../shared/video";

const project: VideoProjectInput = {
  title: "课堂练习资料",
  entries: [
    { name: "第一周课堂练习", kind: "folder" },
    { name: "练习方法.pdf", kind: "file" },
  ],
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF2sAAAAASUVORK5CYII=",
  "base64",
);
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(12),
]);
const runtime = async () => ({
  available: true,
  browserExecutable: "/test/local-chrome",
  message: "本地测试运行时",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function eventually(
  predicate: () => boolean,
  message = "异步视频任务未到达预期状态",
) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(options: Partial<VideoServiceOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "panxu-video-service-"));
  const db = new Database(join(dir, "panxu.db"));
  let changes = 0;
  const renders: {
    options: RenderLocalVideoOptions;
    gate: ReturnType<typeof deferred<LocalVideoResult>>;
  }[] = [];
  const service = new VideoService(
    db,
    dir,
    () => {
      changes++;
    },
    {
      runtime,
      render: async (input) => {
        const gate = deferred<LocalVideoResult>();
        renders.push({ options: input, gate });
        return gate.promise;
      },
      ...options,
    },
  );
  return {
    dir,
    db,
    service,
    renders,
    get changes() {
      return changes;
    },
    async finish(index = 0, bytes = mp4) {
      const { options: input, gate } = renders[index];
      await mkdir(input.outputDirectory, { recursive: true });
      const videoPath = join(input.outputDirectory, "video.mp4");
      const coverPath = join(input.outputDirectory, "cover.png");
      await writeFile(videoPath, bytes);
      await writeFile(coverPath, png);
      gate.resolve({
        videoPath,
        coverPath,
        width: 1080,
        height: 1920,
        durationSeconds: 12,
      });
    },
    async cleanup(databaseClosed = false) {
      // This fixture owns only its temporary database and synthetic render gates.
      if (!databaseClosed) {
        for (const row of db.all<{ value: string }>(
          "SELECT value FROM settings WHERE key LIKE 'local-video:job:%'",
        )) {
          const job = JSON.parse(row.value);
          if (["queued", "rendering"].includes(job.status))
            service.cancel(job.id);
        }
      }
      for (const render of renders) render.gate.reject(new Error("测试清理"));
      await eventually(() => !service.isBusy);
      if (!databaseClosed) db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("local video queue prevents duplicate submissions after concurrent readiness checks", async () => {
  const ready = deferred<Awaited<ReturnType<typeof runtime>>>();
  let checks = 0;
  const h = await setup({
    runtime: async () => {
      checks++;
      return ready.promise;
    },
  });
  try {
    const first = h.service.create("resource-a", project);
    const second = h.service.create("resource-a", project);
    assert.equal(checks, 2);
    ready.resolve(await runtime());
    const results = await Promise.allSettled([first, second]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(
      rejected?.status === "rejected" && rejected.reason.code,
      "VIDEO_ALREADY_RUNNING",
    );
    assert.equal(h.service.jobs("resource-a").length, 1);
    assert.equal(h.renders.length, 1);
    await h.finish();
    await eventually(() => !h.service.isBusy);
  } finally {
    await h.cleanup();
  }
});

test("local video queue serializes sources and persists progress without broadcasting every frame", async () => {
  const h = await setup();
  try {
    const first = await h.service.create("resource-a", {
      ...project,
      slides: [
        {
          src: `data:image/png;base64,${png.toString("base64")}`,
          caption: "真实预览",
        },
      ],
      audio: { src: "data:audio/wav;base64,YXVkaW8=" },
    });
    const second = await h.service.create("article-b", {
      ...project,
      title: "另一模块的内容",
    });
    assert.equal(h.renders.length, 1);
    assert.equal(h.service.jobs("article-b")[0].status, "queued");
    const broadcasts = h.changes;
    for (let frame = 1; frame <= 40; frame++)
      h.renders[0].options.onProgress?.({
        stage: "rendering",
        progress: frame / 50,
      });
    assert.equal(h.service.jobs("resource-a")[0].progress, 0.8);
    assert.equal(h.changes, broadcasts);
    const stored = h.db.setting<Record<string, any>>(
      `local-video:job:${first.id}`,
      {},
    );
    assert.equal(stored.project.slideCount, 1);
    assert.equal(stored.project.hasAudio, true);
    assert.equal(JSON.stringify(stored).includes("data:image/"), false);
    assert.equal(JSON.stringify(stored).includes("data:audio/"), false);
    await h.finish();
    await eventually(() => h.renders.length === 2);
    assert.equal(h.service.jobs("resource-a")[0].status, "completed");
    assert.equal(h.service.jobs("article-b")[0].id, second.id);
    assert.equal(h.service.jobs("article-b")[0].status, "rendering");
    await h.finish(1, Buffer.concat([mp4, Buffer.from("second")]));
    await eventually(() => !h.service.isBusy);
    assert.equal(h.service.jobs("article-b")[0].status, "completed");
    assert.deepEqual(await readdir(join(h.dir, "video-work")), []);
  } finally {
    await h.cleanup();
  }
});

test("cancelling queued and rendering videos never publishes late results", async () => {
  const h = await setup();
  try {
    const active = await h.service.create("resource-a", project);
    const queued = await h.service.create("resource-b", project);
    assert.equal(h.service.cancel(queued.id).status, "cancelled");
    assert.equal(h.service.cancel(active.id).status, "cancelled");
    assert.equal(h.renders[0].options.signal?.aborted, true);
    assert.equal(
      h.service.isBusy,
      true,
      "取消信号发出后仍应等本地渲染进程退出",
    );
    // A renderer can resolve just after cancellation; its output is still untrusted.
    await h.finish();
    await eventually(() => !h.service.isBusy);
    assert.equal(h.renders.length, 1);
    assert.equal(h.service.jobs("resource-a")[0].videoUrl, undefined);
    assert.equal(h.service.jobs("resource-b")[0].status, "cancelled");
    await assert.rejects(h.service.output(active.id, "video"), {
      code: "VIDEO_NOT_READY",
    });
    assert.deepEqual(await readdir(join(h.dir, "video-work")), []);
  } finally {
    await h.cleanup();
  }
});

test("failed renders retain a useful error, release the queue and permit explicit retry", async () => {
  const h = await setup();
  try {
    const failed = await h.service.create("resource-a", project);
    h.renders[0].gate.reject(new Error("编码失败：请检查本地字体"));
    await eventually(() => !h.service.isBusy);
    assert.equal(h.service.jobs("resource-a")[0].status, "failed");
    assert.match(h.service.jobs("resource-a")[0].error!, /编码失败/);
    const retry = await h.service.create("resource-a", project);
    assert.notEqual(retry.id, failed.id);
    await h.finish(1);
    await eventually(() => !h.service.isBusy);
    assert.equal(
      h.service.jobs("resource-a").find((job) => job.id === retry.id)?.status,
      "completed",
    );
    assert.equal(
      h.service.jobs("resource-a").find((job) => job.id === failed.id)?.status,
      "failed",
    );
  } finally {
    await h.cleanup();
  }
});

test("unavailable runtime and non-local inputs cannot enqueue a video", async () => {
  const h = await setup({
    runtime: async () => ({
      available: false,
      browserExecutable: null,
      message: "未找到浏览器",
    }),
  });
  try {
    await assert.rejects(h.service.create("resource-a", project), {
      code: "VIDEO_RUNTIME_UNAVAILABLE",
    });
    await assert.rejects(
      h.service.create("resource-a", {
        ...project,
        template: "slideshow",
        slides: [{ src: "https://example.com/private.png" }],
      }),
    );
    assert.equal(h.service.jobs("resource-a").length, 0);
    assert.equal(h.renders.length, 0);
    assert.equal(h.service.isBusy, false);
  } finally {
    await h.cleanup();
  }
});

test("interrupted persisted jobs become retryable failures without automatic rendering", async () => {
  const h = await setup();
  try {
    const timestamp = new Date().toISOString();
    for (const status of ["queued", "rendering"] as const) {
      const jobId = id("video");
      h.db.setSetting(`local-video:job:${jobId}`, {
        id: jobId,
        sourceId: status,
        project: { title: "中断任务" },
        status,
        progress: 0.4,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    let invoked = false;
    const recovered = new VideoService(h.db, h.dir, () => {}, {
      runtime,
      render: async () => {
        invoked = true;
        throw new Error("不能自动渲染");
      },
    });
    assert.equal(recovered.isBusy, false);
    assert.equal(invoked, false);
    for (const source of ["queued", "rendering"]) {
      assert.equal(recovered.jobs(source)[0].status, "failed");
      assert.match(recovered.jobs(source)[0].error!, /中断/);
      assert.equal(recovered.jobs(source)[0].progress, 0.4);
    }
  } finally {
    await h.cleanup();
  }
});

test("completed local assets are content-addressed and require a completed job and regular file", async () => {
  const h = await setup();
  try {
    const job = await h.service.create("resource-a", project);
    await h.finish();
    await eventually(() => !h.service.isBusy);
    const completed = h.service.jobs("resource-a")[0];
    const hash = createHash("sha256").update(mp4).digest("hex");
    assert.equal(completed.videoUrl, `panxu-media://local-video/${hash}.mp4`);
    assert.match(
      completed.coverUrl!,
      /^panxu-media:\/\/local-video\/[a-f0-9]{64}\.png$/,
    );
    const output = await h.service.output(job.id, "video");
    assert.equal(output.path, join(h.dir, "media", `${hash}.mp4`));
    assert.deepEqual(await readFile(output.path), mp4);
    assert.equal(await fileHash(output.path), hash);
    await assert.rejects(h.service.assetPath("../../panxu.db"), {
      code: "VIDEO_ASSET_NOT_FOUND",
    });
    const unowned = `${"0".repeat(64)}.mp4`;
    await writeFile(join(h.dir, "media", unowned), mp4);
    await assert.rejects(h.service.assetPath(unowned), {
      code: "VIDEO_ASSET_NOT_FOUND",
    });
    await rm(join(h.dir, "media", unowned));
    await rm(output.path);
    await symlink(join(h.dir, "panxu.db"), output.path);
    await assert.rejects(h.service.output(job.id, "video"), {
      code: "VIDEO_ASSET_NOT_FOUND",
    });
  } finally {
    await h.cleanup();
  }
});

test("archiving rejects a pre-existing symbolic link without modifying its target", async () => {
  const h = await setup();
  try {
    const media = join(h.dir, "media");
    await mkdir(media);
    const protectedPath = join(h.dir, "unrelated-local-file.txt");
    const original = Buffer.from("这份本地文件不能被视频归档覆盖");
    await writeFile(protectedPath, original);
    const hash = createHash("sha256").update(mp4).digest("hex");
    const destination = join(media, `${hash}.mp4`);
    await symlink(protectedPath, destination);
    const job = await h.service.create("resource-a", project);
    await h.finish();
    await eventually(() => !h.service.isBusy);
    const failed = h.service.jobs("resource-a")[0];
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /归档.*不正确/);
    assert.equal(failed.videoUrl, undefined);
    assert.deepEqual(await readFile(protectedPath), original);
    assert.equal((await lstat(destination)).isSymbolicLink(), true);
    await assert.rejects(h.service.output(job.id, "video"), {
      code: "VIDEO_NOT_READY",
    });
  } finally {
    await h.cleanup();
  }
});

test("archiving reuses existing matching video and cover bytes without replacing the files", async () => {
  const h = await setup();
  try {
    const media = join(h.dir, "media");
    await mkdir(media);
    const videoName = `${createHash("sha256").update(mp4).digest("hex")}.mp4`;
    const coverName = `${createHash("sha256").update(png).digest("hex")}.png`;
    const videoPath = join(media, videoName);
    const coverPath = join(media, coverName);
    await writeFile(videoPath, mp4);
    await writeFile(coverPath, png);
    const originalVideo = await lstat(videoPath);
    const originalCover = await lstat(coverPath);
    const job = await h.service.create("resource-a", project);
    await h.finish();
    await eventually(() => !h.service.isBusy);
    const completed = h.service.jobs("resource-a")[0];
    assert.equal(completed.status, "completed");
    assert.equal(completed.videoUrl, `panxu-media://local-video/${videoName}`);
    assert.equal(completed.coverUrl, `panxu-media://local-video/${coverName}`);
    assert.equal((await h.service.output(job.id, "video")).path, videoPath);
    assert.equal((await h.service.output(job.id, "cover")).path, coverPath);
    for (const [path, before] of [
      [videoPath, originalVideo],
      [coverPath, originalCover],
    ] as const) {
      const after = await lstat(path);
      assert.equal(after.ino, before.ino);
      assert.equal(after.mtimeMs, before.mtimeMs);
    }
    assert.deepEqual(await readFile(videoPath), mp4);
    assert.deepEqual(await readFile(coverPath), png);
    assert.deepEqual(
      (await readdir(media)).sort(),
      [videoName, coverName].sort(),
    );
  } finally {
    await h.cleanup();
  }
});

test("backup inspection retains completed local videos and rejects a missing referenced asset", async () => {
  const h = await setup();
  try {
    const job = await h.service.create("resource-a", project);
    await h.finish();
    await eventually(() => !h.service.isBusy);
    const video = await h.service.output(job.id, "video");
    const cover = await h.service.output(job.id, "cover");
    const folder = join(h.dir, "backup");
    await mkdir(join(folder, "media"), { recursive: true });
    h.db.run("VACUUM INTO ?", join(folder, "panxu.db"));
    await copyFile(video.path, join(folder, "media", basename(video.path)));
    await copyFile(cover.path, join(folder, "media", basename(cover.path)));
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        product: "panxu-studio",
        schemaVersion: databaseSchemaVersion,
        createdAt: new Date().toISOString(),
        credentialsIncluded: false,
        databaseSha256: await fileHash(join(folder, "panxu.db")),
      }),
    );
    const backup = await inspectBackup(folder);
    assert.ok(backup.media.includes(basename(video.path)));
    assert.ok(backup.media.includes(basename(cover.path)));
    await rm(join(folder, "media", basename(video.path)));
    await assert.rejects(inspectBackup(folder), { code: "INVALID_BACKUP" });
  } finally {
    await h.cleanup();
  }
});

test("closing marks pending videos interrupted and ignores late progress and output after database shutdown", async () => {
  const h = await setup();
  let closed = false;
  try {
    await h.service.create("resource-a", project);
    await h.service.create("resource-b", project);
    const broadcasts = h.changes;
    h.service.close();
    assert.equal(h.renders[0].options.signal?.aborted, true);
    for (const source of ["resource-a", "resource-b"]) {
      assert.equal(h.service.jobs(source)[0].status, "failed");
      assert.match(h.service.jobs(source)[0].error!, /关闭中断/);
    }
    h.db.close();
    closed = true;
    assert.doesNotThrow(() =>
      h.renders[0].options.onProgress?.({ stage: "rendering", progress: 0.9 }),
    );
    await h.finish();
    await eventually(() => !h.service.isBusy);
    assert.equal(h.renders.length, 1, "关闭后不得启动排队任务");
    assert.equal(h.changes, broadcasts, "关闭后不得触发共享快照刷新");
    assert.deepEqual(await readdir(join(h.dir, "video-work")), []);
    await assert.rejects(h.service.create("resource-c", project), {
      code: "VIDEO_CLOSED",
    });
  } finally {
    await h.cleanup(closed);
  }
});

test("closing while readiness is pending cannot enqueue against a closed database", async () => {
  const ready = deferred<Awaited<ReturnType<typeof runtime>>>();
  const h = await setup({ runtime: async () => ready.promise });
  let closed = false;
  try {
    const pending = h.service.create("resource-a", project);
    h.service.close();
    h.db.close();
    closed = true;
    ready.resolve(await runtime());
    await assert.rejects(pending, { code: "VIDEO_CLOSED" });
    assert.equal(h.service.isBusy, false);
    assert.equal(h.renders.length, 0);
    assert.equal(h.changes, 0);
  } finally {
    await h.cleanup(closed);
  }
});

test("runtime readiness counts as busy and shutdown waits for all pending checks", async () => {
  const ready = [
    deferred<Awaited<ReturnType<typeof runtime>>>(),
    deferred<Awaited<ReturnType<typeof runtime>>>(),
  ];
  let check = 0;
  const h = await setup({ runtime: async () => ready[check++].promise });
  try {
    const first = assert.rejects(h.service.create("resource-a", project), {
      code: "VIDEO_CLOSED",
    });
    const second = assert.rejects(h.service.create("resource-b", project), {
      code: "VIDEO_CLOSED",
    });
    assert.equal(check, 2);
    assert.equal(h.service.isBusy, true);
    assert.equal(h.service.jobs("resource-a").length, 0);
    assert.equal(h.service.jobs("resource-b").length, 0);
    let stopped = false;
    const shutdown = h.service.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    assert.equal(stopped, false);
    ready[0].resolve(await runtime());
    await first;
    assert.equal(
      h.service.isBusy,
      true,
      "另一个预检尚未返回时仍须阻止空间切换",
    );
    assert.equal(stopped, false);
    ready[1].resolve(await runtime());
    await second;
    await shutdown;
    assert.equal(stopped, true);
    assert.equal(h.service.isBusy, false);
    assert.equal(h.renders.length, 0);
    assert.equal(h.changes, 0);
  } finally {
    for (const pending of ready) pending.resolve(await runtime());
    await h.cleanup();
  }
});

test("shutdown waits for the renderer and temporary-file cleanup before resolving", async () => {
  const h = await setup();
  try {
    await h.service.create("resource-a", project);
    await h.service.create("resource-b", project);
    await mkdir(h.renders[0].options.outputDirectory, { recursive: true });
    await writeFile(
      join(h.renders[0].options.outputDirectory, "partial.tmp"),
      "render-in-progress",
    );
    let stopped = false;
    const shutdown = h.service.shutdown().then(() => {
      stopped = true;
    });
    const repeated = h.service.shutdown();
    assert.equal(h.renders[0].options.signal?.aborted, true);
    assert.equal(h.service.isBusy, true);
    await Promise.resolve();
    assert.equal(stopped, false, "发送取消信号不等于渲染器已经退出");
    assert.deepEqual(await readdir(h.renders[0].options.outputDirectory), [
      "partial.tmp",
    ]);
    await h.finish();
    await Promise.all([shutdown, repeated]);
    assert.equal(stopped, true);
    assert.equal(h.service.isBusy, false);
    assert.equal(h.renders.length, 1, "退出时不能启动排队任务");
    assert.equal(h.service.jobs("resource-a")[0].status, "failed");
    assert.equal(h.service.jobs("resource-b")[0].status, "failed");
    assert.equal(h.service.jobs("resource-a")[0].videoUrl, undefined);
    assert.deepEqual(await readdir(join(h.dir, "video-work")), []);
    await h.service.shutdown();
  } finally {
    await h.cleanup();
  }
});
