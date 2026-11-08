import { z } from "zod";

/** Business-neutral input: callers provide their own real content and local assets. */
const imageData = z
  .string()
  .max(12 * 1024 * 1024)
  .regex(
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
    "视频图片须为本地 PNG、JPEG 或 WebP 素材。",
  );
const audioData = z
  .string()
  .max(28 * 1024 * 1024)
  .regex(
    /^data:audio\/(?:mpeg|mp3|wav|x-wav|ogg|mp4|aac);base64,[A-Za-z0-9+/]+={0,2}$/,
    "配乐须为本地音频素材。",
  );
export const videoProjectSchema = z
  .object({
    template: z
      .enum(["directory-scroll", "slideshow"])
      .default("directory-scroll"),
    title: z.string().trim().min(1).max(160),
    subtitle: z.string().trim().max(400).default(""),
    entries: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(500),
          kind: z.enum(["folder", "file"]).default("file"),
        }),
      )
      .max(120)
      .default([]),
    slides: z
      .array(
        z.object({
          src: imageData,
          caption: z.string().trim().max(200).default(""),
        }),
      )
      .max(12)
      .default([]),
    aspectRatio: z.enum(["9:16", "16:9"]).default("9:16"),
    durationSeconds: z.number().int().min(6).max(60).default(12),
    audio: z
      .object({
        src: audioData,
        volume: z.number().min(0).max(1).default(0.25),
      })
      .optional(),
  })
  .superRefine((project, ctx) => {
    if (project.template === "directory-scroll" && !project.entries.length)
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "请先提供实际目录内容。",
      });
    if (project.template === "slideshow" && !project.slides.length)
      ctx.addIssue({
        code: "custom",
        path: ["slides"],
        message: "请先添加至少一张预览图片。",
      });
    const assetBytes =
      project.slides.reduce((size, slide) => size + slide.src.length, 0) +
      (project.audio?.src.length ?? 0);
    if (assetBytes > 48 * 1024 * 1024)
      ctx.addIssue({
        code: "custom",
        path: ["slides"],
        message: "视频素材总大小超过 48 MB，请减少或压缩素材。",
      });
  });
export type VideoProject = z.infer<typeof videoProjectSchema>;
export type VideoProjectInput = z.input<typeof videoProjectSchema>;
export const localVideoTemplates = [
  {
    id: "directory-scroll",
    name: "目录展示",
    description: "滚动展示实际文件或文件夹目录。",
  },
  {
    id: "slideshow",
    name: "资料预览",
    description: "依次展示本地图片与配套说明。",
  },
] as const;
export const VIDEO_FPS = 30;
export const VIDEO_COMPOSITION_ID = "LocalVideo";
export function videoDimensions(aspectRatio: VideoProject["aspectRatio"]) {
  return aspectRatio === "9:16"
    ? { width: 1080, height: 1920 }
    : { width: 1920, height: 1080 };
}
export interface LocalVideoProgress {
  stage: "preparing" | "rendering" | "cover" | "completed";
  /** Overall fraction from 0 to 1. */
  progress: number;
}
export interface LocalVideoRuntime {
  available: boolean;
  browserExecutable: string | null;
  message: string;
}
export interface LocalVideoResult {
  videoPath: string;
  coverPath: string;
  width: number;
  height: number;
  durationSeconds: number;
}
