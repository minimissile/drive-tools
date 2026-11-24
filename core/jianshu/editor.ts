import { createHash } from "node:crypto";
import type { ContentImage } from "../../shared/content-sources";
import {
  jianshuDraftUrl,
  type JianshuFillCheckpoint,
  type JianshuPayload,
  type JianshuPreparation,
} from "../../shared/jianshu";
import { AppError } from "../errors";
import { jianshuEditorPage } from "./editor-page";

export interface JianshuEditorDriver {
  url(): string;
  evaluate<T>(script: string): Promise<T>;
  /** Observe this page's official create response before clicking once. */
  createDraft?(): Promise<string>;
}
export interface JianshuCreateSnapshot {
  editorUrl: string;
  notebookId: string;
}

/** The notebook selected in an official writer route, never inferred from page order. */
export function jianshuNotebookId(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["www.jianshu.com", "jianshu.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      !/^\/writer\/?$/.test(url.pathname)
    )
      return null;
    return (
      /^#\/notebooks\/([1-9]\d*)(?:\/notes\/[1-9]\d*)?$/.exec(url.hash)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

/** Only a correlated POST response can establish the identity of a newly-created note. */
export function jianshuCreatedDraftUrl(
  value: unknown,
  expectedNotebookId: string,
): string | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !/^[1-9]\d*$/.test(expectedNotebookId)
  )
    return null;
  const note = value as Record<string, unknown>;
  const id = (value: unknown) =>
    (typeof value === "string" ||
      (typeof value === "number" && Number.isSafeInteger(value))) &&
    /^[1-9]\d*$/.test(String(value))
      ? String(value)
      : null;
  const noteId = id(note.id),
    notebookId = id(note.notebook_id);
  if (
    !noteId ||
    notebookId !== expectedNotebookId ||
    note.shared !== false ||
    (note.schedule_publish_at !== undefined &&
      note.schedule_publish_at !== null) ||
    note.last_compiled_at !== 0
  )
    return null;
  return jianshuDraftUrl(
    `https://www.jianshu.com/writer#/notebooks/${notebookId}/notes/${noteId}`,
  );
}
type Observation = {
  url: string;
  ready: boolean;
  canCreate: boolean;
  unpublished: boolean;
  title: string;
  text: string;
  expectedText: string;
  images: { url: string; name: string; loaded: boolean }[];
  saved: boolean;
  uploadOpen: boolean;
};
const normalized = (text: string) =>
  text.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/g, "");
const hash = (text: string) =>
  createHash("sha256").update(normalized(text)).digest("hex");
const imageKey = (raw: string) => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return "";
    return url.origin + url.pathname;
  } catch {
    return "";
  }
};
const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
export function jianshuEditorScript(
  input: Parameters<typeof jianshuEditorPage>[0],
) {
  return `(() => { const __name = fn => fn; return (${jianshuEditorPage.toString()})(${JSON.stringify(input)}); })()`;
}

/** Read-only readiness check before installing the page-scoped create observer. */
export async function prepareJianshuDraftCreation(
  driver: Pick<JianshuEditorDriver, "url" | "evaluate">,
): Promise<JianshuCreateSnapshot> {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await driver.evaluate<JianshuCreateSnapshot | null>(
      jianshuEditorScript({ action: "prepareCreate" }),
    );
    if (
      value &&
      value.editorUrl === driver.url() &&
      jianshuNotebookId(value.editorUrl) === value.notebookId
    )
      return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new AppError(
    "JIANSHU_CREATE_NOT_READY",
    "简书文集或原稿尚未加载完成，未点击新建文章；请检查官网后继续。",
  );
}

