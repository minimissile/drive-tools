import type { WechatSummary } from "../../shared/wechat";

export interface WechatArticleGroup {
  id: string;
  title: string;
  updatedAt: string;
  editions: WechatSummary[];
}

export function groupWechatArticles(items: readonly WechatSummary[]) {
  const families = new Map<string, WechatSummary[]>();
  for (const item of items) {
    const id = item.materialId ?? item.edition?.rootId ?? item.id;
    const editions = families.get(id) ?? [];
    editions.push(item);
    families.set(id, editions);
  }
  return Array.from(families, ([id, items]): WechatArticleGroup => {
    const editions = [...items].sort(
      (a, b) =>
        (a.editionNumber ?? a.edition?.number ?? 1) -
        (b.editionNumber ?? b.edition?.number ?? 1),
    );
    const original = editions.find((item) => item.id === id) ?? editions[0];
    return {
      id,
      title: original.sourceTitle || original.title,
      updatedAt: items.reduce(
        (latest, item) => (item.updatedAt > latest ? item.updatedAt : latest),
        "",
      ),
      editions,
    };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function preferredWechatEdition(
  group: WechatArticleGroup,
  remembered?: string,
) {
  return (
    group.editions.find((item) => item.id === remembered)?.id ??
    [...group.editions].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )[0].id
  );
}

export function matchesWechatArticle(group: WechatArticleGroup, query: string) {
  const needle = query.trim().toLowerCase();
  return (
    group.title.toLowerCase().includes(needle) ||
    group.editions.some((item) => item.title.toLowerCase().includes(needle))
  );
}
