/** Parse resource tags while preserving spaces and hash characters inside plain tags. */
export function parseResourceTagInput(text: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const group of text.split(/[,，、;；\r\n\u2028\u2029]+/u)) {
    // Whitespace separates a new hashtag; it does not split a plain multiword tag.
    for (const item of group.split(/\s+(?=[#＃])/u)) {
      let tag = item.trim();
      if (/^[#＃]/u.test(tag)) {
        // Consume every leading marker in one pass so repeated blur stays stable.
        tag = tag.replace(/^[#＃]+/u, "").trim();
        // A topic can have a closing marker. Remove only one to preserve inner hashes.
        if (/[#＃]$/u.test(tag)) tag = tag.slice(0, -1).trim();
      }
      if (!tag || /^[#＃]+$/u.test(tag) || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

/** Use the same parser for blur formatting and saving, so their meanings cannot drift. */
export function formatResourceTagInput(text: string): string {
  return parseResourceTagInput(text).join("，");
}
