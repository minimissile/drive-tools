import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, file } from "./helpers";
import { createVideoHandlers } from "../core/ipc/video";
import { VideoService } from "../core/video-service";

test("video source adapter uses recorded files and removes links and extraction credentials from default copy", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false, {
      summary: "练习材料 https://pan.quark.cn/s/private 提取码：abcd",
    });
    f.app.db.run(
      "UPDATE copies SET files=? WHERE id=?",
      JSON.stringify([file]),
      saved.copyId,
    );
    const source = (await f.app.invoke("video.source", {
      copyId: saved.copyId,
    })) as {
      title: string;
      subtitle: string;
      entries: { name: string; kind: string }[];
    };
    assert.equal(source.title, "AI办公练习清单");
    assert.equal(source.subtitle, "练习材料");
    assert.deepEqual(source.entries, [{ name: file.name, kind: "file" }]);
    await assert.rejects(
      f.app.invoke("video.source", { copyId: "missing" }),
      /资源副本不存在/,
    );
  } finally {
    await f.cleanup();
  }
});

test("video IPC imports local media, validates creation, and exports only a finished output", async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "panxu-video-ipc-"));
  const video = new VideoService(f.app.db, f.dir, () => {}, {
    runtime: async () => ({
      available: true,
      browserExecutable: "/unused/chrome",
      message: "测试",
    }),
    render: async ({ outputDirectory }) => {
      await mkdir(outputDirectory, { recursive: true });
      const videoPath = join(outputDirectory, "video.mp4"),
        coverPath = join(outputDirectory, "cover.png");
      await writeFile(videoPath, Buffer.from("local-video-output"));
      await writeFile(coverPath, Buffer.from("local-cover-output"));
      return {
        videoPath,
        coverPath,
        width: 1080,
        height: 1920,
        durationSeconds: 6,
      };
    },
  });
  try {
    const exported: { name: string; bytes: Buffer }[] = [];
    f.ports.readVideoImages = async () => [
      { name: "截图.png", bytes: Buffer.from("normalized-image") },
    ];
    f.ports.readVideoAudio = async () => ({
      name: "配乐.mp3",
      mime: "audio/mpeg",
      bytes: Buffer.from("local-audio"),
    });
    f.ports.saveFile = async (name, bytes) => {
      exported.push({ name, bytes });
      return join(directory, name);
    };
    const handlers = createVideoHandlers({
      video,
      repo: f.app.repo,
      ports: f.ports,
      dataPath: f.dir,
    });
    const images = await handlers["video.importImages"]();
    assert.deepEqual(images, [
      {
        src: `data:image/png;base64,${Buffer.from("normalized-image").toString("base64")}`,
        caption: "截图",
      },
    ]);
    assert.deepEqual(await handlers["video.importAudio"](), {
      name: "配乐.mp3",
      src: `data:audio/mpeg;base64,${Buffer.from("local-audio").toString("base64")}`,
    });
    await assert.rejects(
      handlers["video.create"]({
        sourceId: "other-module:example",
        project: {
          title: "非法素材",
          template: "slideshow",
          slides: [{ src: "https://example.com/image.png" }],
        },
      }),
    );
    const job = await handlers["video.create"]({
      sourceId: "other-module:example",
      project: {
        title: "目录/预览",
        durationSeconds: 6,
        entries: [{ name: "真实文件.txt", kind: "file" }],
      },
    });
    while (video.isBusy) await new Promise((resolve) => setTimeout(resolve, 5));
    await handlers["video.export"]({ id: job.id, kind: "video" });
    await handlers["video.export"]({ id: job.id, kind: "cover" });
    assert.deepEqual(
      exported.map((output) => output.name),
      ["目录_预览.mp4", "目录_预览-封面.png"],
    );
    assert.equal(exported[0].bytes.toString(), "local-video-output");
    await assert.rejects(
      handlers["video.export"]({ id: job.id, kind: "other" }),
    );
    f.ports.readVideoImages = async () => [];
    f.ports.readVideoAudio = async () => null;
    assert.deepEqual(await handlers["video.importImages"](), []);
    assert.equal(await handlers["video.importAudio"](), null);
  } finally {
    video.close();
    await rm(directory, { recursive: true, force: true });
    await f.cleanup();
  }
});
