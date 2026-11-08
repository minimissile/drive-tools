import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { videoProjectSchema } from "../shared/video";
import {
  getLocalVideoRuntime,
  renderLocalVideo,
  type LocalVideoRendererDependencies,
} from "../core/video-renderer";
import { unpackedVideoBinaryPath } from "../core/video-renderer/runtime";
import { createVideoTemplateBundler } from "../core/video-renderer/bundle";

const project = {
  title: "真实目录",
  entries: [{ name: "教学资料.pdf", kind: "file" as const }],
};

test("packaged compositor binaries use real unpacked paths on macOS and Windows", () => {
  assert.equal(
    unpackedVideoBinaryPath(
      "/Applications/Panxu.app/Contents/Resources/app.asar/node_modules/@remotion/compositor-darwin-arm64",
    ),
    "/Applications/Panxu.app/Contents/Resources/app.asar.unpacked/node_modules/@remotion/compositor-darwin-arm64",
  );
  assert.equal(
    unpackedVideoBinaryPath(
      "C:\\Panxu\\resources\\app.asar\\node_modules\\@remotion\\compositor-win32-x64-msvc",
    ),
    "C:\\Panxu\\resources\\app.asar.unpacked\\node_modules\\@remotion\\compositor-win32-x64-msvc",
  );
  assert.equal(
    unpackedVideoBinaryPath("/work/app.asar.backup/node_modules/compositor"),
    "/work/app.asar.backup/node_modules/compositor",
  );
});
type Renderer = Awaited<ReturnType<LocalVideoRendererDependencies["renderer"]>>;
function fixture(overrides: Record<string, unknown> = {}) {
  const calls = {
    opens: 0,
    closes: 0,
    runtime: 0,
    media: 0,
    stills: 0,
    cancelled: 0,
  };
  const renderer = {
    openBrowser: async () => {
      calls.opens++;
      return {
        close: async () => {
          calls.closes++;
        },
      };
    },
    makeCancelSignal: () => ({
      cancelSignal: {},
      cancel: () => {
        calls.cancelled++;
      },
    }),
    selectComposition: async () => ({
      id: "LocalVideo",
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 360,
    }),
    renderMedia: async (options: {
      outputLocation: string;
      onProgress: (v: { progress: number }) => void;
    }) => {
      calls.media++;
      options.onProgress({ progress: 0.5 });
      await writeFile(options.outputLocation, "locally-rendered-video");
    },
    renderStill: async (options: { output: string }) => {
      calls.stills++;
      await writeFile(options.output, "locally-rendered-cover");
    },
    ...overrides,
  } as unknown as Renderer;
  const deps: LocalVideoRendererDependencies = {
    runtime: async () => {
      calls.runtime++;
      return {
        available: true,
        browserExecutable: "/local/chrome",
        message: "ready",
      };
    },
    renderer: async () => renderer,
    bundle: async () => "/local/bundle",
    binariesDirectory: () => "/local/binaries",
  };
  return { deps, calls };
}
async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "panxu-video-renderer-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("editing an imported template invalidates its bundle without restarting the renderer", async (t) => {
  const directory = await temporary(t);
  const templates = join(directory, "templates");
  await mkdir(templates);
  const entryPoint = join(templates, "index.tsx");
  const component = join(templates, "composition.tsx");
  await writeFile(entryPoint, "import './composition';");
  await writeFile(component, "first layout");
  let builds = 0;
  const bundle = createVideoTemplateBundler(async () => `/bundled/${++builds}`);
  assert.equal(await bundle(entryPoint), "/bundled/1");
  assert.equal(await bundle(entryPoint), "/bundled/1");
  await writeFile(component, "second updated layout");
  assert.equal(await bundle(entryPoint), "/bundled/2");
  assert.equal(builds, 2);
});

test("local video rejects remote images and audio before invoking the renderer", async (t) => {
  const directory = await temporary(t);
  const { deps, calls } = fixture();
  await assert.rejects(
    renderLocalVideo(
      {
        project: {
          ...project,
          template: "slideshow",
          slides: [{ src: "https://example.com/private.png" }],
        },
        outputDirectory: directory,
      },
      deps,
    ),
  );
  await assert.rejects(
    renderLocalVideo(
      {
        project: { ...project, audio: { src: "file:///private/audio.mp3" } },
        outputDirectory: directory,
      },
      deps,
    ),
  );
  assert.equal(calls.runtime, 0);
  assert.equal(calls.opens, 0);
  assert.deepEqual(await readdir(directory), []);
});

