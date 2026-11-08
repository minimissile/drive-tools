import type { TiebaPublishingDraft } from "../../shared/tieba-publishing";
import { AppError } from "../errors";
import { parseShare } from "../links";
import {
  topicFingerprint,
  topicHash,
  topicSurface,
} from "../tieba-topics/policy";
export { topicFingerprint, topicHash, topicSurface };
const urls = (text: string) =>
  text.match(/https?:\/\/[^\s<>"'，。；）)]+/giu) ?? [];
export function checkResourcePost(
  draft: Pick<TiebaPublishingDraft, "title" | "body" | "resources">,
) {
  if (
    draft.title.trim().length < 3 ||
    draft.title.length > 30 ||
    draft.body.trim().length < 80 ||
    draft.body.length > 10000
  )
    throw new AppError(
      "TIEBA_PUBLISHING_LENGTH",
      "标题应为3至30字，正文应为80至10000字。",
    );
  if (!draft.resources.length || draft.resources.length > 10)
    throw new AppError(
      "TIEBA_PUBLISHING_RESOURCES",
      "请选择1至10份已核验的本人网盘资源。",
    );
  if (urls(draft.title).length)
    throw new AppError(
      "TIEBA_PUBLISHING_TITLE_LINK",
      "网盘链接请放在正文中，标题保留资源名称与主题。",
    );
  const found = new Set<string>();
  const links = [...draft.body.matchAll(/https?:\/\/[^\s<>"'，。；）)]+/giu)];
  for (const [index, match] of links.entries()) {
    const text = match[0];
    const url = new URL(text);
    if (
      url.protocol !== "https:" ||
      [...url.searchParams.keys()].some(
        (key) => !["pwd", "code", "surl"].includes(key),
      )
    )
      throw new AppError(
        "TIEBA_PUBLISHING_LINK",
        "正文仅允许所选资源的HTTPS网盘分享链接。",
      );
    const parsed = parseShare(text),
      resource = draft.resources.find((item) => item.url === parsed.url);
    if (!resource || (parsed.code && parsed.code !== resource.code))
      throw new AppError(
        "TIEBA_PUBLISHING_LINK",
        "正文链接或提取码与所选本人分享不一致，请重新插入资源链接。",
      );
    const suffix = draft.body.slice(
      match.index! + text.length,
      links[index + 1]?.index ?? draft.body.length,
    );
    const codes = [
      ...suffix.matchAll(
        /(?:提取码|访问码|密码)\s*[:：]?\s*([a-z0-9]{4,8})(?![a-z0-9])/giu,
      ),
    ].map((code) => code[1]);
    if (
      codes.some((code) => code !== resource.code) ||
      (resource.code &&
        parsed.code !== resource.code &&
        !codes.includes(resource.code))
    )
      throw new AppError(
        "TIEBA_PUBLISHING_CODE",
        "所选分享需要提取码，请将已保存的提取码一并放入正文。",
      );
    found.add(resource.copyId);
  }
  if (draft.resources.some((resource) => !found.has(resource.copyId)))
    throw new AppError(
      "TIEBA_PUBLISHING_MISSING_LINK",
      "正文尚未包含全部所选资源的网盘链接，请插入后再保存检查。",
    );
  if (/互关|互赞|关注必回|加群|私信领取|扫码领取/u.test(draft.body))
    throw new AppError(
      "TIEBA_PUBLISHING_EXCHANGE",
      "正文含交换互动或群聊导流内容，请修改后再发布。",
    );
  return [
    "所选资源均为已核验的本人分享",
    "正文网盘链接与提取码和所选资源一致",
    "标题与正文长度通过检查",
    "未触发转存、建链或付费生成",
  ];
}
