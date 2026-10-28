const retiredWorkflowTags = new Set(["公众号文章", "什么值得买"]);

/** Workflow provenance belongs to its own record, rather than resource labels. */
export function resourceTags(tags: string[]): string[] {
  return tags.filter((tag) => !retiredWorkflowTags.has(tag.trim()));
}
