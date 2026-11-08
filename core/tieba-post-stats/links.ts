import { parseShare } from "../links";

/** Parse the body's actual text/href values; a hostname mention alone is not a share. */
export function tiebaBodyDriveLinks(body: string, hrefs: string[] = []) {
  const urls: string[] = body.match(/https?:\/\/[^\s<>"'，。；）)]+/giu) ?? [];
  for (const href of hrefs) {
    try {
      const parsed = new URL(href);
      if (["http:", "https:"].includes(parsed.protocol)) urls.push(parsed.href);
    } catch {
      /* Relative and script links are not direct cloud shares. */
    }
  }
  const result = new Set<string>();
  for (const url of urls) {
    try {
      result.add(parseShare(url).url);
    } catch {
      // A foreign or malformed link is never evidence of an eligible resource post.
    }
  }
  return [...result];
}
