import { createHash } from "node:crypto";
import type { CatalogSnapshot } from "../../shared/resource-catalog";
import type { SmzdmResourceLink } from "../../shared/smzdm";
import { wechatTextInput } from "../../shared/wechat";
import { AppError } from "../errors";
import { id } from "../database";
import { parseShare, shareUrlWithCode } from "../links";
import { articleLinks } from "../smzdm/content";

const markdownText = (text: string) =>
  text.replace(/([\\`*_{}\[\]<>#|!])/g, "\\$1");

/** Stable per exported content, so retries never overwrite an edited draft. */
export const catalogWechatDraftId = (catalogId: string, hash: string) =>
  `wechat_catalog_${createHash("sha256")
    .update(JSON.stringify([catalogId, hash]))
    .digest("hex")
    .slice(0, 40)}`;

/** Input is the catalog domain's verified public snapshot, never renderer text. */
export function catalogWechatText(snapshot: CatalogSnapshot) {
  const links = new Map<string, SmzdmResourceLink>();
  const sections = [
    `# ${markdownText(snapshot.title)}`,
    snapshot.introduction ? markdownText(snapshot.introduction) : "",
  ].filter(Boolean);
  let length = sections.join("\n\n").length;
  for (const [index, item] of snapshot.items.entries()) {
    const section = [
      `## ${index + 1}. ${markdownText(item.title)}`,
      item.summary ? markdownText(item.summary) : "",
      item.tags.length ? `标签：${markdownText(item.tags.join("、"))}` : "",
      ...item.links.map((link) => {
        if (link.code && !/^[a-zA-Z0-9]{4,8}$/.test(link.code))
          throw new AppError(
            "CATALOG_WECHAT_CODE",
            "清单中有无效提取码，请在资源库检查本人分享后重试。",
          );
        const share = parseShare(link.url, link.code || undefined);
        const previous = links.get(share.url);
        if (previous && previous.code !== share.code)
          throw new AppError(
            "CATALOG_WECHAT_CODE",
            "同一分享存在不同提取码，请在资源库核对后重试。",
          );
        const url = shareUrlWithCode(share.url, share.code);
        if (!previous)
          links.set(share.url, {
            id: id("smzlink"),
            url: share.url,
            sourceText: url,
            code: share.code,
            provider: share.provider,
            resourceId: null,
            copyId: null,
            ownUrl: share.url,
            manual: true,
          });
        if (links.size > 100)
          throw new AppError(
            "CATALOG_WECHAT_LINK_LIMIT",
            "公众号每篇最多关联100个网盘链接，请拆分清单后导出；本次未创建草稿。",
          );
        return `[${markdownText(link.provider)} · 查看资源](${url})${share.code ? ` 提取码：${share.code}` : ""}`;
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
    length += section.length + 2;
    if (length > 200000)
      throw new AppError(
        "CATALOG_WECHAT_BODY_LIMIT",
        "清单超过公众号草稿的20万字本地正文上限，请精简或拆分后导出；本次未创建草稿。",
      );
    sections.push(section);
  }
  const body = sections.join("\n\n");
  if (
    articleLinks(body).some((link) => links.get(link.url)?.code !== link.code)
  )
    throw new AppError(
      "CATALOG_WECHAT_EXTRA_LINK",
      "清单说明中含有额外网盘链接或不同提取码，请整理说明后再导出。",
    );
  const text = wechatTextInput.parse({
    title: snapshot.title.slice(0, 64),
    body,
    author: "",
    coverUrl: "",
    digest:
      `${snapshot.introduction || snapshot.title}（${snapshot.items.length}项资源）`.slice(
        0,
        120,
      ),
  });
  return { text, links: [...links.values()] };
}
