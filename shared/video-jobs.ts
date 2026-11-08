import type {
  LocalVideoRuntime,
  VideoProject,
  VideoProjectInput,
} from "./video";

export type VideoProjectSummary = Omit<VideoProject, "slides" | "audio"> & {
  slideCount: number;
  hasAudio: boolean;
};
export interface VideoJob {
  id: string;
  sourceId: string;
  project: VideoProjectSummary;
  status: "queued" | "rendering" | "completed" | "failed" | "cancelled";
  progress: number;
  stage?: "preparing" | "rendering" | "cover" | "completed";
  error?: string;
  createdAt: string;
  updatedAt: string;
  videoUrl?: string;
  coverUrl?: string;
}
export interface VideoSource {
  title: string;
  subtitle: string;
  entries: VideoProject["entries"];
  slides: VideoProject["slides"];
}
type Contract<A, V> = { args: A; value: V };
export interface VideoContract {
  "video.runtime": Contract<undefined, LocalVideoRuntime>;
  "video.source": Contract<{ copyId: string }, VideoSource>;
  "video.jobs": Contract<{ sourceId: string }, VideoJob[]>;
  "video.create": Contract<
    { sourceId: string; project: VideoProjectInput },
    VideoJob
  >;
  "video.cancel": Contract<{ id: string }, VideoJob>;
  "video.export": Contract<
    { id: string; kind: "video" | "cover" },
    string | null
  >;
  "video.importImages": Contract<undefined, VideoProject["slides"]>;
  "video.importAudio": Contract<
    undefined,
    { src: string; name: string } | null
  >;
}
