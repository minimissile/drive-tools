import type { WechatTiebaImportSource } from "../../shared/wechat";
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
  return articleLinkOccurrences(wechatImportedBody(body)).map(({ share }) => [
    share.provider,
    share.url,
    share.code,
  ]);
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
