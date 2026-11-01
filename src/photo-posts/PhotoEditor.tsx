import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Download, Save } from "lucide-react";
import {
  photoFormSchema,
  photoWorkingFormSchema,
  photoPlatforms,
  photoPlatformNames,
  photoArtworkVersion,
  type PhotoForm,
  type PhotoPost,
} from "../../shared/photo-posts";
import { providers } from "../../shared/platforms";
import type { Resource, ResourceCopy } from "../../shared/types";
import { useAppActions, useAppData } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { windowStorage } from "../storage/window-storage";
import { Panel, Field, Button, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import { PhotoPreview } from "./PhotoPreview";
import { PhotoPublishing } from "./PhotoPublishing";

function seed(resource: Resource, copy: ResourceCopy): PhotoForm {
  return {
    artworkVersion: photoArtworkVersion,
    title: resource.title.slice(0, 60),
    emphasis: "",
    coverStyle: resource.coverId ? "poster" : "type",
    subtitle: "",
    details:
      copy.files
        .map((file) => file.name)
        .join("\n")
        .slice(0, 1200) || resource.summary.slice(0, 1200),
    audience: "",
    passphrase: "",
    retrieval: "search",
    theme: "blue",
    platforms: [...photoPlatforms],
  };
}
export function PhotoEditor({
  resource,
  copy,
  post,
  toolbar,
  busy,
  setBusy,
  onSaved,
}: {
  resource: Resource;
  copy: ResourceCopy;
  post: PhotoPost | null;
  toolbar: ReactNode;
  busy: boolean;
  setBusy(value: boolean): void;
  onSaved(post: PhotoPost): Promise<void>;
}) {
  const { data } = useAppData(),
    { notify } = useAppActions();
  const draftKey = `panxu-photo-form:${data!.dataPath}:${post?.id ?? `new:${copy.id}`}`;
  const [form, setForm] = useState<PhotoForm>(() => {
    try {
      const saved = JSON.parse(windowStorage.getItem(draftKey) || "null");
      const checked = photoWorkingFormSchema.safeParse(saved);
      return {
        ...(checked.success
          ? checked.data
          : (post?.form ?? seed(resource, copy))),
        artworkVersion: photoArtworkVersion,
      };
    } catch {
      return {
        ...(post?.form ?? seed(resource, copy)),
        artworkVersion: photoArtworkVersion,
      };
    }
  });
  const [saved, setSaved] = useState(post),
    [error, setError] = useState(""),
    [storageError, setStorageError] = useState("");
  const [rendered, setRendered] = useState<{ images: string[]; error: string }>(
    { images: [], error: "" },
  );
  const [folder, setFolder] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      windowStorage.setItem(draftKey, JSON.stringify(form));
      setStorageError("");
    } catch {
      setStorageError("编辑暂存失败，请保留当前页面并保存图文任务。");
    }
  }, [form, draftKey]);
  const cover = useIpcQuery(
    "cover.get",
    { id: resource.coverId ?? "" },
    { enabled: !!resource.coverId },
  );
  const dirty = !saved || JSON.stringify(saved.form) !== JSON.stringify(form);
  const render = useCallback(
    (images: string[], error: string) => setRendered({ images, error }),
    [],
  );
  const change = <K extends keyof PhotoForm>(key: K, value: PhotoForm[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setFolder("");
  };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      const checked = photoFormSchema.safeParse(form);
      if (!checked.success) throw Error(checked.error.issues[0].message);
      const next = await ipc("photoPosts.save", {
        id: saved?.id,
        expectedVersion: saved?.version,
        copyId: copy.id,
        form: checked.data,
      });
      if (!mounted.current) return;
      setSaved(next);
      setForm(next.form);
      try {
        windowStorage.removeItem(draftKey);
      } catch {
        notify("任务已保存，界面暂存清理失败。", "warning");
      }
      notify("图文任务已保存。", "success");
      await onSaved(next).catch(() =>
        notify("任务已保存，列表刷新失败，请刷新后查看。", "warning"),
      );
    });
  return (
    <>
      <div className="photo-post-editor-actions">
        {toolbar}
        <Button primary disabled={busy} onClick={() => void save()}>
          <Save size={14} />
          保存图文任务
        </Button>
        <Button
          disabled={
            busy ||
            dirty ||
            !form.passphrase.trim() ||
            !form.details.trim() ||
            rendered.images.length !== 3 ||
            !!rendered.error
          }
          onClick={() =>
            void run(async () => {
              const result = await ipc("photoPosts.export", {
                id: saved!.id,
                version: saved!.version,
                images: rendered.images,
              });
              if (!result || !mounted.current) return;
              setSaved(result.post);
              setFolder(result.folder);
              notify("三张图片与发布文案已导出。", "success");
            })
          }
        >
          <Download size={14} />
          核验并导出三张图
        </Button>
      </div>
      <div className="photo-post-layout">
        <Panel
          title="内容与获取方式"
          extra={
            <small>
              {saved ? `v${saved.version}` : "新任务"} ·{" "}
              {dirty ? "编辑已暂存" : "已保存"}
            </small>
          }
        >
          <fieldset
            className="photo-post-fields"
            disabled={busy}
            aria-label="图文编辑内容"
          >
            <Field
              label="封面标题"
              hint="建议 8–18 字，只说一个重点；换行可调整大字构图。"
            >
              <textarea
                aria-label="封面标题"
                rows={2}
                value={form.title}
                maxLength={60}
                onChange={(e) => change("title", e.target.value)}
              />
            </Field>
            <div className="photo-post-field-row">
              <Field label="封面重点词" hint="填写标题中要突出的一段原文。">
                <input
                  aria-label="封面重点词"
                  value={form.emphasis ?? ""}
                  maxLength={16}
                  placeholder="如：后期调色"
                  onChange={(e) => change("emphasis", e.target.value)}
                />
              </Field>
              <Field label="封面构图">
                <Select
                  aria-label="封面构图"
                  value={
                    form.coverStyle ?? (resource.coverId ? "poster" : "type")
                  }
                  items={[
                    { value: "type", label: "大字冲击" },
                    ...(resource.coverId
                      ? [{ value: "poster", label: "原封面海报" }]
                      : []),
                  ]}
                  onValueChange={(value) =>
                    change("coverStyle", value as PhotoForm["coverStyle"])
                  }
                />
              </Field>
            </div>
            <Field
              label="资源亮点"
              hint="显示在封面醒目色块里，优先填写一条已确认的用途或特点。"
            >
              <textarea
                aria-label="资源亮点"
                rows={2}
                maxLength={120}
                value={form.subtitle}
                onChange={(e) => change("subtitle", e.target.value)}
                placeholder="填写已确认的用途或特点"
              />
            </Field>
            <Field label="资源详情">
              <textarea
                aria-label="资源详情"
                rows={5}
                maxLength={1200}
                value={form.details}
                onChange={(e) => change("details", e.target.value)}
                placeholder="文件清单、格式、版本等已核实信息"
              />
            </Field>
            <Field label="适合人群">
              <input
                aria-label="适合人群"
                maxLength={120}
                value={form.audience}
                onChange={(e) => change("audience", e.target.value)}
              />
            </Field>
            <Field
              label="中文口令"
              hint="填入网盘已生成的完整口令，保存到当前本人分享对应的图文任务。"
            >
              <input
                aria-label="中文口令"
                maxLength={80}
                value={form.passphrase}
                onChange={(e) => change("passphrase", e.target.value)}
                placeholder="原样粘贴中文口令"
              />
            </Field>
            <div className="photo-post-field-row">
              <Field label="领取方式">
                <Select
                  aria-label="领取方式"
                  value={form.retrieval}
                  items={[
                    { value: "search", label: "在网盘 App 搜索口令" },
                    { value: "share-copy", label: "复制作品链接后打开 App" },
                  ]}
                  onValueChange={(value) =>
                    change("retrieval", value as PhotoForm["retrieval"])
                  }
                />
              </Field>
              <Field label="排版风格">
                <Select
                  aria-label="排版风格"
                  value={form.theme}
                  items={[
                    { value: "blue", label: "电光蓝 · 荧光黄" },
                    { value: "warm", label: "朱砂红 · 奶油纸" },
                  ]}
                  onValueChange={(value) =>
                    change("theme", value as PhotoForm["theme"])
                  }
                />
              </Field>
            </div>
            <fieldset className="photo-post-channels">
              <legend>目标平台</legend>
              {photoPlatforms.map((platform) => (
                <label key={platform}>
                  <input
                    type="checkbox"
                    checked={form.platforms.includes(platform)}
                    onChange={(e) =>
                      change(
                        "platforms",
                        e.target.checked
                          ? [...form.platforms, platform]
                          : form.platforms.filter((p) => p !== platform),
                      )
                    }
                  />
                  {photoPlatformNames[platform]}
                </label>
              ))}
            </fieldset>

            <p className="muted">
              导出时读取本人分享检查有效性；中文口令的 App 识别结果需自行核对。
            </p>
            {folder ? (
              <div className="photo-post-exported">
                <span>图文包已导出</span>
                <Button
                  quiet
                  size="compact"
                  onClick={() =>
                    void ipc("system.copyText", { text: folder })
                      .then(() => notify("已复制导出目录。", "success"))
                      .catch((e) => setError(e.message))
                  }
                >
                  复制导出目录
                </Button>
              </div>
            ) : null}
            {storageError ? <Notice warning>{storageError}</Notice> : null}
            {error ? <Notice danger>{error}</Notice> : null}
          </fieldset>
        </Panel>
        <div className="photo-post-results">
          <PhotoPreview
            form={form}
            drive={providers[resource.provider]}
            cover={cover.data}
            coverRequired={!!resource.coverId && form.coverStyle !== "type"}
            coverLoading={cover.loading}
            coverError={cover.error}
            onRetryCover={cover.reload}
            onRender={render}
          />
          {saved ? (
            <PhotoPublishing
              key={`${saved.id}:${saved.version}`}
              post={saved}
              dirty={dirty}
              onSaved={setSaved}
            />
          ) : (
            <Notice>保存任务并导出图文包后，选择平台继续发布。</Notice>
          )}
        </div>
      </div>
    </>
  );
}
