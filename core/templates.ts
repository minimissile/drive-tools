import {
  channelProfiles,
  contentFormats,
  defaultContentFormat,
  type ContentFormat,
} from "../shared/channels";
import type { Platform, Resource } from "../shared/types";
import { redactLinks } from "./text-safety";
const clean = (s: string) =>
  redactLinks(s)
    .replace(/(?:提取码|访问码|密码)\s*[:：]?\s*[a-zA-Z0-9]{4,8}/g, "")
    .trim();
export function localTemplate(
  resource: Resource,
  platform: Platform,
  contentFormat: ContentFormat = defaultContentFormat(platform),
) {
  const facts =
    clean(resource.summary) || "【请填写可核实的资源内容、适合人群与使用条件】";
  if (platform === "weibo")
    return {
      title: clean(resource.title),
      body: `${facts}\n\n适合人群：【请填写适合使用这份资料的人群】\n使用建议：【请填写一个具体用途与限制】`,
      tags: resource.tags.filter((t) => /^[^#\s<>:/]{1,30}$/.test(t)).slice(0, 3),
      coverText: "",
    };
  const sections = channelProfiles[platform].technical
    ? [
        "核心问题与结论",
        "环境与前置条件",
        "可复现步骤和代码／截图证据",
        "验证结果与限制",
        "资料版本和参考来源",
      ]
    : contentFormats[contentFormat].sections;
  return {
    title: clean(resource.title),
    body: `资料说明（仅依据已录入信息）：\n${facts}\n\n${sections.map((s) => `## ${s}\n【请填写经核实的具体内容】`).join("\n\n")}`,
    tags: resource.tags.filter((t) => !/https?:/i.test(t)),
    coverText: "",
  };
}
