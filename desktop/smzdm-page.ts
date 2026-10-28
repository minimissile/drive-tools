import type { SmzdmPayload, SmzdmResultQuery } from "../shared/smzdm";

/** Same-origin request in the official session; background fetches may omit SameSite cookies. */
export async function readSmzdmIdentity() {
  if (location.origin !== "https://zhiyou.smzdm.com")
    throw new Error("身份检查页面不正确。");
  const response = await fetch(
    "/user/info/jsonp_get_current?callback=panxuIdentity",
    {
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok)
    throw new Error(`官方身份接口返回 HTTP ${response.status}。`);
  const text = await response.text();
  if (text.length > 256000) throw new Error("身份接口响应超出限制。");
  const json = JSON.parse(
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  );
  const current = json.data && typeof json.data === "object" ? json.data : json;
  const uid = String(current.smzdm_id ?? "");
  return /^[1-9]\d{0,24}$/.test(uid)
    ? {
        uid,
        nickname:
          typeof current.nickname === "string"
            ? current.nickname.slice(0, 100)
            : null,
      }
    : null;
}

export function smzdmNewArticleUrl() {
  const entries = Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a[href]"),
  ).filter(
    (a) => a.getClientRects().length && /发布新文章/.test(a.textContent ?? ""),
  );
  const urls = [...new Set(entries.map((a) => a.href))].filter((raw) => {
    try {
      const u = new URL(raw);
      return (
        u.origin === "https://post.smzdm.com" &&
        /^\/edit\/[a-zA-Z0-9]+\/?$/.test(u.pathname)
      );
    } catch {
      return false;
    }
  });
  if (urls.length !== 1)
    throw new Error("请在官方创作中心确认‘发布新文章’入口，未创建或提交文章。");
  return urls[0];
}

