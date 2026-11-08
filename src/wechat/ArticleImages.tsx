import { AiIcon } from "../ui/AiIcon";
import { useEffect, useId, useRef, useState } from "react";
import { Image as ImageIcon, ImagePlus, Maximize2, Upload } from "lucide-react";
import {
  wechatImageBatchLimit,
  type WechatImageGenerationMode,
  type WechatRegenerateImagesInput,
  type WechatRegenerateImagesResult,
} from "../../shared/wechat";
import {
  defaultWechatImageStyle,
  wechatImageStyles,
  type WechatImageStyle,
} from "../../shared/wechat-image-styles";
import { wechatArticleImages } from "../../shared/wechat-markup";
import { ipc } from "../api/client";
import { updateSelection } from "../lib/selection";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { wechatImagePreviewUrl } from "./image-preview";
import {
  Button,
  Empty,
  Field,
  Loading,
  Notice,
  Status,
} from "../ui/primitives";
import "./article-images.css";

const validUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !/[\s)\[\]]/.test(raw)
    );
  } catch {
    return false;
  }
};

type ArticleImage = ReturnType<typeof wechatArticleImages>[number];
type Targets = WechatRegenerateImagesInput["targets"];
type ImageRequest = {
  targets: Targets;
  mode: WechatImageGenerationMode;
  style: WechatImageStyle;
  description: string;
};
type Position = Targets[number]["position"];
type UploadTarget = "body" | "cover" | ArticleImage;
const selectionKey = ({ position, url }: Targets[number]) =>
  `${position}:${url}`;
const imageLabel = (position: Position) =>
  position === "cover" ? "文章封面" : `插图 ${position + 1}`;

