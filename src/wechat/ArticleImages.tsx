import { AiIcon } from "../ui/AiIcon";
import { useEffect, useId, useRef, useState } from "react";
import {
  ClipboardPaste,
  Image as ImageIcon,
  ImagePlus,
  Maximize2,
  Upload,
} from "lucide-react";
import {
  wechatImageBatchLimit,
  type WechatImageGenerationMode,
  type WechatRegenerateImagesInput,
  type WechatRegenerateImagesResult,
} from "../../shared/wechat";
import {
  defaultWechatCoverVariant,
  defaultWechatImageStyle,
  wechatCoverVariants,
  wechatCoverVariantSchema,
  wechatImageStyles,
  wechatUnifiedCover,
  type WechatCoverVariant,
  type WechatImageStyle,
} from "../../shared/wechat-image-styles";
import { wechatArticleImages } from "../../shared/wechat-markup";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { updateSelection } from "../lib/selection";
import { useAppActions } from "../state";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
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
  coverVariant: WechatCoverVariant;
  description: string;
  model?: string;
  retryModel?: { rejected?: string };
};
type Position = Targets[number]["position"];
type ImageTarget = "body" | "cover" | ArticleImage;
const targetKey = (target: ImageTarget) =>
  typeof target === "string" ? target : target.index;
const selectionKey = ({ position, url }: Targets[number]) =>
  `${position}:${url}`;
const imageLabel = (position: Position) =>
  position === "cover" ? "文章封面" : `插图 ${position + 1}`;
