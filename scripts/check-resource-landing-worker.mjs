// Explicit, isolated Workers runtime check. Pass an installed Wrangler node_modules
// directory when Wrangler is cached outside this repository.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { document } from "../tests/resource-landing-fixture.ts";

const require = createRequire(import.meta.url);
const runtime = process.argv[2]
  ? resolve(process.argv[2], "miniflare")
  : "miniflare";
const { Miniflare, convertV4MiniflareOptions } = require(runtime);
const bundle = await build({
  entryPoints: ["cloudflare/resource-links/src/index.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
const options = {
  workers: [
    {
      name: "landing",
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-30",
      d1Databases: { DB: "landing-tests" },
      bindings: {
        PUBLIC_ORIGIN: "https://panxu.site",
        ADMIN_TOKEN: "isolated-test-token-".repeat(3),
        BING_SITE_VERIFICATION: "A".repeat(32),
      },
    },
  ],
};
const mf = new Miniflare(
  convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options,
);
let checks = 0;
const request = async (path, body, origin = "https://panxu.site") =>
  mf.dispatchFetch(
    origin + path,
    body
      ? {
          method: "PUT",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${"isolated-test-token-".repeat(3)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      : { redirect: "manual" },
  );
const check = (value, message) => {
  assert(value, message);
  checks++;
};
try {
  const db = await mf.getD1Database("DB");
  // D1 exec expects one complete statement per call; prepare supports trigger SQL.
  for (const name of ["0001_resource_links.sql", "0002_resource_pages.sql"]) {
    const sql = await readFile(
      `cloudflare/resource-links/migrations/${name}`,
      "utf8",
    );
    let buffer = "";
    for (const line of sql.split("\n")) {
      buffer += line + "\n";
      const trigger = /CREATE TRIGGER/i.test(buffer);
      if (
        (!trigger && /;\s*$/.test(line)) ||
        (trigger && /^END;/.test(line.trim()))
      ) {
        await db.prepare(buffer).run();
        buffer = "";
      }
    }
    assert(!buffer.trim() || /^--/.test(buffer.trim()));
  }
  const link = {
    operationId: randomUUID(),
    expectedRevision: 0,
    slug: "testSlug123",
    title: "人情世故指南（PDF）",
    provider: "quark",
    targetUrl: "https://pan.quark.cn/s/fixture",
    code: "",
    enabled: true,
  };
  check(
    (await request("/api/links/link-fixture", link)).status === 200,
    "seed fixed link",
  );
  check(
    (await request("/r/testSlug123")).headers
      .get("X-Robots-Tag")
      .includes("noindex"),
    "unpublished link stays noindex",
  );
  const write = {
    operationId: randomUUID(),
    expectedVersion: 0,
    expectedLinkRevision: 1,
    document: document(),
  };
  const pub = await request("/api/pages/link-fixture", write);
  const pubJson = await pub.json();
  check(pub.status === 200, `publish accepted: ${JSON.stringify(pubJson)}`);
  const page = await request("/r/testSlug123"),
    html = await page.text();
  check(
    page.status === 200 && page.headers.get("X-Robots-Tag").startsWith("index"),
    "published canonical page indexable",
  );
  check(
    html.includes('rel="canonical" href="https://panxu.site/r/testSlug123"'),
    "canonical full URL",
  );
  check(
    html.includes("application/ld+json") &&
      html.includes("CreativeWork") &&
      html.includes("人情世故指南.pdf"),
    "SSR article and structured metadata",
  );
  check(
    !html.includes("FAQPage") && !html.includes("AggregateRating"),
    "no invented rich-result claims",
  );
  check(
    (await request("/r/testSlug123", null, "https://test.pages.dev")).headers
      .get("X-Robots-Tag")
      .includes("noindex"),
    "aliases noindex with canonical",
  );
  const head = await mf.dispatchFetch("https://panxu.site/r/testSlug123", {
    method: "HEAD",
  });
  check(
    head.status === 200 && (await head.text()) === "",
    "HEAD has same status and empty body",
  );
  check(
    (await (await request("/")).text()).includes("testSlug123"),
    "published page in catalog",
  );
  check(
    (await (await request("/")).text()).includes(
      'name="msvalidate.01" content="' + "A".repeat(32) + '"',
    ),
    "Bing verification server-rendered in canonical home head",
  );
  check(
    !(
      await (await request("/", null, "https://test.pages.dev")).text()
    ).includes('name="msvalidate.01"'),
    "Bing verification not emitted on alias",
  );
  const search = await request("/?q=%22%3E%3Cscript%3Ealert(1)%3C/script%3E");
  const searchHtml = await search.text();
  check(
    search.headers.get("X-Robots-Tag").includes("noindex") &&
      !searchHtml.includes("<script>alert(1)</script>"),
    "facets noindex and search escaped",
  );
  check(
    (await (await request("/sitemaps/resources-1.xml")).text()).includes(
      "https://panxu.site/r/testSlug123",
    ),
    "sitemap canonical published URL",
  );
  check(
    (await (await request("/robots.txt")).text()).includes(
      "Sitemap: https://panxu.site/sitemap.xml",
    ),
    "robots sitemap discovery",
  );
  check(
    (await (await request("/llms.txt")).text()).includes("testSlug123"),
    "readable AI search discovery",
  );
  const md = await request("/r/testSlug123.md");
  check(
    md.headers.get("X-Robots-Tag").includes("noindex") &&
      (await md.text()).includes("## 文件信息"),
    "Markdown alternate noindex",
  );
  const go = await request("/go/testSlug123");
  check(
    go.status === 302 && go.headers.get("Location") === link.targetUrl,
    "fixed redirect preserved",
  );
  check(
    (await request("/go/testSlug123.md")).status === 404,
    "redirect has no Markdown alias",
  );
  check(
    (await mf.dispatchFetch("https://panxu.site/api/pages/link-fixture"))
      .status === 401,
    "admin authentication required",
  );
  for (const mode of ["no-document", "weak-specificity", "legacy-score"]) {
    const candidate = structuredClone(write);
    candidate.operationId = randomUUID();
    candidate.expectedVersion = 1;
    if (mode === "no-document") candidate.document.source.documents = [];
    if (mode === "weak-specificity")
      candidate.document.review.dimensions.specificity = 3;
    if (mode === "legacy-score") delete candidate.document.review.dimensions;
    check(
      (await request("/api/pages/link-fixture", candidate)).status === 400,
      `reject ${mode} despite high total score`,
    );
  }
  const poor = structuredClone(write);
  poor.operationId = randomUUID();
  poor.expectedVersion = 1;
  poor.document.review.verdict = "revise";
  check(
    (await request("/api/pages/link-fixture", poor)).status === 400,
    "poor quality rejected",
  );
  check(
    (
      await request("/api/pages/link-fixture", {
        ...write,
        operationId: randomUUID(),
      })
    ).status === 409,
    "stale content version rejected",
  );
  const seed2 = { ...link, operationId: randomUUID(), slug: "secondSlug123" };
  await request("/api/links/link-fixture2", seed2);
  check(
    (
      await request("/api/pages/link-fixture2", {
        ...write,
        operationId: randomUUID(),
      })
    ).status === 409,
    "duplicate article blocked across resources",
  );
  const disable = {
    ...link,
    operationId: randomUUID(),
    expectedRevision: 1,
    enabled: false,
  };
  check(
    (await request("/api/links/link-fixture", disable)).status === 200,
    "disable link",
  );
  check(
    (await request("/r/testSlug123")).status === 410,
    "disabled page unavailable",
  );
  check(
    !(await (await request("/")).text()).includes('href="/r/testSlug123"'),
    "disabled page removed from directory",
  );
  const replay = await request("/api/pages/link-fixture", write);
  check(
    replay.status === 200 && (await replay.json()).version === 1,
    "old operation receipt survives newer link state",
  );
  const withdraw = {
    operationId: randomUUID(),
    expectedVersion: 1,
    expectedLinkRevision: 2,
    document: null,
  };
  check(
    (await request("/api/pages/link-fixture", withdraw)).status === 200,
    "withdraw while link disabled",
  );
  console.log(
    JSON.stringify({
      checks,
      runtime: "Miniflare D1 / isolated",
      passed: true,
    }),
  );
} finally {
  await mf.dispose();
}