function ImagePreview({
  url,
  alt,
  label,
  onOpen,
}: {
  url: string;
  alt: string;
  label: string;
  onOpen(src: string): void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const frame = useRef<HTMLDivElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  // The preview proxy discards the source fragment before download. Changing
  // only that fragment gives Chromium a fresh request after a network error.
  const request =
    attempt && /^https:/i.test(url)
      ? `${url.split("#")[0]}#panxu-retry-${attempt}`
      : url;
  const src = wechatImagePreviewUrl(request);
  const phase = src ? state : "error";
  return (
    <div
      ref={frame}
      className="wechat-image-preview"
      data-phase={phase}
      aria-busy={phase === "loading"}
      role="group"
      aria-label={`${label}预览`}
      tabIndex={-1}
    >
      {src && phase !== "error" ? (
        <img
          key={attempt}
          src={src}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => {
            if (document.activeElement === retry.current)
              frame.current?.focus({ preventScroll: true });
            setState("ready");
          }}
          onError={() => setState("error")}
        />
      ) : null}
      {phase === "ready" ? (
        <button
          className="wechat-image-preview-open"
          type="button"
          aria-label={`查看大图（${label}）`}
          onClick={() => onOpen(src)}
        >
          <Maximize2 size={13} aria-hidden="true" />
        </button>
      ) : null}
      {phase !== "ready" ? (
        <div className="wechat-image-preview-feedback">
          {phase === "loading" ? (
            <Loading label="加载中" announce={false} />
          ) : (
            <span role="status">{src ? "预览失败" : "图片地址无效"}</span>
          )}
          {src && (phase === "error" || attempt > 0) ? (
            <Button
              ref={retry}
              quiet
              size="compact"
              aria-label={`重试预览（${label}）`}
              aria-disabled={phase === "loading" || undefined}
              onClick={() => {
                if (phase === "loading") return;
                setState("loading");
                setAttempt((value) => value + 1);
              }}
            >
              重试预览
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ImageAddress({
  summary,
  label,
  action,
  value = "",
  entry,
  disabled,
  onEntry,
  onUse,
}: {
  summary: string;
  label: string;
  action: string;
  value?: string;
  entry: string | null;
  disabled: boolean;
  onEntry(value: string | null): void;
  onUse(url: string): void;
}) {
  const [invalid, setInvalid] = useState(false);
  const [expanded, setExpanded] = useState(!!entry);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const url = entry ?? value;
  return (
    <details
      className="wechat-image-address"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !url.trim()) return;
          if (!validUrl(url.trim())) {
            setInvalid(true);
            input.current?.focus();
            return;
          }
          onUse(url.trim());
          onEntry(null);
          setInvalid(false);
        }}
      >
        <div className="wechat-image-address-fields">
          <Field label={label}>
            <input
              ref={input}
              type="url"
              value={url}
              disabled={disabled}
              onChange={(event) => {
                onEntry(event.target.value);
                setInvalid(false);
              }}
              maxLength={4000}
              placeholder="https://…"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
            />
          </Field>
          <Button type="submit" disabled={disabled || !url.trim()}>
            {action}
          </Button>
        </div>
        {invalid ? (
          <p className="wechat-image-address-error" id={errorId} role="alert">
            请输入完整的 HTTPS 图片地址。
          </p>
        ) : null}
      </form>
    </details>
  );
}
export function ArticleImages({
  id,
  body,
  coverUrl,
  coverAddress,
  imageAddress,
  disabled,
  onBody,
  onCover,
  onCoverAddress,
  onImageAddress,
  onBusy,
  onRegenerate,
}: {
  id: string;
  body: string;
  coverUrl: string;
  coverAddress: string | null;
  imageAddress: string | null;
  disabled: boolean;
  onBody(body: string): void;
  onCover(url: string): void;
  onCoverAddress(url: string | null): void;
  onImageAddress(url: string | null): void;
  onBusy(busy: boolean): void;
  onRegenerate(request: ImageRequest): Promise<WechatRegenerateImagesResult>;
}) {
  const images = wechatArticleImages(body);
  const coverIndex = images.findIndex((image) => image.url === coverUrl);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | number | null>(null);
  const [preview, setPreview] = useState<{ src: string; label: string } | null>(
    null,
  );
  const [previewFailed, setPreviewFailed] = useState(false);
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<ImageRequest | null>(null);
  const [report, setReport] = useState<
    | (Pick<WechatRegenerateImagesResult, "failed" | "replaced"> & {
        retry: Targets;
      })
    | null
  >(null);
  const lock = useRef(false);
  const mounted = useRef(false);
  const coverHeading = useId();
  const illustrationHeading = useId();
  const blocked = disabled || pending !== null;
  const candidates: Targets = [
    ...(coverUrl ? [{ position: "cover" as const, url: coverUrl }] : []),
    ...images.map((image, position) => ({ position, url: image.url })),
  ];
  const selectedTargets = candidates.filter((target) =>
    selected.includes(selectionKey(target)),
  );
  const retryTargets = candidates.filter((target) =>
    report?.retry.some((item) => selectionKey(item) === selectionKey(target)),
  );
  const openGenerate = (
    targets: Targets,
    mode: WechatImageGenerationMode = "reference",
  ) =>
    setConfirm({
      targets,
      mode,
      style: defaultWechatImageStyle,
      description: "",
    });
  const selectImage = (position: Position, url: string) => {
    const key = selectionKey({ position, url });
    return (
      <input
        type="checkbox"
        className="wechat-image-select"
        checked={selected.includes(key)}
        aria-label={`选择${imageLabel(position)}`}
        disabled={
          blocked ||
          (!selected.includes(key) &&
            selectedTargets.length >= wechatImageBatchLimit)
        }
        onChange={(event) =>
          setSelected((current) =>
            updateSelection(
              current,
              [key],
              event.target.checked,
              wechatImageBatchLimit,
            ),
          )
        }
      />
    );
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const replace = (index: number, markup: string, next: string) =>
    onBody(body.slice(0, index) + next + body.slice(index + markup.length));
  const append = (url: string, alt = "文章配图") => {
    setError("");
    onBody(`${body}\n\n![${alt}](${url})\n`);
    if (!coverUrl) onCover(url);
  };
  const upload = async (target: UploadTarget) => {
    if (lock.current || disabled) return;
    lock.current = true;
    setPending(typeof target === "string" ? target : target.index);
    onBusy(true);
    setError("");
    try {
      const image = await ipc("wechat.pickImage", { id });
      if (!image || !mounted.current) return;
      if (target === "cover") {
        onCover(image.url);
        return;
      }
      const alt = (
        (typeof target === "string" ? "" : target.alt) ||
        image.name ||
        "文章配图"
      ).replace(/[\[\]\n]/g, "");
      if (target === "body") append(image.url, alt);
      else {
        replace(target.index, target.markup, `![${alt}](${image.url})`);
        if (!coverUrl || target.url === coverUrl) onCover(image.url);
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "图片读取失败，请重新选择图片。",
        );
    } finally {
      lock.current = false;
      if (mounted.current) setPending(null);
      onBusy(false);
    }
  };
  const openPreview = (src: string, label: string) => {
    setPreviewFailed(false);
    setPreview({ src, label });
  };
  const generate = async () => {
    if (!confirm || blocked || lock.current) return;
    lock.current = true;
    setPending("ai");
    onBusy(true);
    setError("");
    setReport(null);
    try {
      const result = await onRegenerate(confirm);
      if (!mounted.current) return;
      const failedTargets = confirm.targets.filter((target) =>
        result.failed.some(({ position }) => target.position === position),
      );
      setSelected(failedTargets.map(selectionKey));
      if (result.failed.length) {
        const canUseTheme =
          confirm.mode === "reference" &&
          result.failed.some(
            ({ code }) =>
              code === "MEDIA_POLICY_REJECTED" ||
              code === "MEDIA_REFERENCE_MODEL",
          );
        setReport({
          replaced: result.replaced,
          failed: result.failed,
          retry: canUseTheme ? failedTargets : [],
        });
      } else setBatch(false);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "AI 换图未完成，请重试。",
        );
    } finally {
      lock.current = false;
      if (mounted.current) {
        setPending(null);
        setConfirm(null);
      }
      onBusy(false);
    }
  };
  return (
    <div className="wechat-images">
      {error ? (
        <Notice danger>
          <span role="alert">{error}</span>
        </Notice>
      ) : null}
      {report ? (
        <Notice warning>
          <div role="status">
            {report.replaced
              ? `已替换 ${report.replaced} 处。`
              : "本次未替换图片。"}{" "}
            {report.failed.length} 处保留原图。
            <ul className="wechat-issues">
              {report.failed.map(({ position, message }) => (
                <li key={position}>
                  {imageLabel(position)} · {message}
                </li>
              ))}
            </ul>
            {retryTargets.length ? (
              <Button
                size="compact"
                disabled={blocked}
                onClick={() => openGenerate(retryTargets, "theme")}
              >
                改用文章主题生成
              </Button>
            ) : null}
          </div>
        </Notice>
      ) : null}
      {batch ? (
        <div className="wechat-image-batch">
          <span>
            已选 {selectedTargets.length} 处
            {candidates.length > wechatImageBatchLimit
              ? `，每次最多 ${wechatImageBatchLimit} 处`
              : ""}
          </span>
          <Button
            size="compact"
            quiet
            disabled={blocked}
            onClick={() =>
              setSelected(
                selectedTargets.length
                  ? []
                  : candidates
                      .slice(0, wechatImageBatchLimit)
                      .map(selectionKey),
              )
            }
          >
            {selectedTargets.length
              ? "清空选择"
              : candidates.length > wechatImageBatchLimit
                ? `选择前 ${wechatImageBatchLimit} 处`
                : "全选"}
          </Button>
          <Button
            size="compact"
            quiet
            disabled={blocked}
            onClick={() => {
              setBatch(false);
              setSelected([]);
            }}
          >
            取消批量
          </Button>
          <Button
            primary
            size="compact"
            disabled={blocked || !selectedTargets.length}
            onClick={() => openGenerate(selectedTargets)}
          >
            生成并替换所选
          </Button>
        </div>
      ) : null}
      <section className="wechat-image-section" aria-labelledby={coverHeading}>
        <div className="wechat-image-item">
          {coverUrl ? (
            <ImagePreview
              key={coverUrl}
              url={coverUrl}
              alt="文章封面"
              label="文章封面"
              onOpen={(src) => openPreview(src, "文章封面")}
            />
          ) : (
            <div
              className="wechat-image-preview wechat-image-preview-empty"
              aria-hidden="true"
            >
              <ImageIcon size={20} />
            </div>
          )}
          <div className="wechat-image-item-main">
            <div className="wechat-image-item-copy">
              <h3 id={coverHeading}>文章封面</h3>
              <small>
                {coverIndex >= 0
                  ? `取自插图 ${coverIndex + 1}`
                  : coverUrl
                    ? "独立封面"
                    : "上传封面，或从正文插图中选用。"}
              </small>
            </div>
            <div className="wechat-image-item-actions">
              {coverUrl ? (
                batch ? (
                  selectImage("cover", coverUrl)
                ) : (
                  <Button
                    size="compact"
                    disabled={blocked}
                    onClick={() =>
                      openGenerate([{ position: "cover", url: coverUrl }])
                    }
                  >
                    <AiIcon size={14} /> AI 换封面
                  </Button>
                )
              ) : null}
              {!batch ? (
                <>
                  <Button
                    size="compact"
                    disabled={blocked}
                    onClick={() => void upload("cover")}
                  >
                    {pending === "cover"
                      ? "正在选图…"
                      : coverUrl
                        ? "更换封面"
                        : "上传封面"}
                  </Button>
                  {coverUrl ? (
                    <Button
                      quiet
                      size="compact"
                      disabled={blocked}
                      onClick={() => onCover("")}
                    >
                      清除封面
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </div>
        <ImageAddress
          summary="使用封面图片地址"
          label="封面图片地址"
          action="应用封面"
          value={coverUrl.startsWith("https:") ? coverUrl : ""}
          entry={coverAddress}
          onEntry={onCoverAddress}
          disabled={blocked || batch}
          onUse={(url) => {
            setError("");
            onCover(url);
          }}
        />
      </section>
      <section
        className="wechat-image-section"
        aria-labelledby={illustrationHeading}
      >
        <div className="wechat-image-section-header">
          <div className="wechat-image-heading">
            <h3 id={illustrationHeading}>正文插图</h3>
            <small>{images.length} 张</small>
          </div>
          <div className="wechat-image-item-actions">
            {!batch && candidates.length > 1 ? (
              <Button
                size="compact"
                disabled={blocked}
                onClick={() => {
                  setBatch(true);
                  setSelected([]);
                }}
              >
                <AiIcon size={14} /> 批量 AI 换图
              </Button>
            ) : null}
            <Button
              disabled={blocked || batch}
              onClick={() => void upload("body")}
            >
              <Upload size={14} aria-hidden="true" />
              {pending === "body" ? "正在选图…" : "添加本地图片"}
            </Button>
          </div>
        </div>
        <ImageAddress
          summary="使用图片地址"
          label="HTTPS 图片地址"
          action="插入文末"
          entry={imageAddress}
          onEntry={onImageAddress}
          disabled={blocked || batch}
          onUse={append}
        />
        {images.length ? (
          <ul className="wechat-illustration-list">
            {images.map((image, index) => {
              const label = `插图 ${index + 1}`;
              const currentCover = coverUrl === image.url;
              return (
                <li className="wechat-image-item" key={index}>
                  <ImagePreview
                    key={image.url}
                    url={image.url}
                    alt={image.alt || label}
                    label={label}
                    onOpen={(src) => openPreview(src, label)}
                  />
                  <div className="wechat-image-item-main">
                    <div className="wechat-image-item-copy">
                      <div className="wechat-image-heading">
                        <strong>{label}</strong>
                        {currentCover ? <Status>当前封面</Status> : null}
                      </div>
                      <small>{image.alt || "文章配图"}</small>
                    </div>
                    <div className="wechat-image-item-actions">
                      {batch ? (
                        selectImage(index, image.url)
                      ) : (
                        <>
                          <Button
                            size="compact"
                            disabled={blocked}
                            aria-label={`AI 换图（${label}）`}
                            onClick={() =>
                              openGenerate([
                                { position: index, url: image.url },
                              ])
                            }
                          >
                            <AiIcon size={14} /> AI 换图
                          </Button>
                          <Button
                            size="compact"
                            disabled={blocked}
                            aria-label={`更换图片（${label}）`}
                            onClick={() => void upload(image)}
                          >
                            {pending === image.index ? "正在选图…" : "更换图片"}
                          </Button>
                          {!currentCover ? (
                            <Button
                              size="compact"
                              quiet
                              disabled={blocked}
                              aria-label={`设为封面（${label}）`}
                              onClick={() => onCover(image.url)}
                            >
                              设为封面
                            </Button>
                          ) : null}
                          <Button
                            size="compact"
                            quiet
                            disabled={blocked}
                            aria-label={`移除（${label}）`}
                            onClick={() => {
                              replace(image.index, image.markup, "");
                              if (currentCover)
                                onCover(
                                  images.find(
                                    (item) => item.index !== image.index,
                                  )?.url ?? "",
                                );
                            }}
                          >
                            移除
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty compact icon={ImagePlus} title="正文还没有插图">
            {coverUrl
              ? "添加插图后可从列表更换封面。"
              : "添加的第一张插图会自动用作封面。"}
          </Empty>
        )}
      </section>
      {preview ? (
        <Dialog
          title={preview.label}
          className="wechat-image-lightbox"
          focus="container"
          onClose={() => setPreview(null)}
        >
          {previewFailed ? (
            <Notice warning>图片暂时无法加载，请关闭后重新打开。</Notice>
          ) : (
            <img
              src={preview.src}
              alt={preview.label}
              referrerPolicy="no-referrer"
              onError={() => setPreviewFailed(true)}
            />
          )}
        </Dialog>
      ) : null}
      {confirm ? (
        <Dialog
          title="AI 生成替换图"
          focus="container"
          busy={pending === "ai"}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button
                disabled={pending === "ai"}
                onClick={() => setConfirm(null)}
              >
                取消
              </Button>
              <Button
                primary
                disabled={blocked}
                onClick={() => void generate()}
              >
                {pending === "ai" ? "正在生成…" : "开始生成并替换"}
              </Button>
            </>
          }
        >
          <Field label="生成方式">
            <Select
              value={confirm.mode === "theme" ? "theme" : confirm.style}
              disabled={blocked}
              items={[
                ...wechatImageStyles.map(({ id, label }) => ({
                  value: id,
                  label,
                })),
                { value: "theme", label: "按文章主题生成" },
              ]}
              onValueChange={(mode) =>
                setConfirm({
                  ...confirm,
                  mode: mode === "theme" ? "theme" : "reference",
                  style: mode === "vivid" ? "vivid" : "natural",
                })
              }
            />
          </Field>
          {confirm.mode === "theme" ? (
            <Field label="画面描述" hint="可选，留空使用文章标题">
              <input
                value={confirm.description}
                maxLength={300}
                disabled={blocked}
                placeholder="例如，古籍与笔墨的简洁插画"
                onChange={(event) =>
                  setConfirm({ ...confirm, description: event.target.value })
                }
              />
            </Field>
          ) : null}
          <p className="muted">
            {confirm.mode === "theme"
              ? "使用文章主题创作，不上传原图。"
              : `${wechatImageStyles.find(({ id }) => id === confirm.style)!.description}两种重绘都使用参考图，忽略水印，不添加海报文字。`}
            替换选中的 {confirm.targets.length}{" "}
            处图片。使用全局默认图片模型，按服务商计费。失败项保留原图。
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}