/** Fill only an independent, unpublished official note. Publishing remains a human action. */
export async function fillJianshuEditor(
  driver: JianshuEditorDriver,
  payload: JianshuPayload,
  onCheckpoint?: (checkpoint: JianshuFillCheckpoint) => Promise<void>,
  readImage?: (image: ContentImage) => Promise<Buffer>,
): Promise<JianshuPreparation> {
  // Validate/read every local image before creating a remote draft.
  const files = await Promise.all(
    payload.images.map(async (image) => {
      if (!readImage)
        throw new AppError(
          "JIANSHU_IMAGE_READER",
          "当前后端不支持自动上传配图，请应用更新后重试。",
        );
      const bytes = await readImage(image);
      return { image, bytes };
    }),
  );
  const invoke = <T>(input: Parameters<typeof jianshuEditorPage>[0]) =>
    driver.evaluate<T>(jianshuEditorScript(input));
  const read = () =>
    invoke<Observation>({ action: "read", html: payload.html });
  const wait = async (
    predicate: (value: Observation) => boolean,
    message: string,
    timeout = 20000,
  ) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await read();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new AppError("JIANSHU_EDITOR_WAIT", message, true);
  };
  let checkpoint: JianshuFillCheckpoint | null = payload.fillCheckpoint ?? null;
  const savedUrl = jianshuDraftUrl(payload.editorUrl ?? checkpoint?.editorUrl);
  let observation: Observation;
  if (savedUrl) {
    if (jianshuDraftUrl(driver.url()) !== savedUrl)
      throw new AppError(
        "JIANSHU_EDITOR_CHANGED",
        "简书窗口已切换文章，请重新打开已关联草稿。",
        true,
      );
    observation = await wait(
      (value) => value.ready,
      "简书草稿加载未完成，请完成官网验证后继续原稿。",
    );
  } else {
    // The selected notebook may contain someone else's note. Always create a distinct note.
    await wait(
      (value) => value.canCreate,
      "简书写作页面尚未就绪，请完成官网登录后重试。",
    );
    if (!driver.createDraft)
      throw new AppError(
        "JIANSHU_CREATE_UNAVAILABLE",
        "当前后端不能可靠识别新建草稿，请应用更新后继续；未触发新建文章。",
      );
    const before = jianshuDraftUrl(driver.url());
    const created = jianshuDraftUrl(await driver.createDraft());
    if (!created || created === before)
      throw new AppError(
        "JIANSHU_CREATE_UNCERTAIN",
        "简书新建草稿回执尚未确认，请先检查官网；不会根据页面跳转猜测或重复新建。",
        true,
      );
    checkpoint = {
      editorUrl: created,
      filled: false,
      uploadedImages: 0,
      totalImages: files.length,
    };
    // Persist the precise note URL before any subsequent write or upload.
    await onCheckpoint?.(checkpoint);
    observation = await wait(
      (value) =>
        jianshuDraftUrl(value.url) === created &&
        value.ready &&
        value.unpublished &&
        !value.text &&
        value.images.length === 0,
      "简书新草稿尚未就绪或已出现内容，已保留准确地址，请检查官网后继续。",
    );
  }
  const editorUrl = savedUrl ?? checkpoint!.editorUrl;
  const assertDraft = (value: Observation) => {
    if (
      jianshuDraftUrl(value.url) !== editorUrl ||
      !value.ready ||
      !value.unpublished
    )
      throw new AppError(
        "JIANSHU_EDITOR_CHANGED",
        "简书页面已切换或文章已发布，已停止填写；请检查原草稿。",
        true,
      );
  };
  assertDraft(observation);
  const baselineTitleHash = checkpoint?.titleHash ?? hash(observation.title);
  const baselineTextHash = checkpoint?.textHash ?? hash(observation.text);
  const refs = [...(checkpoint?.uploadedImageRefs ?? [])];
  const wantedHashes = new Set(files.map(({ image }) => image.sha256));
  const knownImage = (image: Observation["images"][number]) =>
    refs.find((ref) => imageKey(ref.url) === imageKey(image.url));
  if (
    refs.some(
      (ref) =>
        !observation.images.some(
          (image) => imageKey(image.url) === imageKey(ref.url),
        ),
    )
  )
    throw new AppError(
      "JIANSHU_REMOTE_IMAGES_CHANGED",
      "官网草稿的已上传配图已被删除或替换，已保留官网修改，暂不自动重传。",
      true,
    );
  for (const image of observation.images) {
    if (!knownImage(image)) {
      // A crash between insertion and checkpoint is recoverable only with our exact filename.
      const sha256 = image.name.match(
        /^panxu-([a-f0-9]{64})\.(?:png|jpg|gif)$/,
      )?.[1];
      if (
        !sha256 ||
        refs.some((ref) => ref.sha256 === sha256) ||
        !wantedHashes.has(sha256) ||
        !imageKey(image.url)
      )
        throw new AppError(
          "JIANSHU_REMOTE_IMAGES_CHANGED",
          "官网草稿中有未确认的图片，已保留现场；请核对后再继续，避免重复上传或覆盖。",
          true,
        );
      refs.push({ sha256, url: image.url });
    }
  }
  let pendingImageSha256 = checkpoint?.pendingImageSha256 ?? null;
  if (pendingImageSha256) {
    const recovered = refs.some(
      (ref) =>
        ref.sha256 === pendingImageSha256 &&
        observation.images.some(
          (image) => imageKey(image.url) === imageKey(ref.url),
        ),
    );
    if (!recovered)
      throw new AppError(
        "JIANSHU_IMAGE_UNCERTAIN",
        "上一张图片的上传结果尚未确认，已保留原草稿，请先在官网检查上传结果；暂不重复上传。",
        true,
      );
    pendingImageSha256 = null;
  }
  const titleMatches =
    normalized(observation.title) === normalized(payload.title);
  const textMatches = observation.text === observation.expectedText;
  const titleSafe =
    titleMatches ||
    (checkpoint?.titleHash &&
      hash(observation.title) === checkpoint.titleHash) ||
    (!checkpoint?.titleHash &&
      !observation.text &&
      /^\d{4}-\d{2}-\d{2}$/.test(observation.title));
  const textSafe =
    textMatches ||
    (!checkpoint?.textHash && !observation.text) ||
    (checkpoint?.textHash && hash(observation.text) === checkpoint.textHash);
  if (!titleSafe || !textSafe)
    throw new AppError(
      "JIANSHU_REMOTE_EDITED",
      "官网草稿已被手动修改，已停止自动覆盖。请先保留官网修改，或新建本地文章后填写。",
      true,
    );
  const persist = async (value: Observation, filled: boolean) => {
    assertDraft(value);
    checkpoint = {
      editorUrl,
      filled,
      pendingImageSha256,
      titleHash: filled ? hash(value.title) : baselineTitleHash,
      textHash: filled ? hash(value.text) : baselineTextHash,
      uploadedImageRefs: refs.filter(
        (ref) =>
          wantedHashes.has(ref.sha256) &&
          value.images.some(
            (image) => imageKey(image.url) === imageKey(ref.url),
          ),
      ),
      uploadedImages: files.filter(({ image }) =>
        refs.some(
          (ref) =>
            ref.sha256 === image.sha256 &&
            value.images.some(
              (remote) => imageKey(remote.url) === imageKey(ref.url),
            ),
        ),
      ).length,
      totalImages: files.length,
    };
    await onCheckpoint?.(checkpoint);
  };
  const existing = files.flatMap(({ image }) => {
    const ref = refs.find(
      (item) =>
        item.sha256 === image.sha256 &&
        observation.images.some(
          (remote) => imageKey(remote.url) === imageKey(item.url),
        ),
    );
    return ref ? [ref] : [];
  });
  const requiresWrite =
    !titleMatches ||
    !textMatches ||
    observation.images.length !== existing.length;
  const guard = (value: Observation) => ({
    expectedEditorUrl: editorUrl,
    expectedTitle: value.title,
    expectedText: value.text,
    expectedImages: value.images.map(({ url, name }) => ({ url, name })),
  });
  const verifySaved = async (
    value: Observation,
    title: string,
    imageUrls: string[],
    html?: string,
  ) => {
    try {
      return (
        (await invoke<boolean>({
          action: "verify",
          title,
          html,
          expectedRemoteImages: imageUrls,
          ...guard(value),
        })) === true
      );
    } catch {
      return false;
    }
  };
  let originalSaved = await verifySaved(
    observation,
    observation.title,
    observation.images.map((image) => image.url),
  );
  if (!originalSaved) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    originalSaved = await verifySaved(
      observation,
      observation.title,
      observation.images.map((image) => image.url),
    );
  }
  if (!originalSaved)
    throw new AppError(
      "JIANSHU_DRAFT_UNSAVED",
      "未能核实官网草稿的保存和未发布状态，请检查官网原稿及网络后继续；已发布或定时稿不会被改写。",
      true,
    );
  if (requiresWrite) {
    const imageHtml = existing
      .map(
        (ref) =>
          `<p><img src="${escape(ref.url)}" alt="panxu-${ref.sha256}.png"></p>`,
      )
      .join("");
    await invoke({
      action: "write",
      title: payload.title,
      html: payload.html + imageHtml,
      ...guard(observation),
    });
    observation = await wait(
      (value) =>
        normalized(value.title) === normalized(payload.title) &&
        value.text === value.expectedText,
      "简书尚未接受完整标题和正文，请检查原草稿后继续。",
    );
  }
  await persist(observation, false);
  let changed = requiresWrite;
  for (const { image, bytes } of files) {
    observation = await read();
    assertDraft(observation);
    if (
      refs.some(
        (ref) =>
          ref.sha256 === image.sha256 &&
          observation.images.some(
            (remote) => imageKey(remote.url) === imageKey(ref.url),
          ),
      )
    )
      continue;
    const before = observation.images.map((item) => imageKey(item.url));
    await invoke({ action: "image", ...guard(observation) });
    await wait(
      (value) => value.uploadOpen,
      "简书图片选择框未能打开，请继续原草稿。",
    );
    const extension = image.file.split(".").at(-1)!;
    pendingImageSha256 = image.sha256;
    await persist(observation, false);
    await invoke({
      action: "upload",
      name: `panxu-${image.sha256}.${extension}`,
      mimeType: `image/${extension === "jpg" ? "jpeg" : extension}`,
      base64: bytes.toString("base64"),
      ...guard(observation),
    });
    changed = true;
    observation = await wait(
      (value) => {
        assertDraft(value);
        const added = value.images.filter(
          (item) => imageKey(item.url) && !before.includes(imageKey(item.url)),
        );
        if (
          added.length > 1 ||
          before.some(
            (key) => !value.images.some((item) => imageKey(item.url) === key),
          )
        )
          throw new AppError(
            "JIANSHU_REMOTE_IMAGES_CHANGED",
            "上传期间官网配图发生变化，已保留原稿和上传记录，请先核对图片，暂不继续上传。",
            true,
          );
        return added.length === 1 && added[0].loaded;
      },
      "简书配图上传结果尚未确认，已保留草稿；请检查图片后继续，避免重复上传。",
      45000,
    );
    assertDraft(observation);
    const uploaded = observation.images.find(
      (item) =>
        item.loaded &&
        imageKey(item.url) &&
        !before.includes(imageKey(item.url)),
    )!;
    refs.push({ sha256: image.sha256, url: uploaded.url });
    pendingImageSha256 = null;
    await persist(observation, false);
  }
  // The official editor debounces model updates by 500ms, including plain text.
  if (changed) await new Promise((resolve) => setTimeout(resolve, 750));
  const matchesDesired = (value: Observation) =>
    value.images.length === files.length &&
    normalized(value.title) === normalized(payload.title) &&
    value.text === value.expectedText &&
    files.every(({ image }) =>
      refs.some(
        (ref) =>
          ref.sha256 === image.sha256 &&
          value.images.some(
            (remote) =>
              remote.loaded && imageKey(remote.url) === imageKey(ref.url),
          ),
      ),
    );
  observation = await wait(
    matchesDesired,
    "简书草稿内容尚未完整，请检查原草稿后继续。",
  );
  let verified = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    verified = await verifySaved(
      observation,
      payload.title,
      files.map(
        ({ image }) => refs.find((ref) => ref.sha256 === image.sha256)!.url,
      ),
      payload.html,
    );
    if (verified) break;
    if (attempt === 0 && changed)
      await invoke({ action: "save", ...guard(observation) });
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  if (!verified)
    throw new AppError(
      "JIANSHU_SAVE_UNCERTAIN",
      "标题正文已填写，但官网保存结果尚未核实；原稿地址与上传记录已保留，请检查后继续。",
      true,
    );
  observation = await read();
  if (!matchesDesired(observation))
    throw new AppError(
      "JIANSHU_REMOTE_EDITED",
      "官网内容在核对期间发生修改，已保留当前稿件，请重新检查。",
      true,
    );
  await persist(observation, true);
  return {
    opened: true,
    filled: true,
    editorUrl,
    uploadedImages: files.length,
    totalImages: files.length,
    message: `标题、正文${files.length ? `和 ${files.length} 张配图` : ""}已填写并保存到简书草稿。请在官网预览确认后发布，再回来核对文章链接。`,
  };
}
