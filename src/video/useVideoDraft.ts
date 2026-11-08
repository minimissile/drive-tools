import { useMemo, useState } from "react";
import type { VideoProject } from "../../shared/video";
import { useAttachmentDraft } from "../hooks/useAttachmentDraft";
import { windowStorage } from "../storage/window-storage";

type VideoFields = Pick<
  VideoProject,
  "title" | "subtitle" | "template" | "aspectRatio"
> & {
  durationSeconds: string;
};
interface VideoAttachments {
  slides: VideoProject["slides"];
  audio?: VideoProject["audio"];
  audioName?: string;
}

function readFields(key: string, initial: VideoFields) {
  try {
    const raw: unknown = JSON.parse(windowStorage.getItem(key) ?? "null");
    if (!raw || typeof raw !== "object") return { fields: initial, error: "" };
    const stored = raw as Record<string, unknown>;
    return {
      fields: {
        title: typeof stored.title === "string" ? stored.title : initial.title,
        subtitle:
          typeof stored.subtitle === "string"
            ? stored.subtitle
            : initial.subtitle,
        template:
          stored.template === "slideshow"
            ? ("slideshow" as const)
            : ("directory-scroll" as const),
        aspectRatio:
          stored.aspectRatio === "16:9" ? ("16:9" as const) : ("9:16" as const),
        durationSeconds:
          typeof stored.durationSeconds === "string"
            ? stored.durationSeconds
            : "12",
      },
      error: "",
    };
  } catch {
    return {
      fields: initial,
      error:
        "视频设置暂存未能恢复。原记录已保留，可刷新页面重试；重新编辑后将保存新的设置。",
    };
  }
}

function parseAttachments(
  value: string | null | undefined,
): VideoAttachments | null {
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as VideoAttachments).slides)
  )
    throw new Error("视频素材暂存格式无法读取。");
  const assets = parsed as VideoAttachments;
  if (
    assets.slides.some(
      (slide) =>
        !slide ||
        typeof slide.src !== "string" ||
        !/^data:image\/(?:png|jpeg|webp);base64,/.test(slide.src) ||
        typeof slide.caption !== "string",
    )
  )
    throw new Error("视频图片暂存格式无法读取。");
  if (
    assets.audio &&
    (typeof assets.audio.src !== "string" ||
      !/^data:audio\/(?:mpeg|mp3|wav|x-wav|ogg|mp4|aac);base64,/.test(
        assets.audio.src,
      ))
  )
    throw new Error("视频配乐暂存格式无法读取。");
  return assets;
}

/** Small fields and large attachments use the existing per-window recovery stores. */
export function useVideoDraft(
  key: string,
  initial: Pick<VideoProject, "title" | "subtitle" | "slides">,
) {
  const [saved] = useState(() =>
    readFields(key, {
      title: initial.title,
      subtitle: initial.subtitle,
      template: "directory-scroll",
      aspectRatio: "9:16",
      durationSeconds: "12",
    }),
  );
  const [fields, setFields] = useState(saved.fields);
  const [fieldError, setFieldError] = useState(saved.error);
  const attachment = useAttachmentDraft(`${key}:assets`, "视频素材");
  const restored = useMemo(() => {
    try {
      return {
        assets: parseAttachments(attachment.value) ?? {
          slides: initial.slides,
        },
        error: "",
      };
    } catch {
      return {
        assets: { slides: initial.slides } as VideoAttachments,
        error: "视频素材暂存未能恢复。原记录已保留，请刷新页面重试恢复。",
      };
    }
  }, [attachment.value, initial.slides]);
  const attachmentError = attachment.error || restored.error;
  const assets = restored.assets;
  const updateFields = (patch: Partial<VideoFields>) => {
    const next = { ...fields, ...patch };
    setFields(next);
    try {
      windowStorage.setItem(key, JSON.stringify(next));
      setFieldError("");
    } catch {
      setFieldError("视频设置暂存失败，请保留当前页面，完成制作后再离开。");
    }
  };
  const updateAssets = (patch: Partial<VideoAttachments>) => {
    attachment.update(JSON.stringify({ ...assets, ...patch }));
  };
  return {
    fields,
    updateFields,
    assets,
    updateAssets,
    assetsLoading: attachment.loading,
    error: fieldError || attachmentError,
    attachmentError,
  };
}
