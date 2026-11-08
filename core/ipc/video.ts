import { readFile } from "node:fs/promises";
import { z } from "zod";
import { videoProjectSchema } from "../../shared/video";
import { readResourceCover } from "../cover-assets";
import { AppError } from "../errors";
import { redactPromptText } from "../text-safety";
import type { HandlerMap, HandlerServices } from "./types";

const identity = z.object({ id: z.string().min(1).max(100) });
export function createVideoHandlers(
  services: Pick<HandlerServices, "video" | "repo" | "ports" | "dataPath">,
) {
  return {
    "video.runtime": async () => services.video.runtime(),
    "video.jobs": async (raw) =>
      services.video.jobs(
        z.object({ sourceId: z.string().min(1).max(160) }).parse(raw).sourceId,
      ),
    "video.source": async (raw) => {
      const { copyId } = z
        .object({ copyId: z.string().min(1).max(100) })
        .parse(raw);
      const copy = services.repo.getCopy(copyId);
      const resource = services.repo.getResource(copy.resourceId);
      const slides = [];
      if (resource.coverId) {
        const image = await readResourceCover(
          services.dataPath,
          resource.coverId,
        );
        slides.push({
          src: `data:${image.mime};base64,${image.bytes.toString("base64")}`,
          caption: resource.title,
        });
      }
      return {
        title: resource.title.slice(0, 160),
        subtitle: redactPromptText(resource.summary)
          .replace(/\[(?:链接|凭据)已省略\]/g, "")
          .trim()
          .slice(0, 400),
        entries: copy.files.slice(0, 120).map((file) => ({
          name: file.name.slice(0, 500),
          kind: file.isDirectory ? ("folder" as const) : ("file" as const),
        })),
        slides,
      };
    },
    "video.create": async (raw) => {
      const input = z
        .object({
          sourceId: z.string().min(1).max(160),
          project: videoProjectSchema,
        })
        .parse(raw);
      return services.video.create(input.sourceId, input.project);
    },
    "video.cancel": async (raw) =>
      services.video.cancel(identity.parse(raw).id),
    "video.export": async (raw) => {
      const { id, kind } = identity
        .extend({ kind: z.enum(["video", "cover"]) })
        .parse(raw);
      const output = await services.video.output(id, kind);
      const title = output.title
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .slice(0, 80);
      return services.ports.saveFile(
        `${title || "本地视频"}${kind === "cover" ? "-封面.png" : ".mp4"}`,
        await readFile(output.path),
      );
    },
    "video.importImages": async () => {
      if (!services.ports.readVideoImages)
        throw new AppError(
          "VIDEO_IMPORT_UNAVAILABLE",
          "当前环境暂不支持导入视频图片。",
        );
      const images = await services.ports.readVideoImages();
      return Promise.all(
        (images ?? []).map(async (image) => ({
          src: `data:image/png;base64,${(await services.ports.normalizeCover(image.bytes)).toString("base64")}`,
          caption: image.name.replace(/\.[^.]+$/, "").slice(0, 200),
        })),
      );
    },
    "video.importAudio": async () => {
      if (!services.ports.readVideoAudio)
        throw new AppError(
          "VIDEO_IMPORT_UNAVAILABLE",
          "当前环境暂不支持导入配乐。",
        );
      const audio = await services.ports.readVideoAudio();
      return audio
        ? {
            name: audio.name,
            src: `data:${audio.mime};base64,${audio.bytes.toString("base64")}`,
          }
        : null;
    },
  } satisfies HandlerMap;
}
