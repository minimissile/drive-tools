import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import { useIpcQuery } from "../api/useIpcQuery";
import { useState } from "react";
import { FileText, FolderPlus, ImagePlus, Trash2 } from "lucide-react";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";
import { useAppActions } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { z } from "zod";
import type { InsertionMaterial } from "../../shared/insertion";
const parse = (v: unknown) =>
  z
    .object({
      kind: z.enum(["folder", "txt", "image"]),
      name: z.string(),
      text: z.string(),
    })
    .parse(v);
export function InsertionMaterials({
  workspace,
  materials,
  selected,
  onSelect,
  onChanged,
  disabled,
  libraryState,
  title = "1 · 准备插入素材",
  selectionLimit = 10,
  kinds = ["folder", "txt", "image"],
  compactEditor = false,
}: {
  workspace: string;
  materials: InsertionMaterial[];
  selected: string[];
  onSelect: (id: string, checked: boolean) => void;
  onChanged: () => void;
  disabled: boolean;
  libraryState: "loading" | "error" | "ready";
  title?: string;
  selectionLimit?: number;
  kinds?: readonly ("folder" | "txt" | "image")[];
  compactEditor?: boolean;
}) {
  const draft = useLocalDraft(
    "panxu-insertion-material:" +
      workspace +
      (kinds.length < 3 ? ":" + kinds.join("-") : ""),
    { kind: "folder" as "folder" | "txt" | "image", name: "", text: "" },
    parse,
  );
  const { name, text } = draft.value;
  const kind = kinds.includes(draft.value.kind) ? draft.value.kind : kinds[0];
  const { command, notify } = useAppActions();
  const [previewId, setPreviewId] = useState("");
  const [editorOpen, setEditorOpen] = useState(!compactEditor);
  const preview = useIpcQuery(
    "insertion.materialDetail",
    { id: previewId },
    { enabled: !!previewId },
  );
  const [saving, setSaving] = useState(false),
    [image, setImage] = useState<File | null>(null);
  const save = async () => {
    setSaving(true);
    try {
      let result: InsertionMaterial | undefined;
      if (kind === "image") {
        if (!image) {
          notify("请先选择图片。", "warning");
          return;
        }
        if (image.size > 4 * 1024 * 1024) {
          notify("每张图片最多 4 MiB。", "warning");
          return;
        }
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new Error("图片读取失败"));
          reader.readAsDataURL(image);
        });
        result = await command(
          "insertion.addMaterial",
          {
            kind: "image",
            name: name || image.name,
            mime: image.type as "image/png" | "image/jpeg" | "image/webp",
            base64: data,
          },
          "图片已保存到本地素材库",
        );
      } else
        result = await command(
          "insertion.addMaterial",
          kind === "folder" ? { kind, name } : { kind, name, text },
          "素材已保存到本地",
        );
      if (result) {
        onSelect(result.id, true);
        onChanged();
        draft.update({ name: "", text: "" });
        setImage(null);
        if (compactEditor) setEditorOpen(false);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "素材读取失败", "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel
      title={title}
      extra={
        <div className="row">
          <small>最多选择 {selectionLimit} 项</small>
          {compactEditor ? (
            <Button
              quiet
              size="compact"
              onClick={() => setEditorOpen((v) => !v)}
              disabled={disabled || saving}
            >
              {editorOpen ? "收起创建表单" : "创建新素材"}
            </Button>
          ) : null}
        </div>
      }
    >
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
      {editorOpen ? (
        <div className="insertion-material-editor">
          <div className="field-pair">
            <Field label="素材类型">
              <Select
                aria-label="插入素材类型"
                value={kind}
                disabled={disabled || saving}
                onValueChange={(v) => {
                  draft.update({ kind: v as typeof kind, name: "", text: "" });
                  setImage(null);
                }}
                items={[
                  { value: "folder", label: "文件夹 · 名称引流" },
                  { value: "txt", label: "TXT · 文字说明" },
                  { value: "image", label: "图片 · 海报或二维码" },
                ].filter((item) => kinds.includes(item.value as typeof kind))}
              />
            </Field>
            <Field label={kind === "folder" ? "文件夹名称" : "文件名称"}>
              <input
                aria-label="插入素材名称"
                value={name}
                disabled={disabled || saving}
                maxLength={160}
                onChange={(e) => draft.update({ name: e.target.value })}
                placeholder={
                  kind === "folder"
                    ? "更多学习资料 · 见说明"
                    : kind === "txt"
                      ? "资料使用说明.txt"
                      : "保留图片扩展名"
                }
              />
            </Field>
          </div>
          {kind === "txt" ? (
            <Field label="TXT 内容">
              <textarea
                aria-label="插入TXT内容"
                rows={5}
                value={text}
                disabled={disabled || saving}
                onChange={(e) => draft.update({ text: e.target.value })}
                placeholder="填写资料说明、联系方式或引流信息。"
              />
            </Field>
          ) : null}
          {kind === "image" ? (
            <Field label="本地图片 · PNG / JPEG / WebP，最多 4 MiB">
              <input
                aria-label="插入图片"
                type="file"
                disabled={disabled || saving}
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setImage(f);
                  if (f) draft.update({ name: f.name });
                }}
              />
              {image ? (
                <small>
                  {image.name} · 图片加入素材库后保存在本地，刷新前请先保存。
                </small>
              ) : null}
            </Field>
          ) : null}
          <Button
            onClick={() => void save()}
            disabled={
              disabled ||
              saving ||
              (!name.trim() && kind !== "image") ||
              (kind === "txt" && !text.trim()) ||
              (kind === "image" && !image)
            }
          >
            {saving ? "保存中…" : "加入本地素材库"}
          </Button>
        </div>
      ) : null}
      <div className="insertion-material-list">
        {materials.length === 0 ? (
          <small>
            {libraryState === "loading"
              ? "正在读取本地素材库…"
              : libraryState === "error"
                ? "素材库读取失败，请先重试读取。"
                : "还没有素材。先创建文件夹名称、TXT 或添加图片。"}
          </small>
        ) : (
          materials.map((m) => (
            <div className="insertion-material" key={m.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  disabled={
                    disabled ||
                    (!selected.includes(m.id) &&
                      selected.length >= selectionLimit)
                  }
                  onChange={(e) => onSelect(m.id, e.target.checked)}
                />
                {m.kind === "folder" ? (
                  <FolderPlus size={17} />
                ) : m.kind === "txt" ? (
                  <FileText size={17} />
                ) : (
                  <ImagePlus size={17} />
                )}
                <span>
                  {m.name}
                  <small>
                    {m.kind === "folder"
                      ? "空文件夹"
                      : `${(m.size / 1024).toFixed(1)} KiB`}
                  </small>
                </span>
              </label>
              <Button
                quiet
                onClick={() => setPreviewId(m.id)}
                aria-label={`预览素材 ${m.name}`}
              >
                预览
              </Button>
              <Button
                quiet
                disabled={disabled}
                aria-label={`移除素材 ${m.name}`}
                onClick={async () => {
                  if (
                    await command(
                      "insertion.removeMaterial",
                      { id: m.id },
                      "本地素材已移除",
                    )
                  ) {
                    onSelect(m.id, false);
                    onChanged();
                  }
                }}
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))
        )}
      </div>
      {previewId ? (
        <Dialog title="插入素材预览" onClose={() => setPreviewId("")}>
          <QueryError error={preview.error} onRetry={preview.reload} />
          {preview.loading ? (
            <p>正在读取本地素材…</p>
          ) : preview.data ? (
            <>
              <strong>{preview.data.name}</strong>
              {preview.data.kind === "image" ? (
                <img
                  className="insertion-preview-image"
                  src={preview.data.dataUrl}
                  alt={preview.data.name}
                />
              ) : preview.data.kind === "txt" ? (
                <pre className="insertion-preview-text">
                  {preview.data.text}
                </pre>
              ) : (
                <p>将创建以此名称命名的空文件夹。</p>
              )}
            </>
          ) : null}
        </Dialog>
      ) : null}
    </Panel>
  );
}
