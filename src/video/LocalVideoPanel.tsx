import { useEffect, useRef, useState } from "react";
import {
  File,
  Film,
  Folder,
  ImagePlus,
  Music2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  localVideoTemplates,
  videoProjectSchema,
  type VideoProject,
} from "../../shared/video";
import type { VideoJob } from "../../shared/video-jobs";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { HotMusicPicker } from "../music/HotMusicPicker";
import { useAppActions, useAppData, useAppSelection } from "../state";
import type { ResourceCopy } from "../../shared/types";
import { Button, Empty, Field, LoadingState, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { windowStorage } from "../storage/window-storage";
import { useVideoDraft } from "./useVideoDraft";
import { VideoJobPreview } from "./VideoJobPreview";
import { videoDirectoryTargets } from "./resource-video-source";
import { useResourceVideoDirectory } from "./useResourceVideoDirectory";
import "./video.css";

type VideoSource = Pick<
  VideoProject,
  "title" | "subtitle" | "entries" | "slides"
>;
const pendingJob = (job: VideoJob) =>
  job.status === "queued" || job.status === "rendering";
const noJobs: VideoJob[] = [];
function readPreference(key: string) {
  try {
    return windowStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writePreference(key: string, value: string) {
  try {
    windowStorage.setItem(key, value);
  } catch {
    /* Form recovery is reported separately. */
  }
}

/** Resource-specific adapter; the editor below can be used with any module's source. */
export default function LocalVideoPanel({ copyId }: { copyId: string }) {
  const { data } = useAppData();
  const { notify } = useAppActions();
  const { copy } = useAppSelection();
  const openKey = `panxu-local-video-open:${data?.dataPath ?? ""}:${copyId}`;
  const [open, setOpen] = useState(() => readPreference(openKey) === "true");
  const source = useIpcQuery("video.source", { copyId }, { enabled: open });
  return (
    <details
      className="local-video-panel panel"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        writePreference(openKey, String(event.currentTarget.open));
      }}
    >
      <summary>
        <span>
          <Film size={16} />
          本地视频制作
        </span>
        <small>目录展示与资料预览 · 无需 AI 模型</small>
      </summary>
      {open ? (
        <div className="local-video-panel-body">
          {source.error ? (
            <QueryError
              error={source.error}
              loading={source.loading}
              onRetry={source.reload}
              title="暂时无法读取视频素材"
            />
          ) : null}
          {!source.data && source.loading ? (
            <LoadingState compact label="正在读取资源目录与预览素材…" />
          ) : null}
          {source.data ? (
            <ResourceVideoSource
              key={`${data?.dataPath}:${copyId}`}
              sourceId={copyId}
              draftScope={data?.dataPath ?? ""}
              copy={copy?.id === copyId ? copy : undefined}
              source={source.data}
              onFeedback={notify}
            />
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function ResourceVideoSource({
  sourceId,
  draftScope,
  copy,
  source,
  onFeedback,
}: {
  sourceId: string;
  draftScope: string;
  copy: ResourceCopy | undefined;
  source: VideoSource;
  onFeedback(
    message: string,
    tone: "success" | "error" | "warning" | "info",
  ): void;
}) {
  const targets = copy ? videoDirectoryTargets(copy) : [];
  const directory = useResourceVideoDirectory(draftScope, sourceId, targets);
  const busy = directory.restoring || directory.reading;
  const actualSource = directory.snapshot
    ? { ...source, entries: directory.snapshot.entries }
    : source;
  return (
    <>
      {directory.target ? (
        <div className="local-video-source-tools" aria-label="视频目录来源">
          <div className="local-video-source-heading">
            <strong>文件夹内容</strong>
            <small>
              读取当前文件夹及直接子文件夹内的真实条目，最多展示120项。
            </small>
          </div>
          <div className="local-video-source-actions">
            {targets.length > 1 ? (
              <Select
                aria-label="视频资料文件夹"
                value={directory.target.id}
                onValueChange={directory.choose}
                disabled={busy}
                items={targets.map((target) => ({
                  value: target.id,
                  label: target.name,
                }))}
              />
            ) : (
              <span className="local-video-source-folder">
                <Folder size={14} />
                {directory.target.name}
              </span>
            )}
            <Button
              quiet
              size="compact"
              disabled={busy}
              onClick={() => void directory.read()}
            >
              <RefreshCw size={13} />
              {directory.reading ? "正在读取文件夹…" : "读取文件夹内容"}
            </Button>
            {directory.snapshot ? (
              <Button
                quiet
                size="compact"
                disabled={busy}
                onClick={() => void directory.reset()}
              >
                使用原资源清单
              </Button>
            ) : null}
          </div>
          {directory.restoring ? (
            <LoadingState compact label="正在恢复已读取的目录…" />
          ) : null}
          {directory.snapshot ? (
            <p className="local-video-source-status" role="status">
              已读取{directory.snapshot.total}项，视频展示
              {directory.snapshot.entries.length}项 ·{" "}
              {new Date(directory.snapshot.readAt).toLocaleString("zh-CN")}
              {directory.snapshot.truncated
                ? "；已达读取范围上限，部分内容未展示。"
                : ""}
            </p>
          ) : null}
          {directory.error ? (
            <QueryError
              error={directory.error}
              loading={directory.reading}
              onRetry={() => void directory.read()}
              title="文件夹内容读取未完成"
            >
              {directory.snapshot
                ? "仍保留上次读取的目录。"
                : "当前仍使用资源已记录的清单。"}
            </QueryError>
          ) : null}
          {directory.warning ? (
            <Notice warning>{directory.warning}</Notice>
          ) : null}
        </div>
      ) : null}
      <LocalVideoMaker
        sourceId={sourceId}
        draftScope={draftScope}
        source={actualSource}
        sourceLoading={busy}
        onFeedback={onFeedback}
      />
    </>
  );
}

/** Generic video editor: callers supply content; music uses the shared library. */
export function LocalVideoMaker({
  sourceId,
  draftScope,
  source,
  sourceLoading = false,
  onFeedback,
}: {
  sourceId: string;
  draftScope: string;
  source: VideoSource;
  sourceLoading?: boolean;
  onFeedback(
    message: string,
    tone: "success" | "error" | "warning" | "info",
  ): void;
}) {
  const runtime = useIpcQuery("video.runtime", undefined, {
    keepPrevious: true,
  });
  const jobs = useIpcQuery(
    "video.jobs",
    { sourceId },
    { keepPrevious: true, refreshInterval: 1500 },
  );
  const draftKey = `panxu-local-video-v1:${draftScope}:${sourceId}`;
  const draft = useVideoDraft(draftKey, source);
  const [operation, setOperation] = useState("");
  const [musicLoading, setMusicLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [selectedJob, setSelectedJob] = useState(() =>
    readPreference(`${draftKey}:selection`),
  );
  const selectJob = (id: string) => {
    setSelectedJob(id);
    writePreference(`${draftKey}:selection`, id);
  };
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const allJobs = jobs.data ?? noJobs;
  const active = allJobs.find(pendingJob);
  const job =
    active ?? allJobs.find((item) => item.id === selectedJob) ?? allJobs[0];
  const pending = !!job && pendingJob(job);
  const busy = !!operation || musicLoading;
  const acceptJob = (updated: VideoJob) => {
    jobs.setData([
      updated,
      ...allJobs.filter((item) => item.id !== updated.id),
    ]);
    selectJob(updated.id);
  };
  const perform = async (name: string, action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOperation(name);
    setActionError("");
    try {
      await action();
    } catch (cause) {
      if (mounted.current)
        setActionError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setOperation("");
    }
  };
  const create = () =>
    void perform("create", async () => {
      const durationSeconds = Number(draft.fields.durationSeconds);
      if (
        !Number.isInteger(durationSeconds) ||
        durationSeconds < 6 ||
        durationSeconds > 60
      )
        throw new Error("视频时长请输入 6～60 之间的整数。");
      const input = videoProjectSchema.safeParse({
        ...draft.fields,
        durationSeconds,
        entries: source.entries,
        ...draft.assets,
      });
      if (!input.success)
        throw new Error(
          input.error.issues[0]?.message ?? "请检查视频设置与素材。",
        );
      const result = await ipc("video.create", {
        sourceId,
        project: input.data,
      });
      if (mounted.current) acceptJob(result);
    });
  const importImages = () =>
    void perform("images", async () => {
      const images = await ipc("video.importImages");
      if (!mounted.current || !images.length) return;
      if (draft.assets.slides.length + images.length > 12)
        throw new Error("每个视频最多使用 12 张图片，请先移除不需要的图片。");
      draft.updateAssets({ slides: [...draft.assets.slides, ...images] });
    });
  const importAudio = () =>
    void perform("audio", async () => {
      const audio = await ipc("video.importAudio");
      if (mounted.current && audio)
        draft.updateAssets({
          audio: { src: audio.src, volume: 0.25 },
          audioName: audio.name,
        });
    });
  const exportAsset = (kind: "video" | "cover") => {
    if (!job) return;
    void perform(`export-${kind}`, async () => {
      const path = await ipc("video.export", { id: job.id, kind });
      if (path && mounted.current)
        onFeedback(
          kind === "video" ? "视频已导出" : "视频封面已导出",
          "success",
        );
    });
  };
  const noMaterial =
    draft.fields.template === "directory-scroll"
      ? !source.entries.length
      : !draft.assets.slides.length;
  const canCreate =
    !musicLoading &&
    !sourceLoading &&
    !pending &&
    !(jobs.loading && !jobs.data) &&
    !jobs.error &&
    !!runtime.data?.available &&
    !draft.assetsLoading &&
    !draft.attachmentError &&
    !!draft.fields.title.trim() &&
    !noMaterial;
  return (
    <div className="local-video-maker">
      <p className="local-video-intro">
        把真实目录或预览图片制作成视频，成片与封面保存在本机。
      </p>
      {runtime.error ? (
        <QueryError
          error={runtime.error}
          loading={runtime.loading}
          onRetry={runtime.reload}
          title="暂时无法检查视频制作环境"
        />
      ) : null}
      {!runtime.data && runtime.loading ? (
        <LoadingState compact label="正在检查本地视频制作环境…" />
      ) : null}
      {runtime.data && !runtime.data.available ? (
        <Notice warning>
          {runtime.data.message}
          <Button
            quiet
            size="compact"
            disabled={runtime.loading}
            onClick={runtime.reload}
          >
            <RefreshCw size={13} />
            重新检查
          </Button>
        </Notice>
      ) : null}
      {draft.error ? (
        <Notice warning>
          {draft.error}
          <Button quiet size="compact" onClick={() => window.location.reload()}>
            重试恢复暂存
          </Button>
        </Notice>
      ) : null}
      <div className="local-video-layout">
        <div className="local-video-settings">
          <Field label="视频模板">
            <Select
              aria-label="本地视频模板"
              value={draft.fields.template}
              onValueChange={(value) =>
                draft.updateFields({
                  template: value as VideoProject["template"],
                })
              }
              items={localVideoTemplates.map((template) => ({
                value: template.id,
                label: template.name,
              }))}
            />
          </Field>
          <Field label="视频标题">
            <input
              aria-label="本地视频标题"
              value={draft.fields.title}
              maxLength={160}
              onChange={(event) =>
                draft.updateFields({ title: event.target.value })
              }
            />
          </Field>
          <Field label="简短说明" hint="选填">
            <textarea
              aria-label="本地视频简短说明"
              rows={2}
              maxLength={400}
              value={draft.fields.subtitle}
              onChange={(event) =>
                draft.updateFields({ subtitle: event.target.value })
              }
            />
          </Field>
          <div className="local-video-settings-row">
            <Field label="画面比例">
              <Select
                aria-label="本地视频画面比例"
                value={draft.fields.aspectRatio}
                onValueChange={(value) =>
                  draft.updateFields({
                    aspectRatio: value as VideoProject["aspectRatio"],
                  })
                }
                items={[
                  { value: "9:16", label: "竖屏 9:16" },
                  { value: "16:9", label: "横屏 16:9" },
                ]}
              />
            </Field>
            <Field label="时长（秒）">
              <input
                aria-label="本地视频时长"
                type="number"
                min={6}
                max={60}
                step={1}
                value={draft.fields.durationSeconds}
                onChange={(event) =>
                  draft.updateFields({ durationSeconds: event.target.value })
                }
              />
            </Field>
          </div>
          <div className="local-video-audio">
            <span>
              <Music2 size={15} />
              {draft.assets.audio
                ? draft.assets.audioName || "已添加本地配乐"
                : "无配乐"}
            </span>
            <Button
              quiet
              size="compact"
              disabled={busy || draft.assetsLoading || !!draft.attachmentError}
              onClick={importAudio}
            >
              {draft.assets.audio ? "更换配乐" : "添加配乐"}
            </Button>
            {draft.assets.audio ? (
              <Button
                quiet
                size="compact"
                aria-label="移除本地视频配乐"
                onClick={() =>
                  draft.updateAssets({ audio: undefined, audioName: undefined })
                }
              >
                <X size={13} />
              </Button>
            ) : null}
          </div>
          <HotMusicPicker
            key={draftKey}
            disabled={
              !!operation ||
              pending ||
              draft.assetsLoading ||
              !!draft.attachmentError
            }
            onSelect={(audio) =>
              draft.updateAssets({
                audio: { src: audio.src, volume: 0.25 },
                audioName: audio.name,
              })
            }
            onLoadingChange={setMusicLoading}
          />
        </div>
        <div className="local-video-materials">
          {draft.fields.template === "directory-scroll" ? (
            <>
              <div className="local-video-materials-heading">
                <strong>实际目录</strong>
                <small>{source.entries.length} 项</small>
              </div>
              {source.entries.length ? (
                <ul className="local-video-entries">
                  {source.entries.map((entry, index) => (
                    <li key={`${index}:${entry.name}`}>
                      {entry.kind === "folder" ? (
                        <Folder size={15} />
                      ) : (
                        <File size={15} />
                      )}
                      <span>{entry.name}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty compact icon={Folder} title="当前没有已记录的目录">
                  请先在资源中读取实际文件目录，或切换“资料预览”添加本地图片。
                </Empty>
              )}
            </>
          ) : (
            <>
              <div className="local-video-materials-heading">
                <strong>预览图片</strong>
                <Button
                  quiet
                  size="compact"
                  disabled={
                    busy ||
                    draft.assetsLoading ||
                    !!draft.attachmentError ||
                    draft.assets.slides.length >= 12
                  }
                  onClick={importImages}
                >
                  <ImagePlus size={14} />
                  添加图片
                </Button>
              </div>
              {draft.assetsLoading ? (
                <LoadingState compact label="正在恢复预览图片…" />
              ) : draft.assets.slides.length ? (
                <div className="local-video-slides">
                  {draft.assets.slides.map((slide, index) => (
                    <div
                      className="local-video-slide"
                      key={`${index}:${slide.src.slice(-32)}`}
                    >
                      <img src={slide.src} alt={`视频预览素材 ${index + 1}`} />
                      <div>
                        <Field label={`第 ${index + 1} 张说明`}>
                          <input
                            aria-label={`本地视频第${index + 1}张图片说明`}
                            value={slide.caption}
                            maxLength={200}
                            onChange={(event) =>
                              draft.updateAssets({
                                slides: draft.assets.slides.map((item, at) =>
                                  at === index
                                    ? { ...item, caption: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        </Field>
                        <Button
                          quiet
                          size="compact"
                          aria-label={`移除本地视频第${index + 1}张图片`}
                          onClick={() =>
                            draft.updateAssets({
                              slides: draft.assets.slides.filter(
                                (_, at) => at !== index,
                              ),
                            })
                          }
                        >
                          移除图片
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty compact icon={ImagePlus} title="添加要展示的资料图片">
                  可选择本地 PNG、JPEG 或 WebP，最多 12 张。
                </Empty>
              )}
            </>
          )}
        </div>
      </div>
      <div className="local-video-create">
        <Button primary disabled={busy || !canCreate} onClick={create}>
          <Film size={15} />
          {operation === "create" ? "正在准备…" : "制作视频"}
        </Button>
        <small>1080p · 设置与素材会按当前窗口和资源暂存</small>
      </div>
      {actionError && !job ? <Notice danger>{actionError}</Notice> : null}
      {jobs.error ? (
        <QueryError
          error={jobs.error}
          loading={jobs.loading}
          onRetry={jobs.reload}
          title="暂时无法读取视频任务"
        />
      ) : null}
      {!jobs.data && jobs.loading ? (
        <LoadingState compact label="正在读取已有视频任务…" />
      ) : null}
      {jobs.data ? (
        <>
          {allJobs.length > 1 ? (
            <Field label="查看制作记录">
              <Select
                aria-label="本地视频制作记录"
                value={job?.id ?? ""}
                onValueChange={selectJob}
                disabled={!!active}
                items={allJobs.map((item) => ({
                  value: item.id,
                  label: `${item.project.title} · ${new Date(item.createdAt).toLocaleString("zh-CN")}`,
                }))}
              />
            </Field>
          ) : null}
          <VideoJobPreview
            job={job}
            pending={pending}
            busy={busy}
            canCreate={canCreate}
            error={actionError}
            cancel={() =>
              void perform("cancel", async () => {
                if (!job) return;
                const result = await ipc("video.cancel", { id: job.id });
                if (mounted.current) acceptJob(result);
              })
            }
            retry={create}
            exportAsset={exportAsset}
          />
        </>
      ) : null}
    </div>
  );
}
