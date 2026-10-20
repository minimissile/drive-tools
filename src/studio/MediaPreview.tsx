import type { StudioJob } from "../../shared/studio";

export function MediaPreview({ job }: { job: StudioJob }) {
  const src = `panxu-media://asset/${job.asset}.${job.extension}`;
  return job.kind === "video" ? (
    <video controls preload="metadata" src={src} aria-label="AI营销视频" />
  ) : (
    <img src={src} alt={`营销图片${job.slot + 1}`} />
  );
}
