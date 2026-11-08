import type {
  BilibiliEditorPayload,
  BilibiliPreparation,
} from "../../shared/bilibili";

/** Runs only inside the account's visible official editor. No submit/save button is clicked. */
export async function bilibiliFillPage(
  input: Pick<BilibiliEditorPayload, "kind" | "title" | "text" | "tags"> & {
    automaticVideoTitle?: string;
  },
) {
  const target =
    input.kind === "video"
      ? "https://member.bilibili.com/platform/upload/video/frame"
      : input.kind === "article"
        ? "https://member.bilibili.com/york/read-editor"
        : "https://t.bilibili.com/";
  const expected = new URL(target),
    current = new URL(location.href);
  if (
    expected.origin !== current.origin ||
    expected.pathname.replace(/\/$/, "") !== current.pathname.replace(/\/$/, "")
  )
    return { fields: [], missing: ["当前页面不是该类型的官网编辑器"] };
  const visible = (element: Element) =>
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  const fields: string[] = [],
    missing: string[] = [];
  const editable = (element: Element) =>
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable);
  const unique = (elements: Element[]) => {
    const matches = [...new Set(elements)].filter(
      (element) =>
        visible(element) &&
        editable(element) &&
        !element.closest(".ql-clipboard"),
    );
    return matches.length === 1 ? (matches[0] as HTMLElement) : null;
  };
  const byPlaceholder = (pattern: RegExp) =>
    unique(
      Array.from(
        document.querySelectorAll("input,textarea,[contenteditable=true]"),
      ).filter((element) =>
        pattern.test(
          `${element.getAttribute("placeholder") ?? ""} ${element.getAttribute("data-placeholder") ?? ""} ${element.getAttribute("aria-label") ?? ""}`,
        ),
      ),
    );
  const value = (element: HTMLElement) =>
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
      ? element.value
      : element.innerText;
  const fill = (
    name: string,
    element: HTMLElement | null,
    text: string,
    replaceAutomatic?: string,
  ) => {
    if (!text) return;
    if (
      !element ||
      (value(element).trim() &&
        value(element).trim() !== text.trim() &&
        value(element).trim() !== replaceAutomatic)
    ) {
      missing.push(name);
      return;
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(
        element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype,
        "value",
      );
      descriptor?.set?.call(element, text);
    } else element.innerText = text;
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }),
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
    if (
      value(element).replace(/\r\n/g, "\n").trim() ===
      text.replace(/\r\n/g, "\n").trim()
    )
      fields.push(name);
    else missing.push(name);
  };
  if (input.kind !== "dynamic")
    fill(
      "标题",
      byPlaceholder(/标题/),
      input.title,
      input.kind === "video" &&
        /^[a-f0-9]{64}$/.test(input.automaticVideoTitle ?? "")
        ? input.automaticVideoTitle
        : undefined,
    );
  const body =
    input.kind === "video"
      ? (unique(
          Array.from(
            document.querySelectorAll(
              '.ql-editor[contenteditable=true][data-placeholder="填写更全面的相关信息，让更多的人能找到你的视频吧"]',
            ),
          ),
        ) ?? byPlaceholder(/简介|视频描述|介绍一下/))
      : input.kind === "dynamic"
        ? (byPlaceholder(/有什么|分享|动态|想说|内容/) ??
          unique(
            Array.from(
              document.querySelectorAll(
                ".bili-rich-textarea__browser[contenteditable=true],.bili-dyn-publishing__editor [contenteditable=true]",
              ),
            ),
          ))
        : (unique(
            Array.from(
              document.querySelectorAll(
                ".tiptap[contenteditable=true],.ProseMirror[contenteditable=true],.ql-editor[contenteditable=true],[contenteditable=true][data-placeholder*='正文']",
              ),
            ),
          ) ?? byPlaceholder(/正文|开始创作|文章内容/));
  const text =
    input.kind === "dynamic"
      ? `${input.title}\n\n${input.text}`.trim()
      : input.text;
  fill(input.kind === "video" ? "简介" : "正文", body, text);
  if (input.tags.length) {
    const tagInput = unique(
      Array.from(
        document.querySelectorAll('input[placeholder="按回车键Enter创建标签"]'),
      ),
    );
    const wrapper = tagInput?.closest(".tag-input-wrp");
    if (
      !(tagInput instanceof HTMLInputElement) ||
      tagInput.closest("form") ||
      tagInput.disabled ||
      !wrapper
    )
      missing.push("标签");
    else {
      const selectedTags = () =>
        Array.from(
          wrapper.querySelectorAll(".tag-pre-wrp .label-item-v2-content"),
        )
          .filter(visible)
          .map((element) => (element.textContent ?? "").trim())
          .filter(Boolean);
      let complete = true;
      for (const tag of input.tags) {
        const currentTags = selectedTags();
        if (currentTags.includes(tag)) continue;
        if (
          currentTags.length >= 10 ||
          !tagInput.isConnected ||
          (tagInput.value.trim() && tagInput.value.trim() !== tag) ||
          location.origin !== expected.origin ||
          location.pathname.replace(/\/$/, "") !==
            expected.pathname.replace(/\/$/, "")
        ) {
          complete = false;
          break;
        }
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(tagInput, tag);
        tagInput.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: tag,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        const event = {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        };
        tagInput.dispatchEvent(new KeyboardEvent("keydown", event));
        tagInput.dispatchEvent(new KeyboardEvent("keyup", event));
        const until = Date.now() + 1500;
        while (
          tagInput.isConnected &&
          Date.now() < until &&
          !(selectedTags().includes(tag) && !tagInput.value.trim())
        )
          await new Promise((resolve) => setTimeout(resolve, 50));
        if (!selectedTags().includes(tag) || tagInput.value.trim()) {
          complete = false;
          break;
        }
      }
      if (complete) fields.push("标签");
      else missing.push("标签");
    }
  }
  return { fields, missing };
}