/** Explicit capability detection, not an assumption that setting innerHTML saves an editor. */
export function fillSmzdmEditor(
  payload: SmzdmPayload,
  inspectOnly = false,
  phase: "ready" | "write" | "check" = "check",
) {
  const visible = (el: Element) =>
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  if (
    location.hostname !== "post.smzdm.com" ||
    !/^\/edit\/[a-zA-Z0-9]+\/?$/.test(location.pathname)
  )
    throw new Error("当前页面不是官方文章编辑器，请先完成登录。");
  if (
    Array.from(document.querySelectorAll("iframe")).some(
      (el) => /captcha|geetest/.test(el.src) && visible(el),
    )
  )
    throw new Error("请在官方窗口手动完成安全验证后再操作。");
  const titles = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[name="title"],input[name="article_title"],#article_title,input#title,textarea[placeholder*="标题"],input[placeholder*="标题"]',
    ),
  ).filter(visible);
  const unique = [...new Set(titles)];
  if (unique.length !== 1)
    throw new Error("未唯一识别文章标题框，请在官方窗口检查编辑器状态。");
  const title = unique[0];
  type Editor = {
    setContent(html: string): void;
    getContent(): string;
    fireEvent?(name: string): void;
    isReady?: boolean;
  };
  const scope = window as unknown as {
    UE?: { instants?: Record<string, Editor> };
    tinymce?: {
      editors?: {
        setContent(html: string): void;
        getContent(): string;
        fire?(name: string): void;
        getContainer?(): HTMLElement;
      }[];
    };
    __panxuSmzdmKey?: string;
  };
  const ue = Object.values(scope.UE?.instants ?? {}).filter(
    (e) =>
      e.isReady !== false &&
      typeof e.setContent === "function" &&
      typeof e.getContent === "function",
  );
  const tiny = (scope.tinymce?.editors ?? []).filter(
    (e) => !e.getContainer || visible(e.getContainer()),
  );
  let getHtml: () => string, setHtml: (html: string) => void;
  if (ue.length === 1) {
    getHtml = () => ue[0].getContent();
    setHtml = (html) => {
      ue[0].setContent(html);
      ue[0].fireEvent?.("contentchange");
    };
  } else if (tiny.length === 1) {
    getHtml = () => tiny[0].getContent();
    setHtml = (html) => {
      tiny[0].setContent(html);
      tiny[0].fire?.("change");
      tiny[0].fire?.("input");
    };
  } else {
    // Tiptap exposes its stateful editor on the root DOM node. Read serialized state,
    // not node-view DOM containing captions, progress indicators and controls.
    const editable = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ProseMirror[contenteditable="true"],.tiptap[contenteditable="true"],[data-slate-editor="true"],[data-lexical-editor="true"],[contenteditable="true"][role="textbox"]',
      ),
    ).filter(visible);
    if (editable.length !== 1)
      throw new Error(
        "未识别到可保存内容的官方编辑器，请在窗口中检查；应用没有提交文章。",
      );
    const el = editable[0];
    const editor = (
      el as HTMLElement & {
        editor?: {
          getHTML(): string;
          commands: {
            setContent(
              html: string,
              options?: { emitUpdate: boolean },
            ): boolean;
          };
        };
      }
    ).editor;
    if (
      !editor ||
      typeof editor.getHTML !== "function" ||
      typeof editor.commands?.setContent !== "function"
    )
      throw new Error(
        "当前官方编辑器未提供可靠的替换接口，应用未修改正文。请保留稿件并检查适配。",
      );
    getHtml = () => editor.getHTML();
    setHtml = (html) => {
      // The platform's paste handler imports its custom image nodes. First reset
      // through the editor transaction so the paste replaces, rather than appends.
      if (!editor.commands.setContent("<p></p>", { emitUpdate: false }))
        throw new Error("官方编辑器未接受当前稿件，未重复写入内容。");
      el.focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/html", html);
      clipboardData.setData(
        "text/plain",
        new DOMParser().parseFromString(html, "text/html").body.textContent ??
          "",
      );
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    };
  }
  if (phase === "ready") return true;
  const textOf = (html: string) =>
    new DOMParser()
      .parseFromString(html, "text/html")
      .body.textContent?.replace(/\s+/g, "")
      .trim() ?? "";
  const expected = textOf(payload.html);
  const targets = (html: string) =>
    [
      ...new Set(
        Array.from(
          new DOMParser()
            .parseFromString(html, "text/html")
            .querySelectorAll("a[href]"),
        ).map((a) => {
          const href = a.getAttribute("href") ?? "";
          try {
            return new URL(href, location.href).href;
          } catch {
            return href;
          }
        }),
      ),
    ].sort();
  const imagePositions = (html: string) => {
    const body = new DOMParser().parseFromString(html, "text/html").body;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ALL);
    const positions: number[] = [];
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE)
        offset += (node.textContent ?? "").replace(/\s+/g, "").length;
      else if (node.nodeName === "IMG") positions.push(offset);
    }
    return JSON.stringify(positions);
  };
  const sameLinks = () =>
    JSON.stringify(targets(getHtml())) ===
    JSON.stringify(targets(payload.html));
  const currentHtml = getHtml();
  const currentImages = new DOMParser().parseFromString(
    currentHtml,
    "text/html",
  ).images.length;
  const wantedImages = new DOMParser().parseFromString(
    payload.html,
    "text/html",
  ).images.length;
  const contentMatches =
    title.value === payload.title &&
    textOf(currentHtml) === expected &&
    sameLinks() &&
    currentImages === wantedImages &&
    imagePositions(currentHtml) === imagePositions(payload.html);
  const articleKey = payload.key.slice(0, payload.key.lastIndexOf(":"));
  const previousKey = scope.__panxuSmzdmKey;
  const sameArticle =
    previousKey?.slice(0, previousKey.lastIndexOf(":")) === articleKey ||
    payload.draftUrl === location.href;
  if (
    !inspectOnly &&
    !sameArticle &&
    !contentMatches &&
    (title.value.trim() || textOf(currentHtml) || currentImages)
  )
    throw new Error(
      "官方编辑器已有其他稿件，应用未覆盖内容。请先保存原稿，再在平台新建空白文章后继续。",
    );
  if (!inspectOnly && !contentMatches) {
    const proto =
      title instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(
      title,
      payload.title,
    );
    title.dispatchEvent(new Event("input", { bubbles: true }));
    title.dispatchEvent(new Event("change", { bubbles: true }));
    setHtml(payload.html);
  }
  if (!inspectOnly) scope.__panxuSmzdmKey = payload.key;
  if (phase === "write") return true;
  if (title.value !== payload.title || textOf(getHtml()) !== expected)
    throw new Error(
      "编辑器内容与当前稿件不一致，请等待编辑器加载或重新填写；未提交文章。",
    );
  if (!sameLinks()) {
    const actual = targets(getHtml()),
      wanted = targets(payload.html);
    const extra = actual.filter((url) => !wanted.includes(url));
    const missing = wanted.filter((url) => !actual.includes(url));
    throw new Error(
      "编辑器中的链接目标与当前已审阅稿件不一致，未提交文章。" +
        (missing.length
          ? ` 缺少：${missing
              .slice(0, 2)
              .map((url) => url.slice(0, 150))
              .join("、")}`
          : "") +
        (extra.length
          ? ` 其他目标：${extra
              .slice(0, 2)
              .map((url) => url.slice(0, 150))
              .join("、")}`
          : ""),
    );
  }
  const written = new DOMParser().parseFromString(getHtml(), "text/html");
  const expectedImages = new DOMParser().parseFromString(
    payload.html,
    "text/html",
  ).images.length;
  if (written.images.length !== expectedImages)
    throw new Error("编辑器配图数量与稿件不一致，请核对图片后再发布。");
  if (imagePositions(getHtml()) !== imagePositions(payload.html))
    throw new Error("编辑器配图位置与当前稿件不一致，请重新填写后核对排版。");
  if (
    inspectOnly &&
    Array.from(written.images).some((img) => {
      try {
        return !/(?:^|\.)(?:smzdm\.com|zdmimg\.com)$/.test(
          new URL(img.src).hostname,
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error(
      "配图尚未保存到平台，请在官方编辑器完成图片上传或转存，等待处理后再发布。",
    );
  return true;
}

export function smzdmSubmitControl(click: boolean, aiAssisted = false) {
  const visible = (el: Element) =>
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const coverLabel = Array.from(
    document.querySelectorAll("label,span,div"),
  ).find(
    (el) => visible(el) && el.textContent?.replace(/[\s*＊]/g, "") === "封面图",
  );
  let coverGroup = coverLabel?.parentElement;
  for (
    let i = 0;
    i < 5 && coverGroup && !/长图.*方图/s.test(coverGroup.textContent ?? "");
    i++
  )
    coverGroup = coverGroup.parentElement;
  if (!coverGroup || !/长图.*方图/s.test(coverGroup.textContent ?? ""))
    throw new Error("未能核对官方封面设置，请检查编辑器后重试；未提交文章。");
  const covers = Array.from(coverGroup.querySelectorAll("img")).filter(
    (img) => {
      try {
        const url = new URL(img.src);
        return (
          url.protocol === "https:" &&
          /(?:^|\.)(?:smzdm\.com|zdmimg\.com)$/.test(url.hostname)
        );
      } catch {
        return false;
      }
    },
  );
  if (covers.length < 2)
    throw new Error("请在官方编辑器设置文章长图与方图封面后再发布。");
  if (aiAssisted) {
    const label = Array.from(
      document.querySelectorAll("label,span,div,p"),
    ).find(
      (el) =>
        visible(el) && el.textContent?.trim() === "作者提示含AI生成内容。",
    );
    let group = label?.parentElement;
    for (
      let i = 0;
      i < 3 && group && !group.querySelector('input[type="radio"]');
      i++
    )
      group = group.parentElement;
    const checked = group?.querySelector<HTMLInputElement>(
      'input[type="radio"]:checked',
    );
    if (checked?.closest("label")?.textContent?.trim() !== "是")
      throw new Error(
        "本稿使用过 AI 润色，请在官方创作声明中确认‘含AI生成内容’为‘是’后再发布。",
      );
  }
  const invalid = Array.from(
    document.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input:required,select:required,textarea:required"),
  ).find((el) => visible(el) && !el.checkValidity());
  if (invalid) {
    invalid.focus();
    throw new Error("请在官方编辑器补全分类、封面等必填项目后再发布。");
  }
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button,input[type="submit"],a, [role="button"]',
    ),
  ).filter(
    (el) =>
      visible(el) &&
      /^(发布文章|提交审核|提交文章|发布|提交)$/.test(
        (el.textContent || (el as HTMLInputElement).value || "").trim(),
      ) &&
      !(el as HTMLButtonElement).disabled &&
      el.getAttribute("aria-disabled") !== "true",
  );
  if (buttons.length !== 1)
    throw new Error(
      "没有唯一可用的官方发布按钮，请在编辑器检查分类、封面和提示；应用未提交。",
    );
  if (click) buttons[0].click();
  return true;
}

export function smzdmReceipt() {
  if (
    location.hostname === "post.smzdm.com" &&
    /^\/p\/[a-zA-Z0-9]+\/?$/.test(location.pathname)
  )
    return { url: location.href, status: "submitted" as const };
  const success = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"],.el-dialog,[aria-modal="true"],.success,.submit-success,.publish-success,.success-wrap',
    ),
  ).find(
    (el) =>
      el.getClientRects().length &&
      /提交成功|发布成功|审核中|提交审核成功/.test(el.innerText),
  );
  const anchor = success?.querySelector<HTMLAnchorElement>(
    'a[href^="https://post.smzdm.com/p/"]',
  );
  if (anchor) return { url: anchor.href, status: "submitted" as const };
  // The current editor acknowledges submission in a dialog, without returning a
  // public URL until review. A positive receipt must not become an unknown result.
  const heading = Array.from(
    document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,[role="heading"]'),
  ).find(
    (el) => el.getClientRects().length && el.textContent?.trim() === "提交成功",
  );
  let confirmation = heading?.parentElement;
  for (
    let i = 0;
    i < 3 &&
    confirmation &&
    !/个人中心.*审核状态/s.test(confirmation.textContent ?? "");
    i++
  )
    confirmation = confirmation.parentElement;
  if (
    location.hostname === "post.smzdm.com" &&
    /^\/edit\/[a-zA-Z0-9]+\/?$/.test(location.pathname) &&
    heading &&
    confirmation &&
    /个人中心.*审核状态/s.test(confirmation.textContent ?? "")
  )
    return { url: null, status: "submitted" as const };
  return null;
}

