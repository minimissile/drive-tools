import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { AppError } from "../errors";
import {
  VIDEO_COMPOSITION_ID,
  videoDimensions,
  videoProjectSchema,
  type LocalVideoProgress,
  type LocalVideoResult,
  type VideoProjectInput,
} from "../../shared/video";
import {
  getLocalVideoRuntime,
  localVideoBinariesDirectory,
  type LocalVideoRuntimeOptions,
} from "./runtime";
export { getLocalVideoRuntime } from "./runtime";
import { createVideoTemplateBundler } from "./bundle";

export interface RenderLocalVideoOptions extends LocalVideoRuntimeOptions {
  project: VideoProjectInput;
  outputDirectory: string;
  /** Development source; production callers should provide a prebuilt bundlePath. */
  templateEntryPoint?: string;
  onProgress?: (progress: LocalVideoProgress) => void;
  signal?: AbortSignal;
  /** Optional output scale for previews; normal exports remain 1080p. */
  scale?: number;
}

export interface LocalVideoRendererDependencies {
  runtime: typeof getLocalVideoRuntime;
  renderer: () => Promise<typeof import("@remotion/renderer")>;
  bundle: (entryPoint: string) => Promise<string>;
  binariesDirectory: () => string;
}
const defaults: LocalVideoRendererDependencies = {
  runtime: getLocalVideoRuntime,
  renderer: () => import("@remotion/renderer"),
  binariesDirectory: localVideoBinariesDirectory,
  bundle: createVideoTemplateBundler(),
};
const cancelled = () => new AppError("VIDEO_CANCELLED", "视频制作已取消。");
function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * A deterministic, local-only renderer. No database, business records, AI APIs or
 * publication concerns belong here. Callers own their job queue and persistence.
 */
export async function renderLocalVideo(
  options: RenderLocalVideoOptions,
  deps: LocalVideoRendererDependencies = defaults,
): Promise<LocalVideoResult> {
  const project = videoProjectSchema.parse(options.project);
  assertActive(options.signal);
  if (!isAbsolute(options.outputDirectory))
    throw new AppError(
      "VIDEO_OUTPUT_INVALID",
      "视频输出目录必须是本地绝对路径。",
    );
  if (options.bundlePath && !isAbsolute(options.bundlePath))
    throw new AppError(
      "VIDEO_BUNDLE_INVALID",
      "视频模板必须使用本地构建目录。",
    );
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 1)
    throw new AppError(
      "VIDEO_SCALE_INVALID",
      "视频预览比例必须在 0.1 到 1 之间。",
    );
  const directory = resolve(options.outputDirectory);
  const videoPath = join(directory, "video.mp4");
  const coverPath = join(directory, "cover.png");
  if ((await exists(videoPath)) || (await exists(coverPath)))
    throw new AppError(
      "VIDEO_OUTPUT_EXISTS",
      "输出目录已有成片，请使用新的制作任务目录。",
    );
  options.onProgress?.({ stage: "preparing", progress: 0 });
  const runtime = await deps.runtime(options);
  assertActive(options.signal);
  if (!runtime.available || !runtime.browserExecutable)
    throw new AppError("VIDEO_RUNTIME_UNAVAILABLE", runtime.message);
  const entryPoint =
    options.templateEntryPoint ??
    join(process.cwd(), "video-templates/index.tsx");
  const serveUrl = options.bundlePath ?? (await deps.bundle(entryPoint));
  assertActive(options.signal);
  const renderer = await deps.renderer();
  const staging = join(directory, `.render-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  const temporaryVideo = join(staging, "video.mp4");
  const temporaryCover = join(staging, "cover.png");
  const { cancelSignal, cancel } = renderer.makeCancelSignal();
  let browser: Awaited<ReturnType<typeof renderer.openBrowser>> | undefined;
  let publishedVideo = false;
  let publishedCover = false;
  const abort = () => {
    cancel();
    // Composition discovery has no cancelSignal. Closing only our browser also
    // interrupts discovery and releases its processes promptly.
    void browser?.close({ silent: true }).catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    assertActive(options.signal);
    browser = await renderer.openBrowser("chrome", {
      browserExecutable: runtime.browserExecutable,
      logLevel: "error",
    });
    assertActive(options.signal);
    const common = {
      serveUrl,
      inputProps: { project },
      puppeteerInstance: browser,
      browserExecutable: runtime.browserExecutable,
      binariesDirectory: options.binariesDirectory ?? deps.binariesDirectory(),
      logLevel: "error" as const,
      timeoutInMilliseconds: 30_000,
    };
    const composition = await renderer.selectComposition({
      ...common,
      id: VIDEO_COMPOSITION_ID,
    });
    assertActive(options.signal);
    options.onProgress?.({ stage: "rendering", progress: 0.05 });
    await renderer.renderMedia({
      ...common,
      composition,
      outputLocation: temporaryVideo,
      codec: "h264",
      pixelFormat: "yuv420p",
      crf: 20,
      concurrency: 2,
      scale,
      cancelSignal,
      onProgress: ({ progress }) =>
        options.onProgress?.({
          stage: "rendering",
          progress: 0.05 + progress * 0.88,
        }),
    });
    assertActive(options.signal);
    options.onProgress?.({ stage: "cover", progress: 0.94 });
    await renderer.renderStill({
      ...common,
      composition,
      output: temporaryCover,
      imageFormat: "png",
      frame: Math.min(15, composition.durationInFrames - 1),
      scale,
      cancelSignal,
    });
    assertActive(options.signal);
    if (
      !(await stat(temporaryVideo)).size ||
      !(await stat(temporaryCover)).size
    )
      throw new AppError(
        "VIDEO_OUTPUT_EMPTY",
        "视频或封面未生成，请重试制作。",
      );
    // Hard links publish without overwriting an existing file and are atomic
    // because staging is under the destination directory on the same volume.
    await link(temporaryVideo, videoPath);
    publishedVideo = true;
    await link(temporaryCover, coverPath);
    publishedCover = true;
    assertActive(options.signal);
    const dimensions = videoDimensions(project.aspectRatio);
    options.onProgress?.({ stage: "completed", progress: 1 });
    return {
      videoPath,
      coverPath,
      width: Math.round(dimensions.width * scale),
      height: Math.round(dimensions.height * scale),
      durationSeconds: project.durationSeconds,
    };
  } catch (error) {
    if (publishedVideo) await rm(videoPath, { force: true });
    if (publishedCover) await rm(coverPath, { force: true });
    if (options.signal?.aborted) throw cancelled();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await browser?.close({ silent: true }).catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}
