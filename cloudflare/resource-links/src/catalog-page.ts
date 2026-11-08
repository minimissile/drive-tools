import type { CatalogLandingSnapshot } from "../../../shared/catalog-landing";
import {
  landingQuality,
  type PublishedLanding,
} from "../../../shared/resource-landing";
import {
  catalogShare,
  catalogSnapshot,
  type CatalogRow,
  type CatalogListing,
} from "./catalog-store";
import type { Env } from "./types";
import {
  calendar,
  escapeHtml as e,
  paragraphs,
  providerNames,
  siteDocument,
} from "./site-shell";

export interface CatalogPageOptions {
  query: string;
  category: string;
  page: number;
}
export { catalogStyle } from "./catalog-style";
import { catalogStyle } from "./catalog-style";

type CatalogItem = CatalogLandingSnapshot["items"][number];
function renderCatalogResource(
  item: CatalogItem,
  position: number,
  path: string | undefined,
  origin: string,
) {
  const [primary, ...additional] = item.links;
  const share = catalogShare(primary, origin);
  const code = (value: string) =>
    value ? `<span data-nosnippet>提取码 <code>${e(value)}</code></span>` : "";
  return `<article class="catalog-resource" id="resource-${position}">
    <div class="catalog-resource-content">
      <h2>${path ? `<a href="${path}">${e(item.title)}</a>` : e(item.title)}</h2>
      <div class="catalog-resource-meta"><span>${e(item.category || "未分类")}</span><span aria-hidden="true">·</span><span>${providerNames[share.provider]}</span>${path ? `<a href="${path}">查看内容介绍</a>` : ""}</div>
      ${item.summary ? `<div class="catalog-resource-summary">${paragraphs(item.summary)}</div>` : ""}
      ${item.tags.length ? `<div class="catalog-tags" aria-label="资源标签">${item.tags.map((tag) => `<span>${e(tag)}</span>`).join("")}</div>` : ""}
    </div>
    <div class="catalog-actions"><div class="catalog-share"><a class="button catalog-open-link" href="${e(share.url)}" aria-label="打开${e(item.title)}的${providerNames[share.provider]}分享" rel="noopener noreferrer" data-catalog-outbound>打开网盘<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></a>${code(primary.code)}</div></div>
    ${additional.length ? `<details class="catalog-more-shares"><summary>另有 ${additional.length} 个分享入口</summary><ul class="catalog-share-list">${additional.map((link) => `<li><a href="${e(catalogShare(link, origin).url)}" rel="noopener noreferrer" data-catalog-outbound>${e(link.provider)}</a>${code(link.code)}</li>`).join("")}</ul></details>` : ""}
  </article>`;
}
async function landingPaths(env: Env, items: CatalogLandingSnapshot["items"]) {
  const slugs = [
    ...new Set(items.map((i) => i.landingSlug).filter((s): s is string => !!s)),
  ];
  const paths = new Map<string, string>();
  if (!slugs.length) return paths;
  const { results } = await env.DB.prepare(
    `SELECT l.slug,l.title,l.target_url,p.document_json FROM resource_links l JOIN resource_pages p ON p.link_id=l.id
    WHERE l.slug IN(SELECT value FROM json_each(?1)) AND l.enabled=1 AND l.target_url IS NOT NULL AND p.document_json IS NOT NULL`,
  )
    .bind(JSON.stringify(slugs))
    .all<{
      slug: string;
      title: string;
      target_url: string;
      document_json: string;
    }>();
  for (const row of results) {
    try {
      const doc = JSON.parse(row.document_json) as PublishedLanding;
      if (
        doc.source.resourceTitle !== row.title ||
        !landingQuality(doc.article, doc.source, doc.review).eligible
      )
        continue;
      for (const item of items)
        if (item.landingSlug === row.slug)
          paths.set(item.resourceId, `/r/${row.slug}`);
    } catch {
      /* A withdrawn or invalid associated page never becomes an article link. */
    }
  }
  return paths;
}
export async function renderCatalog(
  nonce: string,
  env: Env,
  row: CatalogRow,
  origin: string,
  canonical: boolean,
  options: CatalogPageOptions,
) {
  const snapshot = catalogSnapshot(row),
    base = `/c/${row.slug}`;
  const categories = [
    ...new Set(snapshot.items.map((i) => i.category).filter(Boolean)),
  ];
  const query = options.query.toLocaleLowerCase("zh-CN");
  const matches = snapshot.items.filter(
    (i) =>
      (!options.category || i.category === options.category) &&
      (!query ||
        `${i.title}\n${i.summary}\n${i.tags.join(" ")}`
          .toLocaleLowerCase("zh-CN")
          .includes(query)),
  );
  const start = (options.page - 1) * 50,
    items = matches.slice(start, start + 50),
    paths = await landingPaths(env, items);
  const params = (page: number, category = options.category) => {
    const p = new URLSearchParams();
    if (options.query) p.set("q", options.query);
    if (category) p.set("category", category);
    if (page > 1) p.set("page", String(page));
    return base + (p.size ? `?${p}` : "");
  };
  const indexable =
    canonical &&
    snapshot.items.length > 0 &&
    !options.query &&
    !options.category &&
    options.page === 1;
  const description = `浏览“${snapshot.title.length > 64 ? snapshot.title.slice(0, 64) + "…" : snapshot.title}”资源清单，共${snapshot.items.length}份资料。按分类和关键词查找，查看资源说明后前往网盘获取。`;
  return siteDocument({
    nonce,
    title: snapshot.title,
    description,
    canonical: origin + base,
    indexable,
    style: catalogStyle,
    structured: {
      "@graph": [
        {
          "@type": "CollectionPage",
          "@id": origin + base,
          url: origin + base,
          name: snapshot.title,
          description,
          inLanguage: "zh-CN",
          datePublished: row.published_at,
          dateModified: row.updated_at,
          isPartOf: { "@id": `${origin}/#website` },
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: matches.length,
            itemListElement: items.map((item, i) => ({
              "@type": "ListItem",
              position: start + i + 1,
              name: item.title,
              url:
                origin +
                (paths.get(item.resourceId) ||
                  `${params(options.page)}#resource-${start + i + 1}`),
            })),
          },
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "资源清单",
              item: origin + "/catalogs",
            },
            {
              "@type": "ListItem",
              position: 2,
              name: snapshot.title,
              item: origin + base,
            },
          ],
        },
      ],
    },
    body: `<nav class="breadcrumbs" aria-label="面包屑"><a href="/">资源目录</a><span>/</span><a href="/catalogs">资源清单</a></nav>
      <header class="catalog-heading"><h1>${e(snapshot.title)}</h1>${snapshot.introduction ? `<div class="lead">${paragraphs(snapshot.introduction)}</div>` : ""}<div class="catalog-meta"><span>${snapshot.items.length} 份资源</span><span>${categories.length} 个分类</span><time datetime="${e(row.updated_at)}">更新于 ${calendar(row.updated_at)}</time></div></header>
      <div class="catalog-layout">
        <aside class="catalog-filter"><h2>资源分类</h2><nav aria-label="清单分类"><a href="${e(params(1, ""))}"${!options.category ? ' aria-current="page"' : ""}><span>全部资源</span><small>${snapshot.items.length}</small></a>${categories.map((category) => `<a href="${e(params(1, category))}"${options.category === category ? ' aria-current="page"' : ""}><span>${e(category)}</span><small>${snapshot.items.filter((item) => item.category === category).length}</small></a>`).join("")}</nav></aside>
        <div class="catalog-resources">
          <div class="catalog-toolbar"><form class="search-form" action="${base}" method="get" role="search"><input type="search" name="q" aria-label="搜索这份清单" placeholder="搜索名称、说明或标签" value="${e(options.query)}" maxlength="100">${options.category ? `<input type="hidden" name="category" value="${e(options.category)}">` : ""}<button type="submit" class="button primary">搜索</button></form><p>${matches.length} 份${options.query || options.category ? "匹配资源" : "资源"}</p>${options.query || options.category ? `<a class="catalog-filter-reset" href="${base}">清除筛选</a>` : ""}</div>
          ${
            items.length
              ? `<div class="catalog-list-heading" aria-hidden="true"><span>资源名称</span><span>获取资料</span></div>${items.map((item, i) => renderCatalogResource(item, start + i + 1, paths.get(item.resourceId), origin)).join("")}`
              : `<div class="empty-message"><h2>${snapshot.items.length ? "没有找到匹配的资源" : "清单正在更新"}</h2><p class="muted">${snapshot.items.length ? "可以换个关键词，或返回全部资源继续查看。" : "当前暂无可公开的资源，维护者更新后会在此显示。"}</p>${snapshot.items.length ? `<a href="${base}">查看全部资源</a>` : ""}</div>`
          }
          <nav class="pagination" aria-label="清单翻页">${options.page > 1 ? `<a href="${e(params(options.page - 1))}">上一页</a>` : "<span></span>"}<span class="catalog-page-count">第 ${options.page} 页${items.length || options.page === 1 ? ` / 共 ${Math.max(1, Math.ceil(matches.length / 50))} 页` : ""}</span>${start + 50 < matches.length ? `<a href="${e(params(options.page + 1))}">下一页</a>` : "<span></span>"}</nav>
          <p class="catalog-note">清单展示发布时记录的资源说明与网盘分享，不代表已逐一核读原文件。网盘登录、提取与下载以平台实际显示为准；分享状态可能变化。</p>
        </div>
      </div>`,
  });
}
export function catalogHomeSection(catalogs: CatalogListing[]) {
  return catalogs.length
    ? `<section class="catalog-home-section"><div class="catalog-home-heading"><h2>按清单浏览</h2><a href="/catalogs">查看全部清单</a></div><div class="catalog-home-list">${catalogs.map((c) => `<div><a href="/c/${c.slug}">${e(c.title)}</a><span>${c.item_count} 份资源 · ${calendar(c.updated_at)} 更新</span></div>`).join("")}</div></section>`
    : "";
}
export function renderCatalogIndex(
  nonce: string,
  origin: string,
  canonical: boolean,
  catalogs: CatalogListing[],
  page: number,
  total: number,
) {
  const indexable = canonical && total > 0 && page === 1;
  return siteDocument({
    nonce,
    title: "资源清单",
    description:
      "按主题与分类浏览盘序资源清单，查看资源说明、详细介绍与网盘分享。",
    canonical: origin + "/catalogs",
    indexable,
    style: catalogStyle,
    structured: {
      "@graph": [
        {
          "@type": "CollectionPage",
          "@id": origin + "/catalogs",
          url: origin + "/catalogs",
          name: "资源清单",
          isPartOf: { "@id": origin + "/#website" },
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: total,
            itemListElement: catalogs.map((c, i) => ({
              "@type": "ListItem",
              position: (page - 1) * 20 + i + 1,
              name: c.title,
              url: `${origin}/c/${c.slug}`,
            })),
          },
        },
      ],
    },
    body: `<nav class="breadcrumbs" aria-label="面包屑"><a href="/">资源目录</a><span>/</span><span>资源清单</span></nav><div class="directory-heading"><h1>资源清单</h1><p>按主题整理的资源目录。先了解资源说明，再选择需要的资料。</p></div>${catalogs.length ? `<section class="directory-list" aria-label="已发布清单">${catalogs.map((c) => `<article class="directory-entry"><h2><a href="/c/${c.slug}">${e(c.title)}</a></h2><div class="catalog-index-meta"><span>${c.item_count} 份资源</span><time datetime="${e(c.updated_at)}">${calendar(c.updated_at)} 更新</time></div></article>`).join("")}</section>` : `<div class="empty-message"><h2>${total ? "此页没有清单" : "清单正在整理中"}</h2><p class="muted">${total ? "请返回第一页继续浏览。" : "已经发布的单份资源仍可从资源目录查看。"}</p><a href="${total ? "/catalogs" : "/"}">${total ? "返回清单首页" : "浏览资源目录"}</a></div>`}<nav class="pagination" aria-label="清单索引翻页">${page > 1 ? `<a href="/catalogs${page > 2 ? `?page=${page - 1}` : ""}">上一页</a>` : "<span></span>"}${page * 20 < total ? `<a href="/catalogs?page=${page + 1}">下一页</a>` : ""}</nav>`,
  });
}
