/** Read only the related-search module. This function is serialized into Baidu's page. */
export function inspectBaiduRelated() {
  const verification =
    /百度安全验证|访问验证|请输入验证码/.test(document.title) ||
    ["wappass.baidu.com", "passport.baidu.com"].includes(location.hostname) ||
    !!document.querySelector("#vcode-spin, #verify-bar, .verify-wrap");
  if (verification)
    return { kind: "verification" as const, words: [] as string[] };
  const read = (container: Element) => {
    const words = new Set<string>();
    for (const anchor of container.querySelectorAll<HTMLAnchorElement>(
      "a[href]",
    )) {
      let url: URL;
      try {
        url = new URL(anchor.href, location.href);
      } catch {
        continue;
      }
      if (url.hostname !== "www.baidu.com" || url.pathname !== "/s") continue;
      const query = url.searchParams.get("wd") || url.searchParams.get("word");
      if (!query) continue;
      const word = (anchor.textContent || query).replace(/\s+/g, " ").trim();
      if (word && word.length <= 100) words.add(word);
    }
    return [...words];
  };
  for (const container of document.querySelectorAll(
    '#rs, #rs_new, #rs_new_rs, [class*="rs-container"], [class*="rs_new"]',
  )) {
    const words = read(container);
    if (words.length) return { kind: "ready" as const, words };
  }
  // Current layouts vary their CSS hashes. Anchor the fallback on the exact module heading.
  const headings = document.querySelectorAll("h2,h3,h4,div,span");
  for (const heading of headings) {
    if (heading.textContent?.trim() !== "相关搜索") continue;
    let parent: Element | null = heading.parentElement;
    for (
      let level = 0;
      parent && level < 4;
      level++, parent = parent.parentElement
    ) {
      if (
        ["BODY", "HTML"].includes(parent.tagName) ||
        parent.id === "content_left" ||
        parent.id === "container"
      )
        break;
      const words = read(parent);
      if (words.length && words.length <= 30)
        return { kind: "ready" as const, words };
    }
  }
  return { kind: "missing" as const, words: [] as string[] };
}

/** JSONP uses the same public suggestion service while Chromium retains the browsing session. */
export function readBaiduSuggestions(keyword: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const callback = `panxuSuggest_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const globals = window as unknown as Record<string, unknown>;
    const script = document.createElement("script");
    const cleanup = () => {
      clearTimeout(timer);
      script.remove();
      delete globals[callback];
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("联想词加载超时，请检查百度窗口后继续。"));
    }, 12000);
    globals[callback] = (value: { q?: unknown; s?: unknown }) => {
      cleanup();
      if (
        !value ||
        value.q !== keyword ||
        !Array.isArray(value.s) ||
        value.s.some((word) => typeof word !== "string")
      ) {
        reject(new Error("百度联想词返回结构已变化，未将异常响应当作空结果。"));
        return;
      }
      resolve(value.s as string[]);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("联想词请求失败，请检查百度窗口后继续。"));
    };
    const url = new URL("https://suggestion.baidu.com/su");
    url.searchParams.set("wd", keyword);
    url.searchParams.set("cb", callback);
    url.searchParams.set("ie", "utf-8");
    script.charset = "gbk";
    script.src = url.href;
    document.head.append(script);
  });
}
