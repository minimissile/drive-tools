import type { WechatTiebaImportSource } from "../shared/wechat";
import type { tiebaBaiduMiniAppShare } from "../shared/tieba-article-links";

type TiebaArticleStatus =
  "challenge" | "wrong-page" | "missing" | "not-ready" | "empty" | "too-large";

export type TiebaArticleReading =
  | { status: "read"; source: WechatTiebaImportSource }
  | { status: TiebaArticleStatus };

/** Runs in an isolated world on the official thread page. It returns data only. */
export function readTiebaArticle(
  expectedUrl: string,
  imageHosts: readonly string[],
  readBaiduMiniAppShare: typeof tiebaBaiduMiniAppShare,
): TiebaArticleReading {
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    return (
      !el.matches('[hidden], [aria-hidden="true"]') &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  };
  const rendered = (el: Element) =>
    visible(el) && el.getClientRects().length > 0;
  const current = new URL(location.href);
  if (
    ["wappass.baidu.com", "passport.baidu.com"].includes(current.hostname) ||
    /百度安全验证|百度帐号登录|百度账号登录/.test(document.title) ||
    [
      ...document.querySelectorAll(
        '#captcha, #vcode, .captcha, .verify-dialog, .verify_dialog, iframe[src*="wappass.baidu.com"]',
      ),
    ].some(rendered)
  )
    return { status: "challenge" };

  const expected = new URL(expectedUrl);
  const path = current.pathname.replace(/\/$/, "");
  const page = current.searchParams.get("pn");
  if (
    current.origin !== expected.origin ||
    path !== expected.pathname ||
    (page && page !== "1")
  )
    return { status: "wrong-page" };

  const text = (el?: Element | null) => (el?.textContent ?? "").trim();
  const error = text(
    document.querySelector(".error_notice, .error_text, #error_msg"),
  );
  if (
    /(?:帖子|主题|贴吧).{0,12}(?:不存在|被删除|已删除)|您访问的页面不存在/.test(
      `${document.title} ${error}`,
    )
  )
    return { status: "missing" };

  const floors = [
    ...document.querySelectorAll("#j_p_postlist .l_post, #pb_content .l_post"),
  ]
    .filter(rendered)
    .flatMap((element) => {
      let data: {
        content?: { post_no?: unknown; date?: unknown };
        author?: { user_name?: unknown; name_show?: unknown };
      } | null = null;
      try {
        data = JSON.parse(element.getAttribute("data-field") ?? "null");
      } catch {
        /* The designated floor label can still independently identify 1F. */
      }
      const floor = data?.content?.post_no;
      const first =
        floor === 1 ||
        floor === "1" ||
        (floor == null &&
          [...element.querySelectorAll(".post-tail-wrap .tail-info")].some(
            (item) => /^1\s*楼$/.test(text(item)),
          ));
      return first ? [{ element, data }] : [];
    });
  if (floors.length > 1) return { status: "not-ready" };

  const legacy = floors[0];
  const replies = ".pb-comment-item, .pb-lzl-item, .virtual-list-item";
  const mainRoots = legacy
    ? []
    : [...document.querySelectorAll(".pc-pb-box .pb-content-wrap")].filter(
        (el) =>
          !el.closest(replies) &&
          !el.parentElement?.closest(".pb-content-wrap") &&
          rendered(el),
      );
  if (!legacy && mainRoots.length !== 1) return { status: "not-ready" };
  const root = legacy
    ? legacy.element.querySelector(".d_post_content, .j_d_post_content")
    : mainRoots[0];
  const titleElement = [
    ...document.querySelectorAll(legacy ? ".core_title_txt" : ".pb-title"),
  ].find((el) => !el.closest(replies) && rendered(el));
  const title = (
    titleElement?.getAttribute("title")?.trim() || text(titleElement)
  ).slice(0, 200);
  if (!root || !rendered(root) || !title) return { status: "not-ready" };

  const string = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";
  const element =
    legacy?.element ?? root.closest(".image-text, .pc-pb-box") ?? root;
  const modernMetadata = (selector: string) => {
    const matches = [...element.querySelectorAll(selector)].filter(
      (el) => !root.contains(el) && !el.closest(replies) && rendered(el),
    );
    return matches.length === 1 ? text(matches[0]) : "";
  };
  const author = (
    legacy
      ? text(element.querySelector(".p_author_name, .d_name a")) ||
        string(legacy.data?.author?.name_show) ||
        string(legacy.data?.author?.user_name)
      : modernMetadata(".head-name")
  ).slice(0, 200);
  const publishedAt = (
    legacy
      ? string(legacy.data?.content?.date) ||
        [...element.querySelectorAll(".post-tail-wrap .tail-info")]
          .map(text)
          .find((value) => /^\d{4}-\d{2}-\d{2}(?:\s|$)/.test(value)) ||
        ""
      : modernMetadata(".post-num")
  ).slice(0, 100);

  const normalizeUrl = (raw: string | null) => {
    if (!raw || raw.startsWith("#")) return null;
    try {
      const url = new URL(raw, current);
      return ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.href.length <= 4000
        ? url
        : null;
    } catch {
      return null;
    }
  };
  const markdownUrl = (url: URL) =>
    url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  const label = (value: string) => value.replace(/[\[\]\r\n]/g, "");
  const ignored = `script, style, noscript, template, form, iframe, video, audio, svg, object, embed, .j_lzl_container, .lzl_panel, .j_content_fold, .j_content_hide, ${replies}`;
  const blocks = new Set([
    "p",
    "div",
    "section",
    "blockquote",
    "ol",
    "ul",
    "table",
    "tr",
  ]);
  const allowedImages = new Set(imageHosts);
  const sizeLimit = new Error();
  let visited = 0;
  let characters = 0;
  let imageCount = 0;
  let skippedImages = 0;
  const walk = (node: Node, depth: number): string => {
    if (++visited > 50000 || depth > 60) throw sizeLimit;
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node.textContent ?? "").replace(/\u00a0/g, " ");
      characters += value.length;
      if (characters > 200000) throw sizeLimit;
      return value;
    }
    if (
      !(node instanceof HTMLElement) ||
      node.matches(ignored) ||
      !visible(node)
    )
      return "";
    const tag = node.localName;
    if (tag === "br") return "\n";
    if (tag === "img") {
      const sources = ["data-original", "bpic", "data-src", "src"].map((name) =>
        node.getAttribute(name),
      );
      if (
        node.matches(".BDE_Smiley") ||
        sources.some((value) =>
          /\/(?:face|emotion)(?:\/|[._-])|\/editor\/images\//i.test(
            value ?? "",
          ),
        )
      )
        return "";
      const url = sources
        .map(normalizeUrl)
        .find(
          (url) =>
            url && allowedImages.has(url.hostname) && url.pathname !== "/",
        );
      if (!url) {
        skippedImages++;
        return "";
      }
      url.protocol = "https:";
      url.hash = "";
      if (++imageCount > 500) throw sizeLimit;
      return `\n\n![${label(node.getAttribute("alt") ?? "贴吧配图") || "贴吧配图"}](${markdownUrl(url)})\n\n`;
    }
    const before = imageCount;
    const content = [...node.childNodes]
      .map((child) => walk(child, depth + 1))
      .join("");
    if (!content.trim()) return "";
    if (tag === "a") {
      const href = node.getAttribute("href");
      let url =
        normalizeUrl(href) ?? (href ? readBaiduMiniAppShare(href) : null);
      if (
        url &&
        ["jump.bdimg.com", "jump2.bdimg.com"].includes(url.hostname) &&
        url.pathname === "/safecheck/index"
      ) {
        const target = url.searchParams.get("url");
        url =
          normalizeUrl(
            target && /^https?:\/\//i.test(target) ? target : null,
          ) ?? url;
      }
      if (!url) return content;
      const link = markdownUrl(url);
      if (imageCount > before)
        return url.origin === current.origin
          ? content
          : `${content.trim()}\n\n${link}\n\n`;
      return `[${label(content.trim()) || link}](${link})`;
    }
    if (/^h[1-6]$/.test(tag))
      return `\n\n${"#".repeat(Number(tag[1]))} ${content}\n\n`;
    if (tag === "strong" || tag === "b") return `**${content}**`;
    if (tag === "li") return `\n- ${content}\n`;
    return blocks.has(tag) ? `\n\n${content}\n\n` : content;
  };

  let body: string;
  try {
    body = [...root.childNodes]
      .map((child) => walk(child, 1))
      .join("")
      .replace(/\n[\t ]+(?=\n)/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (error) {
    if (error === sizeLimit) return { status: "too-large" };
    throw error;
  }
  if (!body) return { status: "empty" };
  if (body.length > 200000) return { status: "too-large" };

  const warnings: string[] = [];
  if (skippedImages)
    warnings.push(`${skippedImages} 张配图无法读取，请对照原帖补充。`);
  if (root.querySelector("video, audio, iframe, object, embed"))
    warnings.push("主帖含音视频或嵌入内容，请对照原帖核对。");
  if (
    element.querySelector(
      '.j_content_fold, .j_content_hide, [data-truncated="true"]',
    )
  )
    warnings.push("主帖含折叠或隐藏内容，已导入页面当前可见的部分。");
  return {
    status: "read",
    source: {
      kind: "tieba",
      url: expectedUrl,
      title,
      body,
      author,
      publishedAt,
      imageCount,
      preservesImageOrder: true,
      warnings,
    },
  };
}
