import type { TiebaOldResourceEvidence } from "../../shared/tieba-resource-discovery";

export function formatDiscoveryResource(evidence: TiebaOldResourceEvidence) {
  if (evidence.linkSources.length)
    return `${evidence.linkSources.join("、")}含网盘链接`;
  if (evidence.keywords.length) return `关键词 ${evidence.keywords.join("、")}`;
  return "未发现资源线索";
}
