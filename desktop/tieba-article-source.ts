import {
  readTiebaThreadSource,
  type TiebaSourcePart,
} from "../core/tieba/analysis";
import { tiebaThreadIdFromUrl } from "../core/tieba/participation-page";
import { tiebaBaiduMiniAppShare } from "../shared/tieba-article-links";
import {
  isTiebaArticleImageHost,
  type WechatTiebaImportSource,
} from "../shared/wechat";

function publicUrl(value: string) {
  const url = URL.parse(value);
  return url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.href.length <= 4000
    ? url
    : null;
}

function postLink(value: string) {
  const url = publicUrl(value);
  if (!url) return null;
  const isSafetyNotice =
    (url.hostname === "tieba.baidu.com" && url.pathname === "/mo/q/checkurl") ||
    (["jump.bdimg.com", "jump2.bdimg.com"].includes(url.hostname) &&
      url.pathname === "/safecheck/index");
  return isSafetyNotice ? publicUrl(url.searchParams.get("url") ?? "") : url;
}

function markdownUrl(url: URL) {
  return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function postBody(parts: readonly TiebaSourcePart[]) {
  const bodyParts: string[] = [];
  const bareLinks = new Set<string>();
  let imageCount = 0;
  let skippedImages = 0;
  for (const part of parts) {
    if (part.kind === "image") {
      const image = publicUrl(part.url);
      if (
        !image ||
        !isTiebaArticleImageHost(image.hostname) ||
        image.pathname === "/"
      ) {
        skippedImages++;
        continue;
      }
      image.protocol = "https:";
      image.hash = "";
      bodyParts.push(`\n\n![贴吧配图](${markdownUrl(image)})\n\n`);
      imageCount++;
      continue;
    }

    const target =
      part.href && (tiebaBaiduMiniAppShare(part.href) ?? postLink(part.href));
    const visible = part.text.trim();
    if (!target) {
      bodyParts.push(part.text);
    } else if (!visible) {
      bodyParts.push(`\n\n${target.href}\n\n`);
    } else if (
      visible.startsWith(target.href) &&
      /^(?:$|\s|提取码|访问码|密码)/.test(visible.slice(target.href.length))
    ) {
      bareLinks.add(target.href);
      bodyParts.push(part.text);
    } else {
      const start = part.text.indexOf(visible);
      const end = start + visible.length;
      const label = visible
        .replace(/[\[\]]/g, "")
        .replace(/[\r\n]+/g, " ")
        .trim();
      bodyParts.push(
        `${part.text.slice(0, start)}[${label || target.href}](${markdownUrl(target)})${part.text.slice(end)}`,
      );
    }
  }
  let body = bodyParts.join("");
  for (const address of bareLinks)
    for (const label of ["提取码", "访问码", "密码"])
      body = body.replaceAll(`${address}${label}`, `${address} ${label}`);
  return {
    body: body
      .replace(/\n[\t ]+(?=\n)/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    imageCount,
    skippedImages,
  };
}

/** Uses the same anonymous public-thread reader as the Tieba tools. */
export async function readPublicTiebaArticle(
  url: string,
  readThread = readTiebaThreadSource,
): Promise<WechatTiebaImportSource | null> {
  const id = tiebaThreadIdFromUrl(url);
  if (!id) return null;
  const thread = await readThread(id, undefined, true);
  const floor = thread.firstFloor;
  if (
    thread.id !== id ||
    thread.url !== url ||
    !floor?.parts ||
    floor.truncated
  )
    return null;

  const { body, imageCount, skippedImages } = postBody(floor.parts);
  if (!body || body.length > 200000) return null;
  return {
    kind: "tieba",
    url,
    title: thread.title.slice(0, 200),
    author: thread.author.slice(0, 200),
    publishedAt: thread.publishedAt ?? "",
    body,
    imageCount,
    preservesImageOrder: true,
    warnings: skippedImages
      ? [`${skippedImages} 张配图未导入，请对照原帖补充。`]
      : [],
  };
}
