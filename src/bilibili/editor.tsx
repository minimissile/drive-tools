import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { FileText, Save, Upload } from "lucide-react";
import {
  bilibiliDraftInput,
  bilibiliKinds,
  type BilibiliDraft,
  type BilibiliPreview,
} from "../../shared/bilibili";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import type { Resource } from "../../shared/types";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Empty, Field, LoadingState, Notice } from "../ui/primitives";
import { DataState } from "../ui/DataState";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { formatTime } from "../lib/format";
import LocalVideoPanel from "../video/LocalVideoPanel";

const editorSchema = z.object({
  id: z.string().optional(),
  revision: z.number().int().positive().optional(),
  title: z.string(),
  text: z.string(),
  tagsText: z.string(),
  kind: z.enum(["video", "dynamic", "article"]),
  videoJobId: z.string(),
  receiptUrl: z.string(),
});
export type EditorFields = z.infer<typeof editorSchema>;
const tagsOf = (value: string) =>
  value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
const fieldsOf = (draft: BilibiliDraft): EditorFields => ({
  id: draft.id,
  revision: draft.revision,
  kind: draft.kind,
  title: draft.title,
  text: draft.text,
  tagsText: draft.tags.join("，"),
  videoJobId: draft.videoJobId,
  receiptUrl: draft.receipt?.url ?? "",
});

