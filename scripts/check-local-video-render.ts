/** Real local-only render QA. Owns one temporary DB; never connects to Electron. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Database } from "../core/database";
import { VideoService } from "../core/video-service";
import { localVideoBinariesDirectory } from "../core/video-renderer/runtime";

const dataPath = await mkdtemp(join(tmpdir(), "panxu-video-service-render-"));
const evidence = resolve("test-results/local-video");
const databasePath = join(dataPath, "panxu.db");
const sourceId = "qa:local-video-service";
let db = new Database(databasePath);
let service = new VideoService(db, dataPath, () => {}, {
  bundlePath: resolve("build/video-remotion"),
});
async function until(predicate: () => boolean, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "本地视频制作超时");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
try {
  const runtime = await service.runtime();
  assert.equal(runtime.available, true, runtime.message);
  const created = await service.create(sourceId, {
    title: "学习资料目录",
    subtitle: "本地模板合成 · 真实 1080p 制作验证",
    entries: Array.from({ length: 14 }, (_, index) => ({
      name:
        index % 3 === 0
          ? `第 ${index + 1} 项：一份较长的中文资料名称，验证完整换行和滚动展示.pdf`
          : `第 ${index + 1} 项：学习资料与练习清单.pdf`,
      kind: index % 4 === 0 ? "folder" : "file",
    })),
    durationSeconds: 6,
    aspectRatio: "9:16",
  });
  await until(() => !service.isBusy);
  const completed = service
    .jobs(sourceId)
    .find((job) => job.id === created.id)!;
  assert.equal(completed.status, "completed", completed.error ?? "视频未完成");
  assert.equal(completed.progress, 1);
  const video = await service.output(created.id, "video");
  const cover = await service.output(created.id, "cover");
  assert.equal(await service.assetPath(basename(video.path)), video.path);
  assert.equal(await service.assetPath(basename(cover.path)), cover.path);
  await assert.rejects(service.assetPath("../panxu.db"));
  assert.deepEqual(await readdir(join(dataPath, "video-work")), []);
  const png = await readFile(cover.path);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), 1920);
  const ffprobe =
    process.env.PANXU_FFPROBE_PATH ??
    join(
      localVideoBinariesDirectory(),
      process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
    );
  const binariesDirectory = localVideoBinariesDirectory();
  const probe = JSON.parse(
    execFileSync(
      ffprobe,
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        video.path,
      ],
      {
        encoding: "utf8",
        cwd: binariesDirectory,
        env:
          process.platform === "darwin"
            ? { ...process.env, DYLD_LIBRARY_PATH: binariesDirectory }
            : process.env,
      },
    ),
  );
  const stream = probe.streams.find(
    (entry: { codec_type: string }) => entry.codec_type === "video",
  );
  assert.equal(stream.codec_name, "h264");
  assert.equal(stream.width, 1080);
  assert.equal(stream.height, 1920);
  assert.ok(Math.abs(Number(probe.format.duration) - 6) < 0.1);
  service.close();
  db.close();
  db = new Database(databasePath);
  service = new VideoService(db, dataPath, () => {}, {
    bundlePath: resolve("build/video-remotion"),
  });
  assert.equal(service.jobs(sourceId)[0].status, "completed");
  assert.equal((await service.output(created.id, "video")).path, video.path);
  await mkdir(evidence, { recursive: true });
  await copyFile(video.path, join(evidence, "service-1080-video.mp4"));
  await copyFile(cover.path, join(evidence, "service-1080-cover.png"));
  const result = {
    passed: true,
    checks: [
      "真实预构建模板",
      "临时数据库任务队列",
      "默认1080p竖屏",
      "H.264 MP4六秒",
      "PNG封面",
      "工作目录清理",
      "安全素材读取",
      "重开数据库后成片保持完成",
    ],
    video: join(evidence, "service-1080-video.mp4"),
    cover: join(evidence, "service-1080-cover.png"),
    width: stream.width,
    height: stream.height,
    duration: Number(probe.format.duration),
  };
  await writeFile(
    join(evidence, "service-render-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  service.close();
  await until(() => !service.isBusy, 30_000).catch(() => {});
  db.close();
  await rm(dataPath, { recursive: true, force: true });
}