test("each template requires actual input instead of rendering invented empty content", () => {
  assert.equal(videoProjectSchema.safeParse({ title: "目录" }).success, false);
  assert.equal(
    videoProjectSchema.safeParse({ title: "预览", template: "slideshow" })
      .success,
    false,
  );
  assert.equal(
    videoProjectSchema.safeParse({ ...project, durationSeconds: 100000 })
      .success,
    false,
  );
});

test("successful rendering publishes both outputs, closes the browser, and leaves no staging files", async (t) => {
  const directory = await temporary(t);
  const { deps, calls } = fixture();
  const progress: number[] = [];
  const result = await renderLocalVideo(
    {
      project,
      outputDirectory: directory,
      onProgress: (p) => progress.push(p.progress),
    },
    deps,
  );
  assert.equal(
    await readFile(result.videoPath, "utf8"),
    "locally-rendered-video",
  );
  assert.equal(
    await readFile(result.coverPath, "utf8"),
    "locally-rendered-cover",
  );
  assert.deepEqual(await readdir(directory), ["cover.png", "video.mp4"]);
  assert.equal(calls.opens, 1);
  assert.equal(calls.closes, 1);
  assert.equal(progress.at(-1), 1);
  assert.ok(
    progress.every(
      (value, index) => index === 0 || value >= progress[index - 1],
    ),
  );
  assert.deepEqual(
    {
      width: result.width,
      height: result.height,
      durationSeconds: result.durationSeconds,
    },
    { width: 1080, height: 1920, durationSeconds: 12 },
  );
});

test("a cover failure cleans the temporary video and preserves unrelated local files", async (t) => {
  const directory = await temporary(t);
  await writeFile(join(directory, "keep.txt"), "keep");
  const { deps, calls } = fixture({
    renderStill: async () => {
      throw new Error("cannot render cover");
    },
  });
  await assert.rejects(
    renderLocalVideo({ project, outputDirectory: directory }, deps),
    /cannot render cover/,
  );
  assert.equal(calls.closes, 1);
  assert.deepEqual(await readdir(directory), ["keep.txt"]);
});

test("cancellation during rendering releases its browser and never publishes a partial result", async (t) => {
  const directory = await temporary(t);
  const controller = new AbortController();
  const { deps, calls } = fixture({
    renderMedia: async (options: { outputLocation: string }) => {
      await writeFile(options.outputLocation, "unfinished");
      controller.abort();
    },
  });
  await assert.rejects(
    renderLocalVideo(
      { project, outputDirectory: directory, signal: controller.signal },
      deps,
    ),
    (error: unknown) => (error as { code: string }).code === "VIDEO_CANCELLED",
  );
  assert.equal(calls.cancelled, 1);
  assert.ok(calls.closes >= 1);
  assert.deepEqual(await readdir(directory), []);
});

test("cancelled and existing-output jobs never start browser work or overwrite a result", async (t) => {
  const directory = await temporary(t);
  const { deps, calls } = fixture();
  await assert.rejects(
    renderLocalVideo(
      { project, outputDirectory: directory, signal: AbortSignal.abort() },
      deps,
    ),
    /已取消/,
  );
  await writeFile(join(directory, "video.mp4"), "original");
  await assert.rejects(
    renderLocalVideo({ project, outputDirectory: directory }, deps),
    /已有成片/,
  );
  assert.equal(
    await readFile(join(directory, "video.mp4"), "utf8"),
    "original",
  );
  assert.equal(calls.opens, 0);
});

test("runtime discovery reports a missing explicit browser and never tries to download it", async (t) => {
  const directory = await temporary(t);
  await mkdir(join(directory, "not-a-browser"));
  const runtime = await getLocalVideoRuntime({
    browserExecutable: join(directory, "not-a-browser"),
  });
  assert.equal(runtime.available, false);
  assert.equal(runtime.browserExecutable, null);
  assert.match(runtime.message, /浏览器无法运行/);
  assert.deepEqual(await readdir(directory), ["not-a-browser"]);
});