export function BilibiliEditor({
  scope,
  account,
  accountId,
  copyId,
  resource,
  currentCopyId,
  saved,
  seed,
  initialPreview,
  editorKey,
  onSaved,
  onAssociate,
  showVideoMaker = true,
}: {
  scope: string;
  account?: WebsiteAccountView;
  accountId: string;
  copyId: string;
  resource?: Resource;
  currentCopyId: string;
  saved: BilibiliDraft | null;
  seed: EditorFields | null;
  initialPreview: BilibiliPreview | null;
  editorKey: string;
  onSaved(draft: BilibiliDraft, preview?: BilibiliPreview): void;
  onAssociate(fields: EditorFields): void;
  showVideoMaker?: boolean;
}) {
  const defaults: EditorFields =
    seed ??
    (saved
      ? fieldsOf(saved)
      : {
          title: resource?.title.slice(0, 80) ?? "",
          text: "",
          tagsText: "",
          kind: "video",
          videoJobId: "",
          receiptUrl: "",
        });
  const local = useLocalDraft(
    `bilibili-editor:v1:${scope}:${editorKey}:${accountId}:${copyId}`,
    defaults,
    (raw) => editorSchema.parse(raw),
  );
  const fields = local.value;
  const jobs = useIpcQuery(
    "video.jobs",
    { sourceId: copyId },
    {
      enabled: !!copyId,
      keepPrevious: true,
      refreshInterval: fields.kind === "video" ? 2000 : 0,
    },
  );
  const completed = (jobs.data ?? []).filter(
    (job) => job.status === "completed" && job.sourceId === copyId,
  );
  const videoJobId =
    fields.kind === "video"
      ? fields.videoJobId || completed[0]?.id || ""
      : fields.videoJobId;
  const video = completed.find((job) => job.id === videoJobId);
  const resourceCover = useIpcQuery(
    "cover.get",
    { id: resource?.coverId ?? "" },
    {
      enabled: fields.kind !== "video" && !videoJobId && !!resource?.coverId,
    },
  );
  const imageUrl = videoJobId ? video?.coverUrl : resourceCover.data;
  const [preview, setPreview] = useState(initialPreview);
  const [lastSaved, setLastSaved] = useState(saved);
  const [operation, setOperation] = useState("");
  const [failure, setFailure] = useState("");
  const [feedback, setFeedback] = useState("");
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const input = () =>
    bilibiliDraftInput.parse({
      id: fields.id,
      revision: fields.revision,
      accountId,
      copyId,
      kind: fields.kind,
      title: fields.title,
      text: fields.text,
      tags: tagsOf(fields.tagsText),
      videoJobId,
    });
  const update = (patch: Partial<EditorFields>) => {
    local.update(patch);
    setPreview(null);
    setFeedback("");
  };
  const perform = async (name: string, action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setOperation(name);
    setFailure("");
    setFeedback("");
    try {
      await action();
    } catch (cause) {
      if (mounted.current)
        setFailure(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      locked.current = false;
      if (mounted.current) setOperation("");
    }
  };
  const persist = async () => {
    const result = await ipc("bilibili.save", input());
    if (mounted.current) {
      local.update({ id: result.id, revision: result.revision });
      setLastSaved(result);
    }
    return result;
  };
  const inspect = (prepare: boolean) =>
    void perform(prepare ? "prepare" : "preview", async () => {
      const draft = await persist();
      if (!mounted.current) return;
      const checked = await ipc("bilibili.preview", { id: draft.id });
      if (!mounted.current) return;
      setPreview(checked);
      if (!prepare || checked.issues.some((issue) => issue.level === "error")) {
        onSaved(draft, checked);
        return;
      }
      const result = await ipc("bilibili.prepare", { id: draft.id });
      if (!mounted.current) return;
      setLastSaved(result);
      local.update({ id: result.id, revision: result.revision });
      onSaved(result, { ...checked, draft: result });
    });
  const connected =
    account?.status === "connected" && !account.unverified && !!account.uid;
  const busy = !!operation;
  const matches = (draft: BilibiliDraft) =>
    draft.accountId === accountId &&
    draft.copyId === copyId &&
    draft.kind === fields.kind &&
    draft.title === fields.title.trim() &&
    draft.text === fields.text &&
    draft.tags.join("\n") === tagsOf(fields.tagsText).join("\n") &&
    draft.videoJobId === videoJobId;
  const currentPreview = preview && matches(preview.draft) ? preview : null;
  const preparation =
    currentPreview?.draft.preparation ??
    (lastSaved && matches(lastSaved) ? lastSaved.preparation : undefined);
  const receipt = preview?.draft.receipt ?? lastSaved?.receipt;
  const bodyLabel =
    fields.kind === "video"
      ? "视频简介"
      : fields.kind === "dynamic"
        ? "动态正文"
        : "文章正文";

  return (
    <div className="bilibili-editor">
      <div className="bilibili-section-heading">
        <strong>{fields.id ? "编辑稿件" : "新建稿件"}</strong>
        <small>
          {local.restored ? "已恢复本窗口暂存" : "输入会在本窗口暂存"}
        </small>
      </div>
      {local.error ? <Notice warning>{local.error}</Notice> : null}
      {saved && fields.id === saved.id && fields.revision !== saved.revision ? (
        <Notice warning>
          这份稿件已在其它窗口更新，当前编辑仍保留。可以读取最新保存版本，或另存为新稿。
          <Button
            quiet
            size="compact"
            disabled={busy}
            onClick={() => {
              local.update(fieldsOf(saved));
              setLastSaved(saved);
              setPreview(null);
            }}
          >
            读取最新保存版本
          </Button>
          <Button
            quiet
            size="compact"
            disabled={busy}
            onClick={() => {
              local.update({ id: undefined, revision: undefined });
              setLastSaved(null);
              setPreview(null);
            }}
          >
            另存为新稿
          </Button>
        </Notice>
      ) : null}
      <div className="bilibili-linked-resource">
        <span>
          {resource
            ? `关联资源：${resource.title}`
            : copyId
              ? "关联副本不在当前资源列表中，请在资源库核对对应资源。"
              : "尚未关联资源"}
        </span>
        {currentCopyId && copyId !== currentCopyId ? (
          <Button
            quiet
            size="compact"
            disabled={busy}
            onClick={() => onAssociate({ ...fields, videoJobId: "" })}
          >
            关联当前资源
          </Button>
        ) : null}
      </div>
      <Field label="稿件形式">
        <Select
          aria-label="B站稿件形式"
          value={fields.kind}
          disabled={busy}
          onValueChange={(kind) =>
            update({ kind: kind as EditorFields["kind"] })
          }
          items={Object.entries(bilibiliKinds).map(([value, label]) => ({
            value,
            label,
          }))}
        />
      </Field>
      <Field
        label="稿件标题"
        hint={
          fields.kind === "article"
            ? "建议40字以内，以官网当前要求为准"
            : "最多80字符"
        }
      >
        <input
          aria-label="B站稿件标题"
          value={fields.title}
          disabled={busy}
          maxLength={80}
          onChange={(event) => update({ title: event.target.value })}
        />
      </Field>
      <Field label={bodyLabel}>
        <textarea
          aria-label="B站稿件正文"
          rows={fields.kind === "article" ? 12 : 7}
          value={fields.text}
          disabled={busy}
          maxLength={100000}
          onChange={(event) => update({ text: event.target.value })}
          placeholder={
            fields.kind === "video"
              ? "说明视频展示了什么、资料如何使用，以及需要核对的内容。"
              : "填写完整内容，配图与格式将在官网编辑器核对。"
          }
        />
      </Field>
      <Field label="标签" hint="用逗号分隔，最多10个；官网最终按形式校验">
        <input
          aria-label="B站稿件标签"
          value={fields.tagsText}
          disabled={busy}
          onChange={(event) => update({ tagsText: event.target.value })}
          placeholder="例如：MBTI，职业规划，学习资料"
        />
      </Field>
      {fields.kind === "video" ? (
        <section className="bilibili-video-source" aria-label="B站视频素材">
          <div className="bilibili-section-heading">
            <strong>本地视频与封面</strong>
            <small>使用已制作完成的真实素材</small>
          </div>
          {jobs.error ? (
            <QueryError
              error={jobs.error}
              loading={jobs.loading}
              onRetry={jobs.reload}
              title="暂时无法读取视频素材"
            />
          ) : null}
          {!jobs.data && jobs.loading ? (
            <LoadingState compact label="正在读取本地视频…" />
          ) : null}
          {completed.length ? (
            <>
              <Field label="选择已完成视频">
                <Select
                  aria-label="B站已完成视频"
                  value={videoJobId}
                  disabled={busy}
                  onValueChange={(id) => update({ videoJobId: id })}
                  items={completed.map((job) => ({
                    value: job.id,
                    label: `${job.project.title} · ${job.project.aspectRatio} · ${job.project.durationSeconds}秒 · ${formatTime(job.updatedAt)}`,
                  }))}
                />
              </Field>
              {video ? (
                <div className="bilibili-video-preview">
                  <video
                    key={video.id}
                    aria-label="B站待投稿视频预览"
                    controls
                    preload="metadata"
                    src={video.videoUrl}
                    poster={video.coverUrl}
                  />
                  <Button
                    quiet
                    size="compact"
                    disabled={busy}
                    onClick={() =>
                      void perform("export-video", async () => {
                        await ipc("video.export", {
                          id: video.id,
                          kind: "video",
                        });
                      })
                    }
                  >
                    导出视频
                  </Button>
                  <Button
                    quiet
                    size="compact"
                    disabled={busy}
                    onClick={() =>
                      void perform("export-cover", async () => {
                        await ipc("video.export", {
                          id: video.id,
                          kind: "cover",
                        });
                      })
                    }
                  >
                    导出封面
                  </Button>
                </div>
              ) : (
                <Notice warning>
                  所选视频暂不可用，请重新选择已完成视频。
                </Notice>
              )}
            </>
          ) : jobs.data && !jobs.error ? (
            <Empty compact icon={FileText} title="该资源还没有已完成视频">
              可在下方用真实目录或预览图片制作视频，也可在内容工作室完成后返回。
            </Empty>
          ) : !copyId ? (
            <Notice>先关联资源，再选择或制作视频。</Notice>
          ) : null}
          {showVideoMaker && copyId && copyId === currentCopyId ? (
            <LocalVideoPanel copyId={copyId} />
          ) : null}
        </section>
      ) : (
        <section className="bilibili-image-source" aria-label="B站稿件配图">
          <Field label="配图来源">
            <Select
              aria-label="B站配图来源"
              value={videoJobId}
              disabled={busy}
              onValueChange={(id) => update({ videoJobId: id })}
              items={[
                {
                  value: "",
                  label: resource?.coverId
                    ? "资源封面"
                    : "资源封面（尚未设置）",
                },
                ...completed
                  .filter((job) => !!job.coverUrl)
                  .map((job) => ({
                    value: job.id,
                    label: `视频封面 · ${job.project.title} · ${formatTime(job.updatedAt)}`,
                  })),
              ]}
            />
          </Field>
          {jobs.error ? (
            <QueryError
              error={jobs.error}
              loading={jobs.loading}
              onRetry={jobs.reload}
              title="暂时无法读取视频封面"
            />
          ) : null}
          {!jobs.data && jobs.loading ? (
            <LoadingState compact label="正在读取本地配图素材…" />
          ) : null}
          {resourceCover.error ? (
            <QueryError
              error={resourceCover.error}
              loading={resourceCover.loading}
              onRetry={resourceCover.reload}
              title="暂时无法读取资源封面"
            />
          ) : null}
          {imageUrl ? (
            <img src={imageUrl} alt="B站稿件配图预览" />
          ) : videoJobId ? (
            !jobs.loading && !jobs.error ? (
              <Notice warning>
                所选视频封面暂不可用，请选择当前资源的已完成视频封面。
              </Notice>
            ) : null
          ) : !resource?.coverId ? (
            <p className="bilibili-action-note">
              资源尚未设置封面，可选用本地视频封面；配图会在官网填写时上传。
            </p>
          ) : resourceCover.loading ? (
            <LoadingState compact label="正在读取资源封面…" />
          ) : null}
        </section>
      )}
      <div className="bilibili-editor-actions">
        <Button
          primary
          disabled={busy || !fields.title.trim()}
          onClick={() =>
            void perform("save", async () => {
              const result = await persist();
              if (mounted.current) {
                onSaved(result);
                setFeedback("本地稿件已保存。");
              }
            })
          }
        >
          <Save size={15} />
          {operation === "save" ? "正在保存…" : "保存草稿"}
        </Button>
        <Button
          disabled={busy || !fields.title.trim()}
          onClick={() => inspect(false)}
        >
          <FileText size={15} />
          预览与检查
        </Button>
        <Button
          disabled={busy || !connected || !fields.title.trim()}
          onClick={() => inspect(true)}
        >
          <Upload size={15} />
          {operation === "prepare" ? "正在填写官网…" : "填写官网投稿"}
        </Button>
        <Button
          quiet
          disabled={busy || !fields.title.trim()}
          onClick={() =>
            void perform("export", async () => {
              const draft = await persist();
              if (!mounted.current) return;
              await ipc("bilibili.export", { id: draft.id });
              if (mounted.current) onSaved(draft);
            })
          }
        >
          导出文字稿
        </Button>
      </div>
      <p className="bilibili-action-note">
        填写官网投稿会上传所选素材并填写编辑器；最终提交在官网完成。
        {!connected ? "请先核验B站账号。" : ""}
      </p>
      {busy ? (
        <LoadingState
          compact
          label={
            operation === "prepare"
              ? "正在向官网交付素材和稿件，请等待完成…"
              : "正在处理稿件…"
          }
        />
      ) : null}
      {failure ? (
        <DataState kind="error" compact title="稿件操作未完成">
          {failure}
        </DataState>
      ) : null}
      {feedback ? (
        <p className="bilibili-feedback" role="status">
          {feedback}
        </p>
      ) : null}
      {currentPreview ? (
        <section className="bilibili-preview" aria-label="B站稿件预览与检查">
          <div className="bilibili-section-heading">
            <strong>稿件预览与检查</strong>
            <span>{currentPreview.accountLabel}</span>
          </div>
          {currentPreview.issues.length ? (
            <ul className="bilibili-issues">
              {currentPreview.issues.map((issue, index) => (
                <li key={index} data-level={issue.level}>
                  {issue.level === "error" ? "需处理：" : "请核对："}
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="bilibili-feedback">
              本地内容检查已通过，官网仍会检查账号权限、素材与提交要求。
            </p>
          )}
          <h3>{currentPreview.draft.title}</h3>
          <p className="bilibili-preview-text">
            {currentPreview.draft.text || "未填写正文或简介"}
          </p>
          {currentPreview.imageUrl ? (
            <img src={currentPreview.imageUrl} alt="关联资源的实际封面" />
          ) : null}
        </section>
      ) : null}
      {preparation ? (
        <section className="bilibili-preparation" aria-label="官网准备结果">
          <strong>
            {preparation.status === "filled"
              ? "官网填写完成，等待最终提交"
              : "官网已部分填写，请继续核对"}
          </strong>
          <p>{preparation.message}</p>
          <p>
            已填入：{preparation.filledFields.join("、") || "尚未确认字段"}
            ；视频{preparation.mediaSelected ? "已选入" : "未选入"}，图片
            {preparation.imageSelected ? "已选入" : "未选入"}。
          </p>
          <p>请在已打开的关联账号窗口继续核对，避免切换到其它登录身份。</p>
        </section>
      ) : null}
      <section className="bilibili-receipt" aria-label="发布结果回填">
        <div className="bilibili-section-heading">
          <strong>官网内容链接</strong>
          <small>仅记录待核实结果</small>
        </div>
        <div>
          <input
            aria-label="B站官网内容链接"
            value={fields.receiptUrl}
            disabled={busy}
            onChange={(event) => update({ receiptUrl: event.target.value })}
            placeholder="发布后填写官网视频、动态或专栏链接"
          />
          <Button
            disabled={busy || !fields.receiptUrl.trim() || !fields.title.trim()}
            onClick={() =>
              void perform("receipt", async () => {
                const draft = await persist();
                if (!mounted.current) return;
                const result = await ipc("bilibili.recordReceipt", {
                  id: draft.id,
                  url: fields.receiptUrl,
                });
                if (mounted.current) {
                  setLastSaved(result);
                  local.update({ id: result.id, revision: result.revision });
                  onSaved(result);
                }
              })
            }
          >
            记录待核实链接
          </Button>
        </div>
        {receipt ? (
          <p role="status">
            已记录：{receipt.url} · 待核实，尚未确认发布状态或归属。
          </p>
        ) : null}
      </section>
    </div>
  );
}
