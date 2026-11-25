import {
  isTiebaArticleImageHost,
  type WechatTiebaImportSource,
} from "../../shared/wechat";
import {
  linkifyWechatMarkdown,
  wechatArticleImages,
} from "../../shared/wechat-markup";
import { articleLinkOccurrences, formatArticle } from "../smzdm/content";

type Images = ReturnType<typeof wechatArticleImages>;

export function wechatImportedBody(body: string) {
  return linkifyWechatMarkdown(formatArticle(body));
}

function withoutImages(body: string, images: Images, start = 0) {
  let content = "";
  for (const { index, markup } of images) {
    content += body.slice(start, index);
    start = index + markup.length;
  }
  return content + body.slice(start);
}

function standaloneImages(source: WechatTiebaImportSource) {
  const { body } = source;
  const images = wechatArticleImages(body);
  if (images.length !== source.imageCount) return [];
  const independent = images.every(({ index, markup }) => {
    const start = body.lastIndexOf("\n", index - 1) + 1;
    const after = index + markup.length;
    const end = body.indexOf("\n", after);
    return (
      !body.slice(start, index).trim() &&
      !body.slice(after, end < 0 ? undefined : end).trim()
    );
  });
  return independent ? images : [];
}

function trailingImages(source: WechatTiebaImportSource) {
  if (source.preservesImageOrder || !source.imageCount) return [];
  const images = standaloneImages(source);
  const first = images[0];
  return first &&
    source.body.slice(0, first.index).trim() &&
    !withoutImages(source.body, images, first.index).trim()
    ? images
    : [];
}

export function hasLegacyTiebaImageTail(source: WechatTiebaImportSource) {
  return trailingImages(source).length > 0;
}

function proseUrls(prose: string) {
  // The former transport could join the 123 share address to the extraction-code label.
  return (
    prose
      .replace(
        /(https?:\/\/(?:www\.)?123pan\.com\/s\/[\w-]+)(?=提取码|访问码|密码)/gi,
        "$1 ",
      )
      .match(/https?:\/\/[^\s<>"'，。；）)\]]+/gi) ?? []
  );
}

function shareIdentities(body: string) {
  return articleLinkOccurrences(wechatImportedBody(body)).map(
    ({ share: { provider, url, code } }) => ({ provider, url, code }),
  );
}

export function canRestoreTiebaImageOrder(
  previous: WechatTiebaImportSource,
  incoming: WechatTiebaImportSource,
) {
  if (!incoming.preservesImageOrder) return false;
  const oldImages = trailingImages(previous);
  const newImages = standaloneImages(incoming);
  if (
    !oldImages.length ||
    oldImages.length !== newImages.length ||
    oldImages.some(({ markup }, index) => markup !== newImages[index].markup)
  )
    return false;
  const oldText = withoutImages(previous.body, oldImages);
  const newText = withoutImages(incoming.body, newImages);
  return (
    oldText.replace(/\s/g, "") === newText.replace(/\s/g, "") &&
    JSON.stringify(proseUrls(oldText)) === JSON.stringify(proseUrls(newText)) &&
    JSON.stringify(shareIdentities(previous.body)) ===
      JSON.stringify(shareIdentities(incoming.body))
  );
}

const unlinkedBaiduLabel = /^[\t ]*百度网盘(?=[\t ]*\r?$)/;
const linkedBaiduLabel =
  /^[\t ]*\[百度网盘\]\((https:\/\/pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+)\)(?=[\t ]*\r?$)/;

function uniqueBaiduLabel(body: string, label: RegExp) {
  let found: { index: number; markup: string; url?: string } | undefined;
  let offset = 0;
  let fence = "";
  for (const line of body.split("\n")) {
    const delimiter = line.match(/^[\t ]*(`{3,}|~{3,})/)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter.startsWith(fence)) fence = "";
    } else if (!fence) {
      const match = label.exec(line);
      if (match) {
        if (found) return null;
        found = { index: offset, markup: match[0], url: match[1] };
      }
    }
    offset += line.length + 1;
  }
  return found;
}

export function hasUnlinkedTiebaBaiduLabel(body: string) {
  return !!uniqueBaiduLabel(body, unlinkedBaiduLabel);
}

function withoutTiebaImageTokens(body: string) {
  let result = "";
  let offset = 0;
  for (const { index, markup, url } of wechatArticleImages(body)) {
    const target = URL.parse(url);
    if (
      !target ||
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      !isTiebaArticleImageHost(target.hostname) ||
      !target.searchParams.has("tbpicau")
    )
      continue;
    target.searchParams.delete("tbpicau");
    result +=
      body.slice(offset, index) +
      markup.slice(0, -url.length - 1) +
      target.href +
      ")";
    offset = index + markup.length;
  }
  return result + body.slice(offset);
}

/** Use the label at its proven source position, with the original draft's image URLs. */
export function restoreUncodedTiebaBaiduShare(
  previous: string,
  incoming: string,
) {
  const oldLabel = uniqueBaiduLabel(previous, unlinkedBaiduLabel);
  const newLabel = uniqueBaiduLabel(incoming, linkedBaiduLabel);
  if (!oldLabel || !newLabel?.url) return null;
  const demoted =
    incoming.slice(0, newLabel.index) +
    newLabel.markup.replace(`[百度网盘](${newLabel.url})`, "百度网盘") +
    incoming.slice(newLabel.index + newLabel.markup.length);
  if (
    wechatImportedBody(withoutTiebaImageTokens(previous)) !==
    wechatImportedBody(withoutTiebaImageTokens(demoted))
  )
    return null;
  const repaired =
    previous.slice(0, oldLabel.index) +
    oldLabel.markup.replace("百度网盘", `[百度网盘](${newLabel.url})`) +
    previous.slice(oldLabel.index + oldLabel.markup.length);
  const before = shareIdentities(previous);
  const after = shareIdentities(repaired);
  const added = after.filter(({ url }) => url === newLabel.url);
  return !before.some(({ url }) => url === newLabel.url) &&
    added.length === 1 &&
    added[0].code === "" &&
    JSON.stringify(before) ===
      JSON.stringify(after.filter(({ url }) => url !== newLabel.url))
    ? repaired
    : null;
}
