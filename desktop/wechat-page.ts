/** Executed only inside the signed-in official WeChat backend. */
export function readWechatIdentity() {
  if (location.origin !== "https://mp.weixin.qq.com") return null;
  const wx = (
    window as unknown as {
      wx?: {
        data?: Record<string, unknown>;
        cgiData?: Record<string, unknown>;
      };
    }
  ).wx;
  const candidates = [wx?.data?.user_name, wx?.cgiData?.user_name];
  // The settings page exposes the account's original ID. A login token or a
  // nickname is never an account identity.
  for (const row of document.querySelectorAll(
    ".account_setting_item, .weui-desktop-form__control-group",
  )) {
    if (/原始\s*ID/i.test(row.textContent ?? ""))
      candidates.push(row.textContent?.match(/\bgh_[a-z0-9]{5,40}\b/i)?.[0]);
  }
  const ids = [
    ...new Set(
      candidates.filter(
        (v): v is string =>
          typeof v === "string" && /^gh_[a-z0-9]{5,40}$/i.test(v),
      ),
    ),
  ];
  const token =
    new URL(location.href).searchParams.get("token") ||
    String(wx?.data?.token ?? wx?.data?.t ?? "");
  if (ids.length !== 1 || !/^\d{1,24}$/.test(token)) return null;
  const nickname = String(
    wx?.data?.nick_name ??
      wx?.cgiData?.nick_name ??
      document.querySelector(
        ".weui-desktop-account__nickname, .account_nickname",
      )?.textContent ??
      "",
  )
    .trim()
    .slice(0, 100);
  return { uid: ids[0], nickname, token };
}

