import { Button, Notice } from "../ui/primitives";
import { Download, Film, ImagePlus, RefreshCw } from "lucide-react";

import { MediaPreview } from "./MediaPreview";
import { useAppActions, useAppActivity } from "../state";
import type { StudioJob } from "../../shared/studio";
const statusNames = {
  submitting: "正在提交",
  pending: "远端排队中",
  in_progress: "AI正在生成",
  completed: "成品已保存",
  failed: "生成失败",
  uncertain: "远端结果待核",
  download_failed: "等待下载，可继续查询",
};

export function StudioAsset({
  jobs,
  kind,
  slot,
  dirty,
  canGenerate,
  allowRepeat,
  submit,
  reload,
}: {
  jobs: StudioJob[];
  kind: StudioJob["kind"];
  slot: number;
  dirty: boolean;
  canGenerate: boolean;
  allowRepeat: boolean;
  submit(slot: number): Promise<StudioJob | undefined>;
  reload(): void;
}) {
  const { command } = useAppActions(),
    { busy } = useAppActivity();
  const latest = (slot: number) =>
    jobs.findLast((job) => job.kind === kind && job.slot === slot);
  const job = latest(slot),
    ready = jobs.findLast(
      (j) =>
        j.kind === kind &&
        j.slot === slot &&
        j.status === "completed" &&
        j.asset,
    ),
    pending =
      job && ["submitting", "pending", "in_progress"].includes(job.status);
  return (
    <div className="creative-asset">
      <div className="row spread">
        <strong>
          {kind === "video" ? "动态视频" : `第 ${slot + 1} 张图片`}
        </strong>
        <span className="tag">
          {job ? statusNames[job.status] : "尚未生成"}
        </span>
      </div>
      {ready ? (
        <div className="creative-asset-preview">
          <MediaPreview job={ready} />
        </div>
      ) : (
        <div className="creative-asset-empty">
          {kind === "video" ? <Film size={28} /> : <ImagePlus size={28} />}
          <span>
            {pending
              ? "素材生成中，任务与进度保存在本地"
              : job?.status === "download_failed"
                ? "远端已生成，继续查询即可重试下载；不会重新生成或再次提交费用。"
                : job?.status === "uncertain"
                  ? "提交结果待核，请先核对服务商记录，避免重复生成。"
                  : job?.status === "failed"
                    ? "本次生成未完成，方案与已有素材保留，请查看失败原因。"
                    : "画面方案确认后，在这里生成实际素材"}
          </span>
        </div>
      )}
      {job?.error ? <Notice warning>{job.error}</Notice> : null}
      <div className="row">
        <Button
          primary
          disabled={
            dirty ||
            busy > 0 ||
            !canGenerate ||
            !!pending ||
            (job?.status === "uncertain" && !allowRepeat)
          }
          onClick={() => void submit(slot)}
        >
          {kind === "video" ? <Film size={14} /> : <ImagePlus size={14} />}{" "}
          {job
            ? kind === "video"
              ? "新建一次视频生成"
              : "重新生成此图"
            : kind === "video"
              ? "生成AI动态视频"
              : "生成此图"}
          {job ? "（再次计费）" : ""}
        </Button>
        {job?.remoteId && job.status !== "completed" ? (
          <Button
            disabled={busy > 0 || dirty}
            onClick={async () => {
              await command("studio.poll", { id: job.id });
              reload();
            }}
          >
            <RefreshCw size={13} />
            查询进度 / 下载
          </Button>
        ) : null}
        {ready ? (
          <Button
            disabled={busy > 0}
            onClick={() =>
              void command("studio.assetExport", {
                name: `${ready.asset}.${ready.extension}`,
              })
            }
          >
            <Download size={14} />
            导出{kind === "video" ? "视频" : "图片"}
          </Button>
        ) : null}
      </div>
      {job ? (
        <small>
          本次任务：{job.model} · {job.aspectRatio}
          {job.kind === "video"
            ? ` · ${job.duration}秒 · ${job.resolution} · ${job.audio ? "含原生音频" : "未请求音频"}`
            : ""}{" "}
          · {job.remoteId ? `远端任务：${job.remoteId} · ` : ""}
          {job.costMicros == null
            ? `实际费用未返回；预留 $${(job.reservedMicros / 1_000_000).toFixed(4)}`
            : `实际费用 $${(job.costMicros / 1_000_000).toFixed(6)}`}
        </small>
      ) : null}
    </div>
  );
}
