const htmlNamespace = "http://www.w3.org/1999/xhtml";
export const wechatModuleClipboardHtmlLimit = 8 * 1024 * 1024;
const ignoredElements = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "datalist",
  "embed",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "input",
  "link",
  "meta",
  "noscript",
  "object",
  "option",
  "portal",
  "script",
  "select",
  "source",
  "style",
  "template",
  "textarea",
  "title",
  "track",
  "video",
]);
const blockElements = new Set([
  "address",
  "article",
  "aside",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "header",
  "main",
  "nav",
  "p",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
]);

function pasteUrl(raw: string | null, image = false) {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && (image || url.protocol !== "http:")) ||
      url.username ||
      url.password ||
      url.port
    )
      return "";
    return url.href.replace(/[()]/g, (char) => (char === "(" ? "%28" : "%29"));
  } catch {
    return "";
  }
}

const block = (text: string) => (text.trim() ? `\n\n${text.trim()}\n\n` : "");

function bold(text: string) {
  return text
    .split("\n")
    .map((line) => {
      const value = line.trim();
      if (!value || value.includes("\u0000") || value.startsWith("!["))
        return line;
      const unmarked = value.replace(/\*\*/g, "");
      return unmarked ? line.replace(value, () => `**${unmarked}**`) : line;
    })
    .join("\n");
}

function orderedIndex(raw: string | null, fallback: number) {
  const value = Number(raw);
  return value >= 1 && value <= 999_999_999 && Number.isInteger(value)
    ? value
    : fallback;
}

/** Clipboard HTML stays inert and is translated to the article's Markdown subset. */
export function wechatModuleMarkdownFromHtml(html: string): {
  body: string;
  skippedImages: number;
} {
  if (!html.trim() || html.length > wechatModuleClipboardHtmlLimit)
    return { body: "", skippedImages: 0 };
  const template = document.createElement("template");
  template.innerHTML = html;
  const codeBlocks: string[] = [];
  let skippedImages = 0;
  let images = 0;
  let visited = 0;

  const children = (node: Node, depth: number, verbatim = false) =>
    Array.from(node.childNodes, (child) =>
      walk(child, depth + 1, verbatim),
    ).join("");

  function walk(
    node: Node,
    depth: number,
    verbatim = false,
    marker = "-",
  ): string {
    if (depth > 96 || ++visited > 50_000) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue ?? "")
        .replace(/\u0000/g, "")
        .replace(/\u00a0/g, " ");
      return verbatim ? text : text.replace(/[ \t\f\r\n]+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as HTMLElement;
    const tag = element.localName;
    if (
      element.namespaceURI !== htmlNamespace ||
      ignoredElements.has(tag) ||
      element.hidden ||
      element.style.display === "none" ||
      element.style.visibility === "hidden"
    )
      return "";
    if (tag === "br") return "\n";
    if (verbatim) return children(element, depth, true);
    if (tag === "hr") return block("---");
    if (tag === "img") {
      const url =
        pasteUrl(element.getAttribute("data-src"), true) ||
        pasteUrl(element.getAttribute("src"), true);
      if (!url) {
        skippedImages++;
        return "";
      }
      images++;
      const alt = (element.getAttribute("alt") ?? "")
        .replace(/[\[\]\r\n\u0000]/g, "")
        .trim();
      return block(`![${alt || "模块配图"}](${url})`);
    }
    if (tag === "pre") {
      const text = children(element, depth, true).replace(/\r\n?/g, "\n");
      if (!text.trim()) return "";
      const code = text.replace(/^```/gm, " ```").replace(/\n$/, "");
      return block(
        `\u0000${codeBlocks.push(`\`\`\`\n${code}\n\`\`\``) - 1}\u0000`,
      );
    }
    if (tag === "ol" || tag === "ul") {
      let index = orderedIndex(element.getAttribute("start"), 1);
      const lines = Array.from(element.childNodes, (child) => {
        if (
          tag !== "ol" ||
          child.nodeType !== Node.ELEMENT_NODE ||
          (child as Element).localName !== "li"
        )
          return walk(child, depth + 1);
        index = orderedIndex((child as Element).getAttribute("value"), index);
        return walk(child, depth + 1, false, `${index++}.`);
      });
      return block(lines.join(""));
    }
    const imagesBefore = images;
    const content = children(element, depth);
    if (!content.trim()) return "";
    if (tag === "a") {
      const url = pasteUrl(element.getAttribute("href"));
      if (!url) return content;
      if (images > imagesBefore) return `${content}${block(url)}`;
      const label = content
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[\[\]]/g, "");
      if (!label) return content;
      const emphasizedLabel = /^\*\*([^*]+)\*\*$/.exec(label)?.[1];
      const link = emphasizedLabel
        ? `**[${emphasizedLabel}](${url})**`
        : `[${label.replace(/\*\*/g, "")}](${url})`;
      return `${/^[ \t]/.test(content) ? " " : ""}${link}${/[ \t]$/.test(content) ? " " : ""}`;
    }
    if (/^h[1-6]$/.test(tag))
      return block(
        `${"#".repeat(Number(tag[1]))} ${content.trim().replace(/\s+/g, " ")}`,
      );
    if (tag === "blockquote")
      return block(
        content
          .trim()
          .split(/\n+/)
          .map((line) => `> ${line.trim()}`)
          .join("\n"),
      );
    if (tag === "li") {
      const lines = content
        .trim()
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const nested = lines.findIndex((line) =>
        /^(?:[-+*]|\d+[.)])\s/.test(line),
      );
      const label = (nested < 0 ? lines : lines.slice(0, nested)).join(" ");
      return `${label ? `${marker} ${label}\n` : ""}${nested < 0 ? "" : `${lines.slice(nested).join("\n")}\n`}`;
    }
    if (tag === "tr")
      return `\n${content
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\s*\|\s*$/, "")}\n`;
    if (tag === "td" || tag === "th") return `${content.trim()} | `;
    if (tag === "code")
      return /[`\n]/.test(content.trim()) ? content : `\`${content.trim()}\``;
    const weight = element.style.fontWeight;
    const formatted =
      tag === "b" ||
      tag === "strong" ||
      weight === "bold" ||
      weight === "bolder" ||
      Number(weight) >= 600
        ? bold(content)
        : content;
    return blockElements.has(tag) ? block(formatted) : formatted;
  }

  const body = children(template.content, 0)
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(
      /\u0000(\d+)\u0000/g,
      (_, index: string) => codeBlocks[Number(index)] ?? "",
    );
  return { body, skippedImages };
}