/** A same-origin exchange keeps session cookies inside Chromium. */
export async function wechatExchange(input: {
  path: string;
  token: string;
  fields?: Record<string, string>;
  file?: { name: string; type: string; base64: string };
}) {
  if (
    location.origin !== "https://mp.weixin.qq.com" ||
    !/^\d{1,24}$/.test(input.token)
  )
    throw Error("请在公众号官方后台完成登录后重试。");
  if (
    !["/cgi-bin/filetransfer", "/cgi-bin/operate_appmsg"].includes(input.path)
  )
    throw Error("不支持此公众号操作。");
  const url = new URL(input.path, location.origin);
  url.search = new URLSearchParams({
    token: input.token,
    lang: "zh_CN",
    f: "json",
    ...(input.file
      ? {
          action: "upload_material",
          scene: "8",
          writetype: "doublewrite",
          groupid: "1",
          ajax: "1",
        }
      : {
          sub: input.fields?.appmsgid ? "update" : "create",
          type: "77",
          t: "ajax-response",
        }),
  }).toString();
  let body: FormData | URLSearchParams;
  if (input.file) {
    const raw = atob(input.file.base64),
      bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    body = new FormData();
    body.append("type", "2");
    body.append("id", "WU_FILE_0");
    body.append("name", input.file.name);
    body.append("lastModifiedDate", new Date().toUTCString());
    body.append("size", String(bytes.byteLength));
    body.append(
      "file",
      new Blob([bytes], { type: input.file.type }),
      input.file.name,
    );
  } else
    body = new URLSearchParams({
      ...input.fields,
      token: input.token,
      lang: "zh_CN",
      f: "json",
      ajax: "1",
    });
  const response = await fetch(url, {
    method: "POST",
    body,
    credentials: "include",
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw Error(`公众号接口返回 HTTP ${response.status}，请到官方后台核对。`);
  const text = await response.text();
  if (text.length > 2_000_000)
    throw Error("公众号响应过大，请到官方后台核对。");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw Error("公众号返回了登录或验证页面，请到官方后台核对。");
  }
  return json;
}

/** Refuse updates if the user has turned the remote draft into a multi-article draft. */
export function assertWechatSingleDraft() {
  const global = window as unknown as {
    appmsgData?: {
      item?: unknown[];
      items?: unknown[];
      multi_item?: unknown[];
    };
    wx?: {
      cgiData?: {
        appmsg_data?: { item?: unknown[]; multi_item?: unknown[] };
        appmsg_info?: { item?: unknown[]; multi_item?: unknown[] };
      };
    };
  };
  const lists = [
    global.appmsgData?.item,
    global.appmsgData?.items,
    global.appmsgData?.multi_item,
    global.wx?.cgiData?.appmsg_data?.item,
    global.wx?.cgiData?.appmsg_data?.multi_item,
    global.wx?.cgiData?.appmsg_info?.item,
    global.wx?.cgiData?.appmsg_info?.multi_item,
  ];
  const counts = lists.filter(Array.isArray).map((list) => list.length);
  // appmsg_edit_item also marks title/author/body form fields in the current
  // editor. Only the article navigation list proves the number of articles.
  const domCount = document.querySelectorAll(
    ".appmsg_item_wrp .appmsg_item",
  ).length;
  if (domCount || !counts.length) counts.push(domCount);
  if (counts.some((count) => count !== 1))
    throw Error(
      "未能确认微信草稿仍为单篇文章，请在微信后台核对；本地稿件已保留，未覆盖远端草稿。",
    );
}

/** Confirmation reads the saved editor again; an HTTP success alone cannot prove content. */
export function assertWechatDraftContent(expected: {
  title: string;
  html: string;
  coverUrl: string;
}) {
  if (
    location.origin !== "https://mp.weixin.qq.com" ||
    !new URL(location.href).searchParams.get("appmsgid")
  )
    throw Error("未打开保存后的微信草稿。");
  let title = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    "#title, input[name=title], textarea[name=title]",
  )?.value;
  const globals = window as unknown as {
    appmsgData?: unknown;
    wx?: { cgiData?: { appmsg_data?: unknown; appmsg_info?: unknown } };
  };
  const metadata = [
    globals.appmsgData,
    globals.wx?.cgiData?.appmsg_data,
    globals.wx?.cgiData?.appmsg_info,
  ];
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const ue = (
    window as unknown as {
      UE?: {
        instances?: Record<
          string,
          { getContent?(): string; isReady?: boolean }
        >;
      };
    }
  ).UE;
  let html = Object.values(ue?.instances ?? {})
    .find(
      (editor) =>
        editor.isReady !== false && typeof editor.getContent === "function",
    )
    ?.getContent?.();
  if (!html) {
    const frame = document.querySelector<HTMLIFrameElement>(
      "#edui1_iframeholder iframe, iframe[id^=ueditor]",
    );
    html = frame?.contentDocument?.body.innerHTML;
  }
  // The current editor exposes persisted server data instead of a global UE
  // instance. Read only the single article bound to this saved draft ID; the
  // general preview iframe is not an editor and must never be used as proof.
  if (!html) {
    const draftId = new URL(location.href).searchParams.get("appmsgid");
    for (const parent of metadata) {
      if (
        !record(parent) ||
        String(parent.app_id ?? "") !== draftId ||
        !Array.isArray(parent.multi_item) ||
        parent.multi_item.length !== 1
      )
        continue;
      const item = parent.multi_item[0];
      if (!record(item) || typeof item.content !== "string") continue;
      title = typeof item.title === "string" ? item.title : undefined;
      html = item.content;
      break;
    }
  }
  if (!html || title !== expected.title)
    throw Error("尚未读取到与本地标题一致的微信草稿。");
  const normalizeCover = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !["mmbiz.qpic.cn", "mmbiz.qlogo.cn"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        return null;
      url.protocol = "https:";
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  };
  const covers = new Set<string>();
  let invalidCover = false;
  const addCover = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const url = normalizeCover(value);
    if (url) covers.add(url);
    else invalidCover = true;
  };
  for (const parent of metadata) {
    if (!record(parent)) continue;
    const items = [parent.item, parent.items, parent.multi_item].filter(
      Array.isArray,
    );
    if (items.some((list) => list.length !== 1)) invalidCover = true;
    const containers = [parent, ...items.map((list) => list[0]).filter(record)];
    for (const item of containers)
      for (const key of ["cdn_url", "cover_url", "thumb_url"])
        addCover(item[key]);
  }
  for (const input of document.querySelectorAll<HTMLInputElement>(
    "#cdn_url, input[name=cdn_url], input[name=cdn_url0]",
  ))
    addCover(input.value);
  for (const image of document.querySelectorAll<HTMLImageElement>(
    ".js_cover_preview img, #js_cover img, img.js_cover",
  ))
    addCover(image.getAttribute("data-src") || image.getAttribute("src"));
  for (const node of document.querySelectorAll(
    "#js_cover, .js_cover, .js_cover_preview",
  )) {
    const background = getComputedStyle(node).backgroundImage;
    for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g))
      addCover(match[1]);
  }
  const expectedCover = normalizeCover(expected.coverUrl);
  if (
    !expectedCover ||
    invalidCover ||
    covers.size !== 1 ||
    !covers.has(expectedCover)
  )
    throw Error("未能核实微信草稿封面与本地设置一致。");
  const parser = new DOMParser(),
    actual = parser.parseFromString(html, "text/html"),
    target = parser.parseFromString(expected.html, "text/html");
  const clean = (value: string | null) =>
    (value ?? "").replace(/[\s\u200b\ufeff]+/g, "");
  const actualText = clean(actual.body.textContent),
    targetText = clean(target.body.textContent);
  const imageUrls = (doc: Document) =>
    Array.from(doc.querySelectorAll("img")).map((image) => {
      const url = new URL(
        image.getAttribute("data-src") || image.getAttribute("src") || "",
        location.href,
      );
      url.protocol = "https:";
      return url.href;
    });
  const actualLinks = new Set(
    Array.from(actual.querySelectorAll("a[href]"), (link) =>
      link.getAttribute("href"),
    ),
  );
  const expectedLinks = new Set(
    Array.from(target.querySelectorAll("a[href]"), (link) =>
      link.getAttribute("href"),
    ),
  );
  const modifiedLink = [...actualLinks].some(
    (href) => !expectedLinks.has(href),
  );
  const missingLink = Array.from(target.querySelectorAll("a[href]")).some(
    (link) => {
      const href = link.getAttribute("href");
      return (
        href && !actualLinks.has(href) && !actualText.includes(clean(href))
      );
    },
  );
  if (
    actualText !== targetText ||
    modifiedLink ||
    missingLink ||
    JSON.stringify(imageUrls(actual)) !== JSON.stringify(imageUrls(target))
  )
    throw Error("微信草稿回读的正文、链接或插图与本地稿件不一致。");
}
