import { useEffect, useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions, useAppData } from "../state";
import type { CreativePackage, MediaModel } from "../../shared/studio";
const noModels: MediaModel[] = [];
export function useMediaSettings(value: CreativePackage) {
  const { data } = useAppData();
  const { notify } = useAppActions();
  const [refreshed, setModels] = useState<MediaModel[] | null>(null),
    [imageModel, setImageModel] = useState(data!.settings.aiModels.image),
    [videoModel, setVideoModel] = useState(data!.settings.aiModels.video),
    [reserve, setReserve] = useState(value.format === "video" ? "1" : "0.10"),
    [duration, setDuration] = useState(8),
    [resolution, setResolution] = useState("1080p"),
    [audio, setAudio] = useState(false),
    [reference, setReference] = useState(false);
  const { data: catalog } = useIpcQuery("studio.modelCatalog", undefined, {
    onError: (error) => notify(error.message, "error"),
  });
  const models = refreshed ?? catalog ?? noModels;
  useEffect(() => {
    setImageModel(
      (current) => current || models.find((m) => m.kind === "image")?.id || "",
    );
    setVideoModel(
      (current) => current || models.find((m) => m.kind === "video")?.id || "",
    );
  }, [models]);
  const kind: "image" | "video" = value.format === "video" ? "video" : "image",
    model = models.find(
      (m) =>
        m.id === (kind === "video" ? videoModel : imageModel) &&
        m.kind === kind,
    );
  useEffect(() => {
    if (!model || kind !== "video") return;
    setDuration((current) =>
      !model.durations.length || model.durations.includes(current)
        ? current
        : model.durations[0],
    );
    setResolution((current) =>
      !model.resolutions.length || model.resolutions.includes(current)
        ? current
        : model.resolutions.includes("1080p")
          ? "1080p"
          : model.resolutions[0],
    );
    if (!model.audio) setAudio(false);
    if (!model.reference) setReference(false);
  }, [model, kind]);

  return {
    models,
    setModels,
    imageModel,
    setImageModel,
    videoModel,
    setVideoModel,
    reserve,
    setReserve,
    duration,
    setDuration,
    resolution,
    setResolution,
    audio,
    setAudio,
    reference,
    setReference,
    kind,
    model,
  };
}
export type MediaSettingsModel = ReturnType<typeof useMediaSettings>;
