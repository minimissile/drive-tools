import type { WechatArticle } from "../../shared/wechat";

/** Tracking parameters do not create a second source article. */
export function wechatSourceIdentity(sourceUrl: string) {
  const url = new URL(sourceUrl);
  url.hash = "";
  if (url.pathname !== "/s") url.search = "";
  else {
    const fields = new URLSearchParams();
    for (const key of ["__biz", "mid", "idx", "sn"])
      if (url.searchParams.has(key))
        fields.set(key, url.searchParams.get(key)!);
    if (fields.has("__biz") && fields.has("mid"))
      url.search = fields.toString();
    else url.searchParams.sort();
  }
  return url.href;
}

export function wechatArticleFamilies(articles: readonly WechatArticle[]) {
  const families = new Map<string, WechatArticle[]>();
  const ordered = [...articles].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      (a.edition?.number ?? 1) - (b.edition?.number ?? 1) ||
      a.id.localeCompare(b.id),
  );
  for (const article of ordered) {
    const key = wechatSourceIdentity(article.source.url);
    const family = families.get(key) ?? [];
    family.push(article);
    families.set(key, family);
  }
  return families;
}
