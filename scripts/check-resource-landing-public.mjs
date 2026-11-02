// Read-only production check. No admin token, drive login or cloud writes.
import assert from "node:assert/strict";
const origin = "https://panxu.site",
  path = "/r/fVOZw5ZbE_Z5";
let checks = 0;
const check = (condition, message) => {
  assert(condition, message);
  checks++;
};
const read = (url, options = {}) =>
  fetch(url.startsWith("https:") ? url : origin + url, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    ...options,
  });
const response = await read(path),
  html = await response.text();
check(response.status === 200, "published article 200");
check(
  response.headers.get("X-Robots-Tag")?.startsWith("index"),
  "published article indexable",
);
check(
  html.includes(`rel="canonical" href="${origin}${path}"`),
  "canonical custom domain",
);
check(
  (html.match(/<h1>/g) ?? []).length === 1 && html.includes("人情世故指南 PDF"),
  "one descriptive H1",
);
const withoutScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
check(
  withoutScripts.includes("物理页") &&
    /校园|职场|求助/.test(withoutScripts) &&
    withoutScripts.includes("资料依据") &&
    withoutScripts.includes("人情世故指南.pdf"),
  "useful article available without JavaScript",
);
const structured = JSON.parse(
  html.match(
    /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/,
  )[1],
);
check(
  structured["@graph"].some(
    (n) => n["@type"] === "CreativeWork" && n.url === origin + path,
  ),
  "structured metadata matches page",
);
check(
  !html.includes("AggregateRating") && !html.includes('"@type":"FAQPage"'),
  "no invented rich-result claims",
);
const paths = [
  "/",
  "/sitemap.xml",
  "/sitemaps/resources-1.xml",
  "/robots.txt",
  "/llms.txt",
  path + ".md",
  "/go/fVOZw5ZbE_Z5",
  "/r/doesnotexist123",
  "/?q=%22%3E%3Cscript%3Ealert(1)%3C/script%3E",
  "https://panxu-resource-links.pages.dev" + path,
  "/api/pages/invalid-noauth",
];
const results = await Promise.all(
  paths.map(async (url) => {
    const r = await read(url);
    return { url, status: r.status, headers: r.headers, body: await r.text() };
  }),
);
const [
  catalog,
  index,
  sitemap,
  robots,
  llms,
  md,
  go,
  missing,
  search,
  alias,
  api,
] = results;
check(
  catalog.status === 200 && catalog.body.includes(`href="${path}"`),
  "article in public catalog",
);
check(
  index.status === 200 && index.body.includes("/sitemaps/resources-1.xml"),
  "sitemap index discovers resource shard",
);
check(
  sitemap.status === 200 && sitemap.body.includes(origin + path),
  "published article in canonical sitemap",
);
check(
  robots.status === 200 &&
    robots.body.includes("Disallow: /api/") &&
    robots.body.includes("Sitemap: " + origin),
  "robots discovery and admin exclusion",
);
check(
  llms.status === 200 && llms.body.includes(origin + path),
  "AI-readable directory includes published page",
);
check(
  md.status === 200 &&
    md.headers.get("X-Robots-Tag")?.includes("noindex") &&
    md.body.includes("## 文件信息"),
  "Markdown same-content alternate noindex",
);
check(
  go.status === 302 &&
    go.headers.get("Location")?.startsWith("https://pan.quark.cn/s/"),
  "fixed redirect still resolves to official drive",
);
check(
  missing.status === 404 &&
    missing.headers.get("X-Robots-Tag")?.includes("noindex"),
  "missing resource not a soft 404",
);
check(
  search.status === 200 &&
    search.headers.get("X-Robots-Tag")?.includes("noindex") &&
    !search.body.includes("<script>alert(1)</script>"),
  "search results escaped and noindex",
);
check(
  alias.status === 200 &&
    alias.headers.get("X-Robots-Tag")?.includes("noindex") &&
    alias.body.includes(origin + path),
  "Pages alias stays usable with canonical/noindex",
);
check(
  api.status === 401 && !api.body.includes("document_json"),
  "admin data protected",
);
const head = await read(path, { method: "HEAD" });
check(head.status === 200 && (await head.text()) === "", "HEAD response valid");
for (const agent of [
  "Googlebot",
  "bingbot",
  "OAI-SearchBot",
  "PerplexityBot",
]) {
  const r = await read(path, { headers: { "User-Agent": agent } });
  check(
    r.status === 200 && (await r.text()).includes("人情世故指南.pdf"),
    `public response to ${agent} user agent`,
  );
}
console.log(
  JSON.stringify({
    origin,
    page: origin + path,
    checks,
    passed: true,
    note: "User-agent checks do not prove real crawler indexing or regional reachability.",
  }),
);
