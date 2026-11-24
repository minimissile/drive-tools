/** Only this observed official editor is supported; never fall back to arbitrary inputs. */
export function jianshuEditorPage(input: {
  action:
    | "read"
    | "prepareCreate"
    | "create"
    | "write"
    | "image"
    | "upload"
    | "save"
    | "verify";
  title?: string;
  html?: string;
  name?: string;
  mimeType?: string;
  base64?: string;
  expectedEditorUrl?: string;
  expectedNotebookId?: string;
  expectedTitle?: string;
  expectedText?: string;
  expectedImages?: { url: string; name: string }[];
  expectedRemoteImages?: string[];
}) {
  if (
    location.origin !== "https://www.jianshu.com" ||
    location.pathname !== "/writer"
  )
    throw Error("简书编辑器已离开官方写作页面，请检查登录后继续。");
  const visible = (element: Element) =>
    !!(element as HTMLElement).getClientRects().length;
  const loading = () =>
    [...document.querySelectorAll(".ZKQHD")].some(
      (element) =>
        element.textContent?.trim() === "内容加载中" && visible(element),
    );
  const title = document.querySelector<HTMLInputElement>("input._24i7u");
  const body = document.querySelector<HTMLElement>(
    '#editor .kalamu-area[contenteditable="true"]',
  );
  const publish = document.querySelector<HTMLElement>(
    'a[data-action="publicize"]',
  );
  const normalize = (text: string) =>
    text.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/g, "");
  const contentText = (node: Element) => {
    const copy = node.cloneNode(true) as Element;
    copy
      .querySelectorAll(".image-package,figure,figcaption,.image-caption")
      .forEach((item) => item.remove());
    return normalize(copy.textContent ?? "");
  };
  const images = () =>
    body
      ? [...body.querySelectorAll("img")].map((image) => ({
          url:
            image.getAttribute("data-original-src") ||
            image.currentSrc ||
            image.src,
          name: image.getAttribute("alt") ?? "",
          loaded: image.complete && image.naturalWidth > 0,
        }))
      : [];
  if (
    input.action !== "read" &&
    input.expectedEditorUrl &&
    location.href !== input.expectedEditorUrl
  )
    throw Error("简书窗口已切换文章，已停止操作并保留当前内容。");
  if (input.action === "read") {
    const desired = document.createElement("div");
    desired.innerHTML = input.html ?? "";
    return {
      url: location.href,
      ready: !!title && !!body && !!publish && visible(body) && !loading(),
      canCreate:
        /^#\/notebooks\/[1-9]\d*(?:\/notes\/[1-9]\d*)?$/.test(location.hash) &&
        !!document.querySelector("div._1GsW5") &&
        visible(document.querySelector("div._1GsW5")!),
      unpublished: publish?.textContent?.trim() === "发布文章",
      title: title?.value ?? "",
      text: body ? contentText(body) : "",
      expectedText: contentText(desired),
      images: images(),
      saved:
        document.querySelector("p._3-3KB")?.textContent?.trim() === "已保存",
      uploadOpen: !!document.querySelector("input#kalamu-upload-image"),
    };
  }
  if (input.action === "prepareCreate") {
    return (async () => {
      const route = /^#\/notebooks\/([1-9]\d*)(?:\/notes\/([1-9]\d*))?$/.exec(
        location.hash,
      );
      const create = document.querySelector<HTMLElement>("div._1GsW5");
      if (
        !route ||
        !create ||
        !visible(create) ||
        create.textContent?.trim() !== "新建文章"
      )
        return null;
      const editorUrl = location.href;
      const endpoint = new URL(
        `/author/notebooks/${route[1]}/notes`,
        location.origin,
      );
      endpoint.searchParams.set("page", "1");
      endpoint.searchParams.set("count", "10");
      if (route[2]) endpoint.searchParams.set("nid", route[2]);
      const response = await fetch(endpoint.href, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (
        !response.ok ||
        response.url !== endpoint.href ||
        !/application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw Error("简书文集状态未能核实，未点击新建文章，请检查官网后继续。");
      const notes = await response.json();
      if (!Array.isArray(notes))
        throw Error("简书文集返回内容未能识别，未点击新建文章。");
      if (location.href !== editorUrl) return null;
      const existingReady =
        !!route[2] &&
        !!title &&
        !!body &&
        visible(body) &&
        !!publish &&
        !loading() &&
        notes.some(
          (note) =>
            note &&
            typeof note === "object" &&
            String(note.id) === route[2] &&
            String(note.notebook_id) === route[1],
        );
      const emptyNotebook = !route[2] && notes.length === 0 && !loading();
      return existingReady || emptyNotebook
        ? { editorUrl, notebookId: route[1] }
        : null;
    })();
  }
  if (input.action === "create") {
    if (
      input.expectedNotebookId !== undefined &&
      /^#\/notebooks\/([1-9]\d*)(?:\/notes\/[1-9]\d*)?$/.exec(
        location.hash,
      )?.[1] !== input.expectedNotebookId
    )
      throw Error("简书文集已切换，未点击新建文章，请重新检查。");
    const create = document.querySelector<HTMLElement>("div._1GsW5");
    if (
      !create ||
      !visible(create) ||
      create.textContent?.trim() !== "新建文章"
    )
      throw Error("没有找到简书的新建文章入口，请完成官网登录或验证后重试。");
    create.click();
    return true;
  }
  if (!title || !body || !publish || publish.textContent?.trim() !== "发布文章")
    throw Error("当前页面不是可填写的未发布草稿，已停止操作。");
  const assertContent = (expectedTitle = input.expectedTitle) => {
    if (input.expectedEditorUrl && location.href !== input.expectedEditorUrl)
      throw Error("简书窗口已切换文章，已停止操作并保留当前内容。");
    if (
      (expectedTitle !== undefined && title.value !== expectedTitle) ||
      (input.expectedText !== undefined &&
        contentText(body) !== input.expectedText) ||
      (input.expectedImages !== undefined &&
        JSON.stringify(images().map(({ url, name }) => ({ url, name }))) !==
          JSON.stringify(input.expectedImages))
    )
      throw Error("简书草稿在填写期间有修改，已停止操作并保留官网内容。");
  };
  assertContent();
  if (input.action === "verify") {
    return (async () => {
      const match = location.hash.match(
        /^#\/notebooks\/([1-9]\d*)\/notes\/([1-9]\d*)$/,
      );
      if (!match) return false;
      const [contentResponse, notesResponse] = await Promise.all([
        fetch(`/author/notes/${match[2]}/content`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        }),
        fetch(
          `/author/notebooks/${match[1]}/notes?page=1&count=10&nid=${match[2]}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            signal: AbortSignal.timeout(10000),
          },
        ),
      ]);
      if (!contentResponse.ok || !notesResponse.ok) return false;
      const [data, notes] = await Promise.all([
        contentResponse.json(),
        notesResponse.json(),
      ]);
      if (typeof data?.content !== "string" || !Array.isArray(notes))
        return false;
      const note = notes.find((item) => String(item.id) === match[2]);
      if (
        !note ||
        note.shared !== false ||
        note.schedule_publish_at !== null ||
        note.last_compiled_at !== 0 ||
        typeof note.title !== "string" ||
        normalize(note.title) !== normalize(input.title ?? "")
      )
        return false;
      const remote = document.createElement("div");
      remote.innerHTML = data.content;
      if (input.html) {
        const desired = document.createElement("div");
        desired.innerHTML = input.html;
        const linkTarget = (raw: string) => {
          try {
            let url = new URL(raw, location.origin);
            if (
              url.origin === "https://links.jianshu.com" &&
              url.pathname === "/go"
            )
              url = new URL(url.searchParams.get("to") ?? "");
            return ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password
              ? url.href
              : "";
          } catch {
            return "";
          }
        };
        const links = [...remote.querySelectorAll("a[href]")].map((item) =>
          linkTarget(item.getAttribute("href") ?? ""),
        );
        if (
          [...desired.querySelectorAll("a[href]")].some(
            (item) =>
              !links.includes(linkTarget(item.getAttribute("href") ?? "")),
          )
        )
          return false;
      }
      const key = (raw: string) => {
        try {
          const url = new URL(raw);
          return url.protocol === "https:" ? url.origin + url.pathname : "";
        } catch {
          return "";
        }
      };
      const actualImages = [...remote.querySelectorAll("img")].map((item) =>
        key(item.src),
      );
      const expectedImages = (input.expectedRemoteImages ?? []).map(key);
      return (
        location.href === input.expectedEditorUrl &&
        contentText(remote) === input.expectedText &&
        JSON.stringify(actualImages) === JSON.stringify(expectedImages)
      );
    })();
  }
  if (input.action === "write") {
    document
      .querySelector<HTMLElement>('[role="dialog"] [aria-label="Close"]')
      ?.click();
    if (title.value !== input.title) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(title, input.title ?? "");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      title.dispatchEvent(new Event("change", { bubbles: true }));
    }
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return (async () => {
      // Kalamu imports paste into its document model. DOM/InputEvent edits can
      // appear correct while its autosave still contains the previous text.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertContent(input.title ?? "");
      if (!body.isConnected) throw Error("简书编辑器已重新加载，请继续原稿。");
      const transfer = new DataTransfer();
      transfer.setData("text/html", input.html ?? "");
      transfer.setData(
        "text/plain",
        new DOMParser().parseFromString(input.html ?? "", "text/html").body
          .textContent ?? "",
      );
      const paste = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
      body.dispatchEvent(paste);
      if (!paste.defaultPrevented)
        throw Error("简书正文编辑器未接受粘贴，请保留当前草稿后重试。");
      return true;
    })();
  }
  if (input.action === "image") {
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!document.querySelector("input#kalamu-upload-image")) {
      const button = document.querySelector<HTMLElement>(
        'a[data-action="openImageModal"]',
      );
      if (!button)
        throw Error("简书图片上传入口已变化，请保留草稿并联系支持。");
      button.click();
    }
    return true;
  }
  if (input.action === "upload") {
    const fileInput = document.querySelector<HTMLInputElement>(
      "input#kalamu-upload-image[type=file]",
    );
    if (!fileInput || !input.base64 || !input.name || !input.mimeType)
      throw Error("简书图片上传控件尚未就绪。");
    const bytes = Uint8Array.from(atob(input.base64), (character) =>
      character.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], input.name, { type: input.mimeType }));
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  const save = document.querySelector<HTMLElement>(
    'a[data-action="auto-save"]',
  );
  if (!save) throw Error("简书保存入口已变化，请先在官网保存当前草稿。");
  save.click();
  return true;
}
