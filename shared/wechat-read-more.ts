import { z } from "zod";
import { wechatReadMoreUrls } from "./wechat-markup";

export const wechatReadMoreSchema = z.object({
  kind: z.enum(["drive", "landing", "redirect"]),
  linkId: z.string().min(1).max(100).optional(),
});
export type WechatReadMore = z.infer<typeof wechatReadMoreSchema>;
export interface WechatReadMoreEntry {
  linkId: string;
  title: string;
  driveUrl: string;
  landingUrl: string | null;
  redirectUrl: string | null;
  landingIssue: string | null;
  redirectIssue: string | null;
}

function identity(raw: string) {
  const url = new URL(raw);
  return url.origin + url.pathname;
}

/** Resolve only existing entries. Reading or selecting never creates or publishes a link. */
export function resolveWechatReadMore(
  body: string,
  entries: WechatReadMoreEntry[],
  selection?: WechatReadMore,
) {
  const urls = wechatReadMoreUrls(body);
  const entry = selection?.linkId
    ? entries.find((item) => item.linkId === selection.linkId)
    : urls.flatMap((url) =>
        entries.filter((item) => identity(item.driveUrl) === identity(url)),
      )[0];
  const driveUrl = entry
    ? (urls.find((url) => identity(url) === identity(entry.driveUrl)) ?? "")
    : selection?.linkId
      ? ""
      : (urls[0] ?? "");
  const kind = selection?.kind ?? "drive";
  const missing = !!(selection?.linkId && (!entry || !driveUrl));
  let issue: string | null = null;
  if (missing) issue = "所选资源已不在正文中，请重新选择原文链接资源。";
  else if (kind !== "drive" && !entry)
    issue = "请先在网盘链接中将正文资源入库，再选择原文链接。";
  else if (kind === "landing")
    issue =
      entry?.landingIssue ??
      (!entry?.landingUrl ? "尚未发布资源落地页，请先在资源库发布。" : null);
  else if (kind === "redirect")
    issue =
      entry?.redirectIssue ??
      (!entry?.redirectUrl
        ? "尚未创建直达短链接，请先在资源库创建固定入口。"
        : null);
  const url = issue
    ? ""
    : kind === "landing"
      ? (entry?.landingUrl ?? "")
      : kind === "redirect"
        ? (entry?.redirectUrl ?? "")
        : driveUrl;
  return { entry, url, driveUrl: issue ? "" : driveUrl, issue, missing };
}
