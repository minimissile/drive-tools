import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { parseShare } from "../links";
import type {
  JianshuSourceMaterial,
  JianshuSourceProvider,
} from "../../shared/jianshu-sources";
import { parseJianshuSourceReference } from "../../shared/jianshu-sources";
import { sourceUrl } from "./sources-network";

export function decodeSourceText(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, raw: string) => {
      const n =
        raw[0].toLowerCase() === "x" ? parseInt(raw.slice(1), 16) : Number(raw);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
        ? String.fromCodePoint(n)
        : "";
    })
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo);/gi,
      (_, name: string) =>
        ({
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
          mdash: "—",
          ndash: "–",
          hellip: "…",
          lsquo: "‘",
          rsquo: "’",
          ldquo: "“",
          rdquo: "”",
        })[name.toLowerCase() as "amp"] ?? "",
    );
}
export function sourcePlainText(raw: string) {
  return decodeSourceText(raw)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|iframe|form|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(
      /<\/?(?:p|div|br|li|section|article|main|h[1-6]|blockquote|tr)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim();
}
function attributes(raw: string) {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(
    /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  ))
    attrs[m[1].toLowerCase()] = decodeSourceText(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}
function publicReference(
  raw: string,
  base: string,
  allowHttpAttribution = false,
): string | null {
  if (!raw.trim() || raw.trim().startsWith("#")) return null;
  try {
    const reference = new URL(decodeSourceText(raw).trim(), base);
    if (allowHttpAttribution && reference.protocol === "http:") {
      // Legacy feed permalinks are attribution only, never fetched here. Keep
      // the publisher's original URL, while applying the same host/credential
      // restrictions as HTTPS requests. Actual source requests remain HTTPS.
      return parseJianshuSourceReference(reference.href);
    }
    return sourceUrl(reference.href).href;
  } catch {
    return null;
  }
}
function imageReferences(html: string, base: string) {
  const images: JianshuSourceMaterial["images"] = [];
  for (const tag of html.matchAll(
    /<(?:img|enclosure|media:content|media:thumbnail)\b([^>]*)>/gi,
  )) {
    const attr = attributes(tag[1]);
    if (attr.type && !attr.type.startsWith("image/")) continue;
    const url = publicReference(
      attr.src || attr["data-src"] || attr.url || "",
      base,
    );
    if (url && !images.some((i) => i.url === url))
      images.push({ url, alt: sourcePlainText(attr.alt || "").slice(0, 200) });
    if (images.length >= 12) break;
  }
  return images;
}
function externalShares(html: string, base: string) {
  const text = decodeSourceText(html),
    urls = [
      ...[...text.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
      ...(sourcePlainText(text).match(/https:\/\/[^\s<>"'，。；）)]+/gi) ?? []),
    ];
  const found: JianshuSourceMaterial["externalShares"] = [];
  for (const candidate of urls) {
    const url = publicReference(candidate, base);
    if (!url) continue;
    try {
      const share = parseShare(url);
      if (!found.some((s) => s.url === share.url))
        found.push({ url: share.url, code: share.code });
    } catch {
      /* A source link is not necessarily a cloud-drive share. */
    }
    if (found.length >= 30) break;
  }
  return found;
}
type MaterialMetadata = {
  provider: JianshuSourceProvider;
  title: string;
  url: string;
  sourceName: string;
  author?: string;
  publishedAt?: string | null;
  collectedAt: string;
  warnings?: string[];
};
type HtmlMaterial = MaterialMetadata & {
  html: string;
  images?: JianshuSourceMaterial["images"];
};
type TextMaterial = MaterialMetadata & {
  body: string;
  images: JianshuSourceMaterial["images"];
  externalShares: JianshuSourceMaterial["externalShares"];
};

export function sourceMaterial(input: HtmlMaterial): JianshuSourceMaterial {
  return sourceMaterialFromText({
    ...input,
    title: sourcePlainText(input.title),
    author: sourcePlainText(input.author ?? ""),
    body: sourcePlainText(input.html),
    images:
      input.images ?? imageReferences(decodeSourceText(input.html), input.url),
    externalShares: externalShares(input.html, input.url),
  });
}

export function sourceMaterialFromText(
  input: TextMaterial,
): JianshuSourceMaterial {
  const body = input.body.slice(0, 30000),
    title = input.title.slice(0, 300);
  const date = input.publishedAt ? Date.parse(input.publishedAt) : NaN;
  const warnings = [...(input.warnings ?? [])];
  if (input.body.length > body.length)
    warnings.push(
      "正文超过30000字符，本次保存前30000字符，请到原页核对完整内容。",
    );
  return {
    id: `jsource_${createHash("sha256").update(`${input.provider}\0${input.url}`).digest("hex").slice(0, 32)}`,
    provider: input.provider,
    title,
    body,
    summary: body.replace(/\s+/g, " ").slice(0, 400),
    url: input.url,
    sourceName: input.sourceName.slice(0, 200),
    author: (input.author ?? "").slice(0, 200),
    publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
    collectedAt: input.collectedAt,
    images: input.images,
    externalShares: input.externalShares,
    warnings,
  };
}

type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  inner: string;
  contentStart: number;
};
function xmlTree(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new AppError(
      "JIANSHU_FEED_ENTITY",
      "订阅源含有不支持的外部实体声明，请使用普通 RSS/Atom 源。",
    );
  const root: XmlNode = {
    name: "document",
    attrs: {},
    children: [],
    inner: xml,
    contentStart: 0,
  };
  const stack = [root];
  for (const token of xml.matchAll(
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[\w:-]+\b[^>]*>/g,
  )) {
    const raw = token[0];
    if (/^<[!?]/.test(raw)) continue;
    const name = raw.match(/^<\/?([\w:-]+)/)![1].toLowerCase();
    if (raw.startsWith("</")) {
      if (stack.length === 1 || stack.at(-1)!.name !== name)
        throw new AppError(
          "JIANSHU_FEED_XML",
          "订阅源 XML 结构不完整，未将其当作空列表。",
        );
      const node = stack.pop()!;
      node.inner = xml.slice(node.contentStart, token.index);
    } else {
      const node: XmlNode = {
        name,
        attrs: attributes(raw),
        children: [],
        inner: "",
        contentStart: token.index + raw.length,
      };
      stack.at(-1)!.children.push(node);
      if (!/\/\s*>$/.test(raw)) stack.push(node);
      if (stack.length > 60)
        throw new AppError(
          "JIANSHU_FEED_DEPTH",
          "订阅源层级过深，已停止解析。",
        );
    }
  }
  if (stack.length !== 1)
    throw new AppError(
      "JIANSHU_FEED_XML",
      "订阅源 XML 未完整结束，请稍后重新采集。",
    );
  return root;
}
const localName = (name: string) => name.split(":").at(-1)!;
const child = (node: XmlNode, name: string) =>
  node.children.find((n) => localName(n.name) === name);
const value = (node: XmlNode, name: string) => child(node, name)?.inner ?? "";
const feedWarning =
  "订阅内容用于选题和有出处的整理；公开可读不代表获得全文或图片转载许可。";
export function parseSourceFeed(
  xml: string,
  url: string,
  at: string,
  limit = 20,
) {
  const tree = xmlTree(xml),
    root = tree.children[0];
  const channel =
    root &&
    (localName(root.name) === "rss"
      ? child(root, "channel")
      : localName(root.name) === "feed"
        ? root
        : null);
  if (!channel)
    throw new AppError(
      "JIANSHU_FEED_FORMAT",
      "此地址未返回可识别的 RSS/Atom，请检查订阅网址。",
    );
  const sourceName =
    sourcePlainText(value(channel, "title")) || new URL(url).hostname;
  const entries = channel.children.filter((n) =>
    ["item", "entry"].includes(localName(n.name)),
  );
  const items: JianshuSourceMaterial[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (items.length >= limit) break;
    const link = entry.children.find(
      (n) =>
        localName(n.name) === "link" &&
        (!n.attrs.rel || n.attrs.rel === "alternate"),
    );
    const target = publicReference(
      link?.attrs.href || link?.inner || value(entry, "guid"),
      url,
      true,
    );
    const title = sourcePlainText(value(entry, "title"));
    const content =
      value(entry, "encoded") ||
      value(entry, "content") ||
      value(entry, "description") ||
      value(entry, "summary");
    if (!target || !title || !sourcePlainText(content)) {
      skipped++;
      continue;
    }
    const author = child(entry, "author");
    const material = sourceMaterial({
      provider: "rss",
      title,
      html: content,
      url: target,
      sourceName,
      author: author
        ? value(author, "name") || author.inner
        : value(entry, "creator"),
      publishedAt:
        value(entry, "published") ||
        value(entry, "pubdate") ||
        value(entry, "updated"),
      collectedAt: at,
      warnings: [feedWarning],
    });
    // Feed image enclosures can sit outside the content block.
    material.images = [
      ...new Map(
        [...material.images, ...imageReferences(entry.inner, target)].map(
          (i) => [i.url, i],
        ),
      ).values(),
    ].slice(0, 12);
    items.push(material);
  }
  const unique = [...new Map(items.map((item) => [item.url, item])).values()];
  if (entries.length && !unique.length)
    throw new AppError(
      "JIANSHU_FEED_ITEMS",
      "订阅条目缺少标题、公开链接或正文，无法生成文章；原采集记录会保留。",
    );
  return {
    items: unique,
    sourceName,
    truncated: entries.length > limit,
    warnings: [
      feedWarning,
      ...(skipped ? [`跳过${skipped}条缺少必要字段的订阅记录。`] : []),
    ],
  };
}

function meta(html: string, key: string) {
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributes(m[1]);
    if (
      [attrs.property, attrs.name].some(
        (n) => n?.toLowerCase() === key.toLowerCase(),
      )
    )
      return attrs.content || "";
  }
  return "";
}
function articlePart(html: string) {
  return (
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1] ||
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1] ||
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ||
    html
  );
}
export function parseSourceWeb(html: string, url: string, at: string) {
  const title = sourcePlainText(
    meta(html, "og:title") ||
      html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
      html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
      "",
  );
  if (
    /验证码|安全验证|访问验证|Access Denied|Just a moment|Sign in|登录验证/i.test(
      title,
    )
  )
    throw new AppError(
      "JIANSHU_SOURCE_VERIFICATION",
      "来源要求登录或安全验证，请先在原网站查看，采集未完成。",
    );
  const body = articlePart(html),
    text = sourcePlainText(body);
  if (!title || text.length < 40)
    throw new AppError(
      "JIANSHU_SOURCE_BODY",
      "未找到足够的文章正文，可能需要登录或页面依赖动态加载；可保留网址后手动补充内容。",
    );
  const sourceName =
    sourcePlainText(meta(html, "og:site_name")) || new URL(url).hostname;
  const item = sourceMaterial({
    provider: "web",
    title,
    html: body,
    url,
    sourceName,
    author: meta(html, "author") || meta(html, "article:author"),
    publishedAt:
      meta(html, "article:published_time") ||
      attributes(html.match(/<time\b([^>]*)>/i)?.[1] || "").datetime,
    collectedAt: at,
    warnings: [
      "公开网页仅提取当前可见正文，未核读其附件；生成时保留出处，图片仅作为原页引用候选。",
    ],
  });
  const cover = publicReference(meta(html, "og:image"), url);
  if (cover && !item.images.some((image) => image.url === cover))
    item.images.unshift({ url: cover, alt: title });
  return {
    items: [item],
    sourceName,
    truncated: false,
    warnings: [] as string[],
  };
}
export function parseSourceTelegram(
  html: string,
  url: string,
  at: string,
  limit = 20,
) {
  const sourceName =
    sourcePlainText(
      meta(html, "og:title") ||
        html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
        "",
    ).replace(/\s*[–—-]\s*Telegram\s*$/i, "") || new URL(url).pathname;
  const blocks = [
    ...html.matchAll(/<div\b([^>]*\bdata-post\s*=\s*["'][^"']+["'][^>]*)>/gi),
  ];
  const items: JianshuSourceMaterial[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (items.length >= limit) break;
    const id = attributes(blocks[i][1])["data-post"];
    if (!/^[a-zA-Z][\w]{3,31}\/\d+$/.test(id)) continue;
    const block = html.slice(
      blocks[i].index,
      blocks[i + 1]?.index ?? html.length,
    );
    const textMatch = block.match(
      /<div\b[^>]*class\s*=\s*["'][^"']*\btgme_widget_message_text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );
    if (!textMatch) continue;
    const text = sourcePlainText(textMatch[1]);
    if (!text) continue;
    const title = (text.split("\n").find(Boolean) || "资源线索")
      .replace(/^(?:名称|资源名称)\s*[:：]\s*/, "")
      .slice(0, 300);
    items.push(
      sourceMaterial({
        provider: "telegram",
        title,
        html: textMatch[1],
        url: `https://t.me/${id}`,
        sourceName,
        publishedAt: attributes(block.match(/<time\b([^>]*)>/i)?.[1] || "")
          .datetime,
        collectedAt: at,
        warnings: [
          "第三方公开频道的资源线索；规格与分享未经盘序核实，链接不是本人分享。",
        ],
      }),
    );
  }
  if (!items.length)
    throw new AppError(
      "JIANSHU_TELEGRAM_BODY",
      "公开频道未返回可读取的消息正文，可能需要验证、网络不可达或页面已变化。",
    );
  return {
    items: [...new Map(items.map((i) => [i.url, i])).values()],
    sourceName,
    truncated: blocks.length > limit,
    warnings: [] as string[],
  };
}