/** Visible official status only. A selected file or mounted form is never upload completion. */
export function bilibiliVideoUploadPage(): {
  state:
    | "verification"
    | "failed"
    | "uploading"
    | "processing"
    | "completed"
    | "unknown";
  message: string;
} {
  if (
    location.origin !== "https://member.bilibili.com" ||
    location.pathname.replace(/\/$/, "") !== "/platform/upload/video/frame"
  )
    return {
      state: "unknown",
      message: "当前页面不是视频编辑器，上传状态待核对。",
    };
  const visible = (element: Element) =>
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  const statusText = (selector: string) =>
    Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .map((element) => element.textContent ?? "")
      .join("\n");
  const failures = statusText(
    ".task-status-fail .text,.file-item-content-status-text-fail .fail",
  );
  const text = statusText(".task-status .text,.file-item-content-status-text");
  if (/验证码已关闭|请完成[^\n]{0,20}(?:验证|验证码)/.test(failures))
    return {
      state: "verification",
      message:
        "官网要求人工验证，视频上传尚未完成。请在原窗口完成验证并核对上传结果；未自动重试。",
    };
  if (/上传失败|预上传失败|视频上传出错/.test(failures))
    return {
      state: "failed",
      message:
        "官网显示视频上传失败，请在原窗口核对错误或人工验证；未自动重新上传。",
    };
  if (/上传中|正在上传/.test(text))
    return {
      state: "uploading",
      message: "视频仍在上传，请在官网等待并核对完成状态。",
    };
  if (/转码中|正在转码/.test(text))
    return {
      state: "processing",
      message: "官网仍在处理视频，请在原窗口核对处理结果。",
    };
  if (
    text
      .split(/\r?\n/)
      .some((line) => /^(?:上传完成|上传成功)$/.test(line.trim()))
  )
    return {
      state: "completed",
      message: "官网显示上传完成，发布前仍需核对稿件设置。",
    };
  return {
    state: "unknown",
    message: "视频文件选择不代表上传完成，请在官网核对上传或验证状态。",
  };
}

/** Reopening retains the user's official-window edits; it never claims they were revalidated. */
export function bilibiliReopenedPreparation(
  editorUrl: string,
  uploadMessage = "",
): Omit<BilibiliPreparation, "preparedAt"> {
  return {
    status: "partial",
    editorUrl,
    filledFields: [],
    mediaSelected: false,
    imageSelected: false,
    message: `已重新显示原官网窗口并保留手工编辑。本次未重新核对字段或素材，也未重新选择文件。${uploadMessage}请在原窗口核对；尚未提交发布。`,
  };
}