const existingImageOptions = [
  ...wechatImageStyles.map(({ id, label }) => ({ value: id, label })),
  { value: "theme", label: "按文章主题生成" },
];
const unifiedCoverOption = {
  value: wechatUnifiedCover.id,
  label: wechatUnifiedCover.label,
};
const coverVariantOptions = wechatCoverVariantSchema.options.map((value) => ({
  value,
  label: wechatCoverVariants[value].label,
}));

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
  coverModelSelection,
  coverStyleReferences,
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
  coverModelSelection: boolean;
  coverStyleReferences: boolean;
  onBody(body: string): void;
  onCover(url: string): void;
  onCoverAddress(url: string | null): void;
  onImageAddress(url: string | null): void;
  onBusy(busy: boolean): void;
  onRegenerate(request: ImageRequest): Promise<WechatRegenerateImagesResult>;
}) {
  const { notify } = useAppActions();
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
        modelRetry?: ImageRequest;
        newCover: boolean;
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
  const coverOnly =
    confirm?.targets.length === 1 && confirm.targets[0].position === "cover";
  const newCover = coverOnly && !confirm.targets[0].url;
  const unifiedCover = confirm?.mode === wechatUnifiedCover.id;
  const coverVariant = confirm?.coverVariant ?? defaultWechatCoverVariant;
  const coverUpdatePending = unifiedCover && !coverStyleReferences;
  const selectCoverModel = coverModelSelection && unifiedCover;
  const modelCatalog = useIpcQuery("studio.modelCatalog", undefined, {
    enabled: selectCoverModel,
    keepPrevious: true,
  });
  const imageModels = modelCatalog.data?.filter(
    (model) => model.kind === "image",
  );
  const modelOptions = imageModels?.filter(
    (model) => model.id !== confirm?.retryModel?.rejected,
  );
  const modelId = selectCoverModel
    ? (confirm?.model ??
      (confirm?.retryModel ? "" : wechatUnifiedCover.defaultModel))
    : undefined;
  const chosenModel = modelOptions?.find((model) => model.id === modelId);
  const rejectedModel = imageModels?.find(
    (model) => model.id === confirm?.retryModel?.rejected,
  );
  const needsModel = selectCoverModel && !chosenModel;
  const modelRetry =
    report?.modelRetry?.targets[0]?.url === coverUrl
      ? report?.modelRetry
      : undefined;
  const openGenerate = (
    targets: Targets,
    mode: WechatImageGenerationMode = "reference",
    description = "",
  ) =>
    setConfirm({
      targets,
      mode,
      style: defaultWechatImageStyle,
      coverVariant: defaultWechatCoverVariant,
      description,
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
  const loadImage = async (target: ImageTarget, pasteLabel?: string) => {
    if (lock.current || disabled) return;
    lock.current = true;
    setPending(pasteLabel ? `paste:${targetKey(target)}` : targetKey(target));
    onBusy(true);
    setError("");
    try {
      const image = await ipc(
        pasteLabel ? "wechat.pasteImage" : "wechat.pickImage",
        { id },
      );
      if (!mounted.current) return;
      if (!image) {
        if (pasteLabel)
          notify(
            "剪贴板里没有可用的图片。请在微信原文中复制图片后再试。",
            "warning",
          );
        return;
      }
      if (target === "cover") {
        onCover(image.url);
      } else if (target === "body") {
        append(image.url, image.name.replace(/[\[\]\n]/g, "") || "文章配图");
      } else {
        const alt = pasteLabel
          ? target.alt
          : (target.alt || image.name || "文章配图").replace(/[\[\]\n]/g, "");
        replace(target.index, target.markup, `![${alt}](${image.url})`);
        if (!coverUrl || target.url === coverUrl) onCover(image.url);
      }
      if (pasteLabel) notify(`已更新${pasteLabel}。`, "success");
    } catch (cause) {
      if (mounted.current) {
        const message = cause instanceof Error ? cause.message : "";
        if (pasteLabel)
          notify(message || "图片读取失败，请重新复制后再试。", "error");
        else setError(message || "图片读取失败，请重新选择图片。");
      }
    } finally {
      lock.current = false;
      if (mounted.current) setPending(null);
      onBusy(false);
    }
  };
  const pasteButton = (target: "cover" | ArticleImage, label: string) => {
    const action = target === "cover" && !coverUrl ? "粘贴封面" : "粘贴替换";
    const pasting = pending === `paste:${targetKey(target)}`;
    return (
      <Button
        size="compact"
        disabled={blocked}
        aria-label={`${pasting ? "正在粘贴…" : action}（${label}）`}
        title="使用剪贴板里的图片"
        onClick={() => void loadImage(target, label)}
      >
        <ClipboardPaste size={14} aria-hidden="true" />
        {pasting ? "正在粘贴…" : action}
      </Button>
    );
  };
  const openPreview = (src: string, label: string) => {
    setPreviewFailed(false);
    setPreview({ src, label });
  };
  const generate = async () => {
    if (!confirm || blocked || needsModel || coverUpdatePending || lock.current)
      return;
    lock.current = true;
    setPending("ai");
    onBusy(true);
    setError("");
    setReport(null);
    try {
      const result = await onRegenerate({
        ...confirm,
        coverVariant,
        model: modelId,
      });
      if (!mounted.current) return;
      const failedTargets = confirm.targets.filter((target) =>
        result.failed.some(({ position }) => target.position === position),
      );
      setSelected(failedTargets.map(selectionKey));
      if (result.failed.length) {
        const [failure] = result.failed;
        const canRetryWithModel =
          selectCoverModel &&
          failure.position === "cover" &&
          failedTargets.length === 1 &&
          ["MEDIA_POLICY_REJECTED", "MEDIA_ACCESS_DENIED"].includes(
            failure.code ?? "",
          );
        const themeTargets =
          confirm.mode === "reference"
            ? failedTargets.filter((target) =>
                result.failed.some(
                  (failure) =>
                    failure.position === target.position &&
                    [
                      "MEDIA_POLICY_REJECTED",
                      "MEDIA_REFERENCE_MODEL",
                      "MEDIA_FACE_REJECTED",
                    ].includes(failure.code ?? ""),
                ),
              )
            : [];
        setReport({
          replaced: result.replaced,
          failed: result.failed,
          retry: themeTargets,
          modelRetry: canRetryWithModel
            ? {
                ...confirm,
                targets: failedTargets,
                model: undefined,
                retryModel: {
                  rejected: failure.model || modelId,
                },
              }
            : undefined,
          newCover,
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
            {report.newCover
              ? "本次未生成封面。"
              : `${report.replaced ? `已替换 ${report.replaced} 处。` : "本次未替换图片。"}${report.failed.length} 处保留原图。`}
            <ul className="wechat-issues">
              {report.failed.map(({ position, message }) => (
                <li key={position}>
                  {imageLabel(position)} · {message}
                </li>
              ))}
            </ul>
            {modelRetry ? (
              <Button
                size="compact"
                disabled={blocked}
                onClick={() => setConfirm(modelRetry)}
              >
                换模型重试
              </Button>
            ) : null}
            {retryTargets.length ? (
              <Button
                size="compact"
                disabled={blocked}
                onClick={() =>
                  openGenerate(
                    retryTargets,
                    "theme",
                    report.failed.some(
                      ({ code }) => code === "MEDIA_FACE_REJECTED",
                    )
                      ? "不描绘人物、人脸、人像或真人照片，使用抽象图形与主题相关物件组成原创概念插画。"
                      : "",
                  )
                }
              >
                {report.failed.some(
                  ({ code }) => code === "MEDIA_FACE_REJECTED",
                )
                  ? "生成无人物主题插画"
                  : "改用文章主题生成"}
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
              {batch ? (
                coverUrl ? (
                  selectImage("cover", coverUrl)
                ) : null
              ) : (
                <Button
                  size="compact"
                  disabled={blocked}
                  onClick={() =>
                    openGenerate(
                      [{ position: "cover", url: coverUrl }],
                      coverUrl ? "reference" : wechatUnifiedCover.id,
                    )
                  }
                >
                  <AiIcon size={14} /> {coverUrl ? "AI 换封面" : "AI 生成封面"}
                </Button>
              )}
              {!batch ? (
                <>
                  {pasteButton("cover", "文章封面")}
                  <Button
                    size="compact"
                    disabled={blocked}
                    onClick={() => void loadImage("cover")}
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
              onClick={() => void loadImage("body")}
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
                          {pasteButton(image, label)}
                          <Button
                            size="compact"
                            disabled={blocked}
                            aria-label={`更换图片（${label}）`}
                            onClick={() => void loadImage(image)}
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
          title={newCover ? "AI 生成封面" : "AI 生成替换图"}
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
                disabled={blocked || needsModel || coverUpdatePending}
                onClick={() => void generate()}
              >
                {pending === "ai"
                  ? "正在生成…"
                  : newCover
                    ? "开始生成封面"
                    : "开始生成并替换"}
              </Button>
            </>
          }
        >
          <Field label="生成方式">
            <Select
              value={
                confirm.mode === "reference" ? confirm.style : confirm.mode
              }
              disabled={blocked || !!confirm.retryModel}
              items={
                newCover
                  ? [unifiedCoverOption]
                  : coverOnly
                    ? [...existingImageOptions, unifiedCoverOption]
                    : existingImageOptions
              }
              onValueChange={(option) => {
                if (option === "theme" || option === wechatUnifiedCover.id) {
                  setConfirm({ ...confirm, mode: option });
                  return;
                }
                const style = wechatImageStyles.find(({ id }) => id === option);
                if (style)
                  setConfirm({
                    ...confirm,
                    mode: "reference",
                    style: style.id,
                  });
              }}
            />
          </Field>
          {unifiedCover ? (
            <Field
              label="封面风格"
              hint={wechatCoverVariants[coverVariant].description}
            >
              <Select
                value={coverVariant}
                items={coverVariantOptions}
                disabled={blocked}
                onValueChange={(value) => {
                  const next = wechatCoverVariantSchema.safeParse(value);
                  if (next.success)
                    setConfirm({ ...confirm, coverVariant: next.data });
                }}
              />
            </Field>
          ) : null}
          {coverUpdatePending ? (
            <Notice warning>
              请先点击顶部「应用更新并重启」，再使用新封面风格。
            </Notice>
          ) : null}
          {selectCoverModel ? (
            <>
              <Field
                label="图片模型"
                hint={
                  confirm.retryModel?.rejected
                    ? `上次被拒的模型 ${rejectedModel?.name ?? confirm.retryModel.rejected}`
                    : "所选模型仅用于这次生成"
                }
              >
                <Select
                  value={modelId ?? ""}
                  disabled={blocked || !modelOptions?.length}
                  items={[
                    ...(!modelId
                      ? [
                          {
                            value: "",
                            label: "请选择其他图片模型",
                            disabled: true,
                          },
                        ]
                      : !chosenModel
                        ? [
                            {
                              value: modelId,
                              label:
                                modelId === wechatUnifiedCover.defaultModel
                                  ? wechatUnifiedCover.defaultModelLabel
                                  : modelId,
                              disabled: true,
                            },
                          ]
                        : []),
                    ...(modelOptions ?? []).map((model) => ({
                      value: model.id,
                      label: model.name,
                    })),
                  ]}
                  onValueChange={(model) =>
                    setConfirm({ ...confirm, model: model || undefined })
                  }
                />
              </Field>
              {modelCatalog.loading && !imageModels ? (
                <Loading label="正在读取图片模型…" />
              ) : null}
              <QueryError
                error={modelCatalog.error}
                title="图片模型暂时无法读取"
                loading={modelCatalog.loading}
                onRetry={modelCatalog.reload}
              />
              {imageModels && !modelOptions?.length && !modelCatalog.error ? (
                <p className="muted">
                  暂无可选图片模型。可在「连接与设置」刷新模型列表。
                </p>
              ) : null}
              {imageModels &&
              modelOptions?.length &&
              modelId &&
              !chosenModel &&
              !modelCatalog.error ? (
                <p className="muted">
                  所选模型尚未出现在本地目录。可在「连接与设置」刷新模型列表，或先改选其他模型。
                </p>
              ) : null}
              {chosenModel?.pricing ? (
                <p className="muted">缓存报价 {chosenModel.pricing}</p>
              ) : null}
            </>
          ) : null}
          {confirm.mode !== "reference" ? (
            <Field
              label={
                confirm.mode === wechatUnifiedCover.id ? "画面主体" : "画面描述"
              }
              hint="可选，留空使用文章标题"
            >
              <input
                value={confirm.description}
                maxLength={300}
                disabled={blocked}
                placeholder={
                  confirm.mode === wechatUnifiedCover.id
                    ? "例如，蓝色立体时钟叠在浅黄日历前"
                    : "例如，古籍与笔墨的简洁插画"
                }
                onChange={(event) =>
                  setConfirm({ ...confirm, description: event.target.value })
                }
              />
            </Field>
          ) : null}
          <p className="muted">
            {confirm.mode === wechatUnifiedCover.id
              ? `生成 ${wechatUnifiedCover.size.width} × ${wechatUnifiedCover.size.height} 像素头条横版封面。左侧是根据文章标题提炼的短标题，右侧是立体主图。`
              : confirm.mode === "theme"
                ? "使用文章主题创作，不上传原图。"
                : `${wechatImageStyles.find(({ id }) => id === confirm.style)!.description}使用参考图，忽略水印，不添加海报文字。`}
            {newCover ? "" : `替换选中的 ${confirm.targets.length} 处图片。`}
            {unifiedCover && chosenModel?.reference
              ? "按所选风格的样稿参考版式和配色。"
              : ""}
            {selectCoverModel
              ? "按所选模型的服务商标准计费。"
              : "使用全局默认图片模型，按服务商计费。"}
            {newCover ? "" : "失败项保留原图。"}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}
