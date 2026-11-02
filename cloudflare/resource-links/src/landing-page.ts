import {
  landingQuality,
  type PublishedLanding,
  type RemoteLanding,
} from "../../../shared/resource-landing";
import type { LinkRow } from "./types";
import type { ListedPage } from "./landing-store";
import {
  calendar,
  escapeHtml as e,
  fileSize,
  paragraphs,
  providerNames,
  siteDocument,
} from "./site-shell";

export function publishable(link: LinkRow, page: RemoteLanding | null) {
  const doc = page?.document;
  return (
    !!doc &&
    link.enabled === 1 &&
    !!link.target_url &&
    doc.source.resourceTitle === link.title &&
    // Keep already published v1 snapshots readable during the editorial rollout.
    // PUT always uses the stricter current gate; no new metadata-only pages pass.
    (doc.source.documents === undefined && doc.review.dimensions === undefined
      ? doc.review.verdict === "pass" &&
        doc.review.score >= 85 &&
        doc.review.unsupportedClaims.length === 0
      : landingQuality(doc.article, doc.source, doc.review).eligible)
  );
}
export function renderLanding(
  nonce: string,
  link: LinkRow,
  page: RemoteLanding,
  origin: string,
  indexable: boolean,
  related: ListedPage[],
) {
  const doc = page.document!,
    a = doc.article,
    s = doc.source,
    url = `${origin}/r/${link.slug}`;
  const citations = (ids: string[]) =>
    ids.length
      ? `<p class="section-note">资料依据：${ids.map((id) => `<a href="#evidence-${e(id)}">${e(s.facts.find((f) => f.id === id)?.label ?? id)}</a>`).join("")}</p>`
      : "";
  const citedIds = new Set(
    [...a.sections, ...a.faq].flatMap((b) => b.evidenceIds),
  );
  const files = s.files
    .map(
      (f) =>
        `<li id="evidence-${e(f.evidenceId)}"><div class="file-name">${e(f.name)}<div class="file-type">${f.directory ? "文件夹 · 未展开全部内容" : e(f.name.includes(".") ? f.name.split(".").at(-1)!.toUpperCase() : "文件")}</div></div><span class="file-size">${f.directory ? "目录" : e(fileSize(f.size))}</span></li>`,
    )
    .join("");
  const structured = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${origin}/#organization`,
        name: "盘序资源",
        url: origin,
      },
      {
        "@type": "WebPage",
        "@id": url,
        url,
        name: a.title,
        description: a.description,
        inLanguage: "zh-CN",
        datePublished: page.publishedAt,
        dateModified: page.updatedAt,
        mainEntity: { "@id": `${url}#resource` },
      },
      {
        "@type": "CreativeWork",
        "@id": `${url}#resource`,
        name: a.title,
        description: a.summary,
        url,
        inLanguage: "zh-CN",
        datePublished: page.publishedAt,
        dateModified: page.updatedAt,
        publisher: { "@id": `${origin}/#organization` },
        genre: s.category,
        keywords: s.tags.join(", "),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "资源目录",
            item: origin + "/",
          },
          { "@type": "ListItem", position: 2, name: a.title, item: url },
        ],
      },
    ],
  };
  const body = `<nav class="breadcrumbs" aria-label="面包屑"><a href="/">资源目录</a><span>/</span><a href="/?category=${encodeURIComponent(s.category)}">${e(s.category)}</a></nav><div class="article-layout"><article class="article"><h1>${e(a.title)}</h1><div class="article-meta"><span>盘序编辑 · AI 辅助整理</span><time datetime="${e(page.updatedAt)}">更新于 ${calendar(page.updatedAt)}</time></div><div class="lead">${paragraphs(a.summary)}</div>${a.highlights.length ? `<ul class="highlights">${a.highlights.map((h) => `<li>${e(h)}</li>`).join("")}</ul>` : ""}
  <section class="article-section" id="files"><h2>这份资源的文件信息</h2><ul class="file-list">${files}</ul><p class="facts-note">${s.manifestTruncated ? "以上是已记录的目录条目，文件夹内的完整内容尚未全部展开。" : "以上为整理时记录的文件名与大小。"}${s.documents?.length ? s.documents.map((d) => (/\.pdf$/i.test(d.name) ? `《${e(d.name)}》共${d.pageCount}个物理页，已提取${d.pages.length}页${d.sampled ? "的抽样文字，介绍限于已读范围" : "文字"}。下文引用均按文件物理页定位。` : `《${e(d.name)}》已提取${d.sampled ? "部分" : "全文"}文字，引用按文本片段定位。`)).join(" ") : "尚未读取正文，介绍范围限于文件记录。"}</p></section>
  ${a.sections.map((section, i) => `<section class="article-section" id="section-${i + 1}"><h2>${e(section.heading)}${section.kind === "guide" ? '<span class="section-kind">使用建议</span>' : ""}</h2>${paragraphs(section.body)}${citations(section.evidenceIds)}</section>`).join("")}
  ${a.faq.length ? `<section class="article-section faq" id="faq"><h2>常见问题</h2>${a.faq.map((f) => `<details><summary>${e(f.question)}</summary>${paragraphs(f.answer)}${f.kind === "guide" ? '<p class="caption">以上为通用使用建议，不是文件原文摘录。</p>' : ""}${citations(f.evidenceIds)}</details>`).join("")}</section>` : ""}
  <details class="sources"><summary>整理依据与信息范围</summary><p>介绍依据已提取的文件文字和文件记录，引用可定位到具体物理页；抽样范围已在文件信息中注明。标注“使用建议”的段落是编辑建议。AI参与整理并经过独立事实与内容检查，不构成对资料观点、版权或使用效果的背书。</p>${s.facts
    .filter(
      (f) =>
        !f.id.startsWith("file-") &&
        (f.id === "title" || /^doc-\d+$/.test(f.id) || citedIds.has(f.id)),
    )
    .map(
      (f) =>
        `<div class="source-entry" id="evidence-${e(f.id)}"><h3>${e(f.label)}</h3>${paragraphs(f.text.replace(/(?:\.\s*){3,}/g, " "))}</div>`,
    )
    .join("")}</details>
  ${related.length ? `<section class="related"><h2>继续查看相关资源</h2>${related.map((p) => `<a href="/r/${e(p.slug)}">${e(p.title)}</a>`).join("")}</section>` : ""}</article>
  <aside class="get-panel" aria-label="网盘获取"><h2>获取这份资源</h2><p class="provider">${e(providerNames[link.provider])}</p><a class="button primary" href="/go/${e(link.slug)}" target="_blank" rel="nofollow noopener noreferrer">前往网盘查看</a><button class="button" type="button" data-copy="link">${link.code ? "复制链接与提取码" : "复制分享链接"}</button>${link.code ? `<div class="share-code"><span>提取码</span><strong id="share-code">${e(link.code)}</strong></div><button class="button" type="button" data-copy="code">复制提取码</button>` : ""}<p class="copy-status" id="copy-status" role="status" aria-live="polite"></p><details class="share-detail"><summary>查看当前网盘链接</summary><p class="share-url" id="share-link">${e(link.target_url!)}</p></details><p class="caption">在网盘官方页面查看文件，登录与下载范围以平台显示为准。${s.shareCheckedAt ? `<br>分享最近核验：${calendar(s.shareCheckedAt)}` : ""}</p><nav class="toc" aria-label="页内目录"><p>本页内容</p><a href="#files">文件信息</a>${a.sections.map((s, i) => `<a href="#section-${i + 1}">${e(s.heading)}</a>`).join("")}${a.faq.length ? '<a href="#faq">常见问题</a>' : ""}</nav></aside></div>`;
  return siteDocument({
    nonce,
    title: a.title,
    description: a.description,
    canonical: url,
    indexable,
    body,
    structured,
    script: true,
  });
}
export function landingMarkdown(
  link: LinkRow,
  page: RemoteLanding,
  origin: string,
) {
  const doc = page.document!,
    a = doc.article;
  return [
    `# ${a.title}`,
    `来源：${origin}/r/${link.slug}`,
    `更新：${page.updatedAt}`,
    a.summary,
    "## 文件信息",
    ...doc.source.files.map(
      (f) =>
        `- ${f.name}（${f.directory ? "目录，内部内容未全部读取" : fileSize(f.size)}）`,
    ),
    ...(doc.source.documents ?? []).map((d) =>
      /\.pdf$/i.test(d.name)
        ? `读取范围：《${d.name}》共${d.pageCount}页，已提取第${d.pages.join("、")}页${d.sampled ? "的抽样文字" : "文字"}。`
        : `读取范围：《${d.name}》已提取${d.sampled ? "部分" : "全文"}文字，引用按文本片段定位。`,
    ),
    ...a.sections.flatMap((s) => [
      `## ${s.heading}${s.kind === "guide" ? "（通用使用建议）" : ""}`,
      s.body,
      s.evidenceIds.length
        ? `资料依据：${s.evidenceIds.map((id) => doc.source.facts.find((f) => f.id === id)?.label ?? id).join("；")}`
        : "",
    ]),
    ...(a.faq.length ? ["## 常见问题"] : []),
    ...a.faq.flatMap((f) => [`### ${f.question}`, f.answer]),
    "## 说明",
    "本页由盘序使用AI辅助整理，依据文件记录及实际提取的正文；引用按文件物理页定位，抽样不代表通读，使用建议不等于文件原文。",
    `领取入口：${origin}/go/${link.slug}`,
  ].join("\n\n");
}
export function renderDirectory(
  nonce: string,
  origin: string,
  indexable: boolean,
  pages: ListedPage[],
  categories: string[],
  options: { query: string; category: string; page: number; hasNext: boolean },
) {
  const params = (p: number) => {
    const q = new URLSearchParams();
    if (options.query) q.set("q", options.query);
    if (options.category) q.set("category", options.category);
    if (p > 1) q.set("page", String(p));
    return "/" + (q.size ? `?${q}` : "");
  };
  const entries = pages
    .map((p) => {
      const doc = JSON.parse(p.document_json!) as PublishedLanding;
      return `<article class="directory-entry"><h2><a href="/r/${e(p.slug)}">${e(doc.article.title)}</a></h2><p>${e(doc.article.description)}</p><div class="entry-meta"><span>${e(p.category)}</span><span>${e(providerNames[p.provider])}</span><time datetime="${e(p.updated_at)}">${calendar(p.updated_at)} 更新</time></div></article>`;
    })
    .join("");
  return siteDocument({
    nonce,
    title: options.query ? `${options.query} · 资源查找` : "资源目录与使用指南",
    description:
      "根据文件信息、资源说明和具体使用建议，找到适合自己的学习资料、文档与实用模板。查看整理依据，再前往网盘获取。",
    canonical: origin + "/",
    indexable,
    body: `<div class="directory-heading"><h1>找到资源，也看懂怎么用。</h1><p>从可核对的文件信息出发，了解资料适合谁、如何使用，以及获取前需要知道的事。</p></div><form class="search-form" action="/" method="get" role="search"><input type="search" name="q" aria-label="搜索资源" placeholder="搜索资源名称或主题" value="${e(options.query)}" maxlength="100"><button class="button primary" type="submit">搜索资源</button></form><nav class="category-links" aria-label="资源分类"><a href="/"${!options.category ? ' aria-current="page"' : ""}>全部资源</a>${categories.map((c) => `<a href="/?category=${encodeURIComponent(c)}"${c === options.category ? ' aria-current="page"' : ""}>${e(c)}</a>`).join("")}</nav>${pages.length ? `<section class="directory-list" aria-label="资源目录">${entries}</section>` : `<div class="empty-message"><h2>${options.query || options.category ? "没有找到匹配的资源" : "资源正在整理中"}</h2><p class="muted">${options.query || options.category ? "可以换个名称或返回全部资源继续查看。" : "完成内容检查的资源会在这里展示。已有领取链接仍可直接打开。"}</p>${options.query || options.category ? '<a href="/">查看全部资源</a>' : ""}</div>`}<nav class="pagination" aria-label="资源翻页">${options.page > 1 ? `<a href="${e(params(options.page - 1))}">上一页</a>` : "<span></span>"}${options.hasNext ? `<a href="${e(params(options.page + 1))}">下一页</a>` : ""}</nav>`,
  });
}
export function renderAbout(nonce: string, origin: string, indexable: boolean) {
  return siteDocument({
    nonce,
    title: "关于盘序资源与内容整理方式",
    description:
      "了解盘序资源目录的资料依据、AI 辅助整理流程、使用建议与文件内容的区别，以及网盘获取方式。",
    canonical: origin + "/about",
    indexable,
    body: `<article class="text-page"><h1>关于盘序资源</h1><p>盘序资源帮助读者先了解一份资料，再决定是否前往网盘查看。页面提供资源说明、已记录的文件信息、使用建议与常见问题，文件由分享者在网盘提供。</p><h2>我们依据什么整理</h2><p>首先核对文件清单，再读取PDF或文本正文。介绍中的事实可以追溯到具体文件和物理页；长文档采用抽样读取时会明确范围，不冒充通读。文件名、宣传文章和文件大小不能代替内容依据。每页保留来源和更新日期。</p><h2>AI 怎样参与</h2><p>AI根据实际正文整理内容要点、查阅线索和适用边界，编辑取舍用于帮助读者判断是否需要这份资料。发布前独立审阅事实准确性、具体性、实用性、表达与来源可信度；通用长文、内容不足和没有正文依据的页面保留为草稿，不进入公开目录及站点地图。内部审核分数不代表搜索平台评分或保证收录。</p><h2>使用建议与文件内容有什么区别</h2><p>标注“使用建议”的段落是围绕资源主题整理的方法，原创示例会注明示例身份，不表示它们出现在文件中。页面不会以文件名为依据猜测目录、页数、作者、版本、授权或使用效果。</p><h2>如何获取与更新</h2><p>点击资源页的网盘按钮，进入平台官方页面查看。登录、提取和下载范围以平台实际显示为准。页面注明的是整理时记录的信息与最近核验时间；文件和分享状态可能变化，固定入口可由分享者维护更新。</p><p><a href="/">返回资源目录</a></p></article>`,
  });
}
