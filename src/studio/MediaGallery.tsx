import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { MediaPreview } from "./MediaPreview";
export function MediaGallery({ draftId }: { draftId: string }) {
  const { notify } = useAppActions();
  const { data: jobs } = useIpcQuery(
    "studio.jobs",
    { draftId },
    {
      onError: (error) => notify(error.message, "error"),
    },
  );
  const ready = (jobs ?? [])
    .filter((j) => j.status === "completed" && j.asset)
    .filter(
      (j, i, list) =>
        list.findLastIndex((v) => v.slot === j.slot && v.kind === j.kind) === i,
    )
    .sort((a, b) => a.slot - b.slot);
  if (!ready.length) return null;
  return (
    <div className="creative-gallery">
      {ready.map((j) => (
        <div key={j.id}>
          <p className="muted">
            {j.kind === "video" ? "动态视频" : `第 ${j.slot + 1} 张图片`}
          </p>
          <MediaPreview job={j} />
        </div>
      ))}
    </div>
  );
}
