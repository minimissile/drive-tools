import { Download, Film, RefreshCw, Square } from "lucide-react";
import type { VideoJob } from "../../shared/video-jobs";
import { Button, Empty, Notice, Status } from "../ui/primitives";

const statusLabels: Record<VideoJob["status"], string> = {
  queued: "等待制作",
  rendering: "正在制作",
  completed: "制作完成",
  failed: "制作失败",
  cancelled: "已取消",
};

export function VideoJobPreview({
  job,
  pending,
  busy,
  canCreate,
  error,
  cancel,
  retry,
  exportAsset,
}: {
  job: VideoJob | undefined;
  pending: boolean;
  busy: boolean;
  canCreate: boolean;
  error: string;
  cancel(): void;
  retry(): void;
  exportAsset(kind: "video" | "cover"): void;
}) {
  if (!job)
    return (
      <Empty compact icon={Film} title="还没有制作视频">
        设置好标题与素材后，点击“制作视频”。成片会保存在当前工作空间。
      </Empty>
    );
  return (
    <section className="local-video-result" aria-label="本地视频制作结果">
      <div className="local-video-result-heading">
        <div>
          <strong>{job.project.title}</strong>
          <small>
            {job.project.aspectRatio} · {job.project.durationSeconds} 秒
          </small>
        </div>
        <Status
          kind={
            job.status === "completed"
              ? "good"
              : job.status === "failed"
                ? "danger"
                : "normal"
          }
        >
          {statusLabels[job.status]}
        </Status>
      </div>
      {pending ? (
        <div className="local-video-progress">
          <label htmlFor={`video-progress-${job.id}`}>
            正在本机制作，切换页面后任务会继续
          </label>
          <progress
            id={`video-progress-${job.id}`}
            max={1}
            value={job.progress}
          />
          <div>
            <span>{Math.round(job.progress * 100)}%</span>
            <Button size="compact" quiet disabled={busy} onClick={cancel}>
              <Square size={13} />
              取消制作
            </Button>
          </div>
        </div>
      ) : job.status === "completed" && job.videoUrl ? (
        <div className="local-video-player">
          <video
            controls
            preload="metadata"
            src={job.videoUrl}
            poster={job.coverUrl}
            aria-label="本地制作视频预览"
          />
          {job.coverUrl ? (
            <figure>
              <img src={job.coverUrl} alt={`${job.project.title}的视频封面`} />
              <figcaption>视频封面</figcaption>
            </figure>
          ) : null}
        </div>
      ) : (
        <p className="local-video-result-note">
          {job.status === "cancelled"
            ? "本次制作已取消，设置与素材仍保留。"
            : "本次没有生成完整成片，设置与素材仍保留。"}
        </p>
      )}
      {error || job.error ? <Notice danger>{error || job.error}</Notice> : null}
      {!pending ? (
        <div className="local-video-result-actions">
          {job.status === "completed" ? (
            <>
              <Button disabled={busy} onClick={() => exportAsset("video")}>
                <Download size={14} />
                导出视频
              </Button>
              <Button disabled={busy} onClick={() => exportAsset("cover")}>
                <Download size={14} />
                导出封面
              </Button>
            </>
          ) : (
            <Button disabled={busy || !canCreate} onClick={retry}>
              <RefreshCw size={14} />
              使用当前设置重试
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