/** Read the bound user's own record; an editor URL or a matching title alone
 * cannot establish publication. The record must identify the same draft ID. */
export function readSmzdmArticleRecord(query: SmzdmResultQuery) {
  if (
    location.origin !== "https://zhiyou.smzdm.com" ||
    !/^\/user\/article\/?$/.test(location.pathname)
  )
    throw new Error("当前页面不是本人文章列表，未改变本地投稿状态。");
  const draft = new URL(query.draftUrl);
  const id = draft.pathname.match(/^\/edit\/([a-zA-Z0-9]+)\/?$/)?.[1];
  if (draft.origin !== "https://post.smzdm.com" || !id)
    throw new Error("官方草稿标识无效，未按标题猜测文章。");
  const articleId = (a: HTMLAnchorElement) => {
    try {
      const url = new URL(a.href);
      return url.origin === "https://post.smzdm.com"
        ? url.pathname.match(/^\/(?:p|edit)\/([a-zA-Z0-9]+)\/?$/)?.[1]
        : undefined;
    } catch {
      return undefined;
    }
  };
  const normalized = (value: string) => value.replace(/\s+/g, "").trim();
  const entries = Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a[href]"),
  ).filter(
    (a) =>
      articleId(a) === id &&
      normalized(a.textContent ?? "") === normalized(query.title),
  );
  for (const entry of entries) {
    let row = entry.parentElement;
    for (
      let depth = 0;
      depth < 6 && row && row !== document.body;
      depth++, row = row.parentElement
    ) {
      const anchors = Array.from(
        row.querySelectorAll<HTMLAnchorElement>("a[href]"),
      );
      const ids = new Set(anchors.map(articleId).filter(Boolean));
      if ([...ids].some((other) => other !== id)) break;
      const states = Array.from(row.querySelectorAll<HTMLElement>("*"))
        .filter((el) => !el.closest("a") && el.getClientRects().length)
        .map((el) => el.textContent?.trim())
        .filter((text) =>
          /^(已发布|审核中|待审核|已提交|提交成功)$/.test(text ?? ""),
        );
      if (!states.length) continue;
      const urls = [
        ...new Set(
          anchors
            .filter(
              (a) =>
                articleId(a) === id && /^\/p\//.test(new URL(a.href).pathname),
            )
            .map((a) => {
              const url = new URL(a.href);
              url.search = "";
              url.hash = "";
              url.pathname = url.pathname.replace(/\/?$/, "/");
              return url.href;
            }),
        ),
      ];
      if (urls.length > 1)
        throw new Error("本人文章记录返回多个地址，请核对平台状态。");
      if (states.includes("已发布"))
        return urls.length === 1
          ? { url: urls[0], status: "published" as const }
          : null;
      return { url: urls[0] ?? null, status: "submitted" as const };
    }
  }
  return null;
}
