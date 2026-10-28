/** Compare names without case, full-width characters, spacing or punctuation. */
export function normalizedResourceTitle(title: string) {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}
