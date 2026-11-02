import { pageHeaders, renderPage } from "./page";
import { flushIndexNow, indexNowKeyResponse } from "./indexnow";
import { searchVerification } from "./search-verification";
import {
  checkConnection,
  findById,
  findBySlug,
  putLink,
  remoteLink,
} from "./store";
import { HttpError, type Env } from "./types";
import { destination, parseWrite, validId, validSlug } from "./validation";
import {
  findPage,
  publicCategories,
  publicPageCount,
  publicPages,
  putPage,
} from "./landing-store";
import {
  landingMarkdown,
  publishable,
  renderAbout,
  renderDirectory,
  renderLanding,
} from "./landing-page";

const identity = { service: "panxu-resource-links", version: 1 } as const;
const maxBodyBytes = 16 * 1024;

function securityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    Pragma: "no-cache",
    Expires: "0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}

function json(
  value: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...securityHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
  });
}

function html(view: Parameters<typeof renderPage>[1], status = 200): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  return new Response(renderPage(nonce, view), {
    status,
    headers: { ...securityHeaders(), ...pageHeaders(nonce) },
  });
}

async function authorize(
  request: Request,
  env: Env,
  origin: string,
): Promise<void> {
  if (
    typeof env.ADMIN_TOKEN !== "string" ||
    !/^[!-~]{32,512}$/.test(env.ADMIN_TOKEN)
  ) {
    throw new HttpError(
      503,
      "SERVICE_NOT_CONFIGURED",
      "管理服务尚未配置，请设置有效的 ADMIN_TOKEN secret。",
    );
  }
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && requestOrigin !== origin)
    throw new HttpError(403, "ORIGIN_REJECTED", "管理接口不接受跨站请求。");
  const match = /^Bearer ([!-~]{32,512})$/i.exec(
    request.headers.get("Authorization") ?? "",
  );
  if (!match) throw new HttpError(401, "UNAUTHORIZED", "管理令牌无效。");
  // Compare fixed-size digests with the Worker's native timing-safe primitive.
  const encoder = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_TOKEN)),
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
  ]);
  if (!crypto.subtle.timingSafeEqual(expected, actual))
    throw new HttpError(401, "UNAUTHORIZED", "管理令牌无效。");
}

async function requestJson(
  request: Request,
  limit = maxBodyBytes,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("Content-Type") ?? "",
    )
  ) {
    throw new HttpError(
      415,
      "JSON_REQUIRED",
      "请使用 application/json 请求内容。",
    );
  }
  const length = request.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new HttpError(
      413,
      "BODY_TOO_LARGE",
      `请求内容不得超过 ${limit / 1024}KB。`,
    );
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_JSON", "请求内容不能为空。");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new HttpError(
          413,
          "BODY_TOO_LARGE",
          `请求内容不得超过 ${limit / 1024}KB。`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求内容不是有效的 UTF-8 JSON。");
  }
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/health" && request.method === "GET")
    return json(identity);
  await authorize(request, env, url.origin);
  if (url.pathname === "/api/connection") {
    if (request.method !== "GET")
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "此接口仅支持 GET。");
    await checkConnection(env);
    return json(identity);
  }
  const pageId = /^\/api\/pages\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
  if (pageId) {
    if (!validId(pageId))
      throw new HttpError(400, "INVALID_ID", "管理 ID 格式不正确。");
    if (request.method === "GET") {
      const page = await findPage(env, pageId);
      return json(page, page ? 200 : 404);
    }
    if (request.method === "PUT")
      return json(
        await putPage(env, pageId, await requestJson(request, 128 * 1024)),
      );
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "此接口仅支持 GET 和 PUT。");
  }
  const id = /^\/api\/links\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
  if (!id) throw new HttpError(404, "NOT_FOUND", "管理接口不存在。");
  if (!validId(id))
    throw new HttpError(400, "INVALID_ID", "管理 ID 格式不正确。");
  if (request.method === "GET") {
    const row = await findById(env, id);
    return json(row ? remoteLink(row, url.origin) : null, row ? 200 : 404);
  }
  if (request.method === "PUT") {
    const input = parseWrite(await requestJson(request), url.origin);
    return json(await putLink(env, id, input, url.origin));
  }
  throw new HttpError(405, "METHOD_NOT_ALLOWED", "此接口仅支持 GET 和 PUT。");
}

async function publicPage(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return html(
      { title: "无法访问此页面", message: "请通过浏览器打开资源领取链接。" },
      405,
    );
  const origin = canonicalOrigin(env),
    canonical = url.origin === origin;
  const plain = (body: string, type = "text/plain; charset=utf-8") => {
    const headers = securityHeaders();
    // Sitemaps and robots must stay usable by crawlers. Text alternatives and
    // management responses retain their separate noindex policy.
    const discovery =
      url.pathname === "/robots.txt" ||
      url.pathname === "/sitemap.xml" ||
      url.pathname.startsWith("/sitemaps/");
    if (discovery) {
      if (canonical) delete headers["X-Robots-Tag"];
      else headers["X-Robots-Tag"] = "noindex, follow";
    }
    return new Response(body, {
      headers: { ...headers, "Content-Type": type },
    });
  };
  if (url.pathname === "/robots.txt")
    return plain(
      `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /go/\n\nSitemap: ${origin}/sitemap.xml\n`,
    );
  if (url.pathname === "/llms.txt") {
    const pages = await publicPages(env, { limit: 100 });
    return plain(
      `# 盘序资源\n\n> 基于资源资料与文件记录的中文说明和使用指南，部分内容使用 AI 辅助整理。使用建议不表示文件原文。\n\n## 网站\n- [资源目录](${origin}/)\n- [整理方式](${origin}/about)\n\n## 已发布资源\n${pages.map((p) => `- [${p.title.replace(/[\[\]\\\r\n]/g, "")}](${origin}/r/${p.slug})：${(JSON.parse(p.document_json!) as { article: { description: string } }).article.description}`).join("\n")}\n\n资源页的 .md 地址提供同一内容的 Markdown 表达，不另行生成内容。网盘入口以页面提供的 /go/ 地址为准。\n`,
    );
  }
  if (url.pathname === "/sitemap.xml") {
    const total = await publicPageCount(env),
      chunks = Math.ceil(total / 1000);
    return plain(
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemaps/site.xml</loc></sitemap>${Array.from({ length: chunks }, (_, i) => `<sitemap><loc>${origin}/sitemaps/resources-${i + 1}.xml</loc></sitemap>`).join("")}</sitemapindex>`,
      "application/xml; charset=utf-8",
    );
  }
  if (url.pathname === "/sitemaps/site.xml") {
    const total = await publicPageCount(env);
    return plain(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${(total ? ["/", "/about"] : ["/about"]).map((path) => `<url><loc>${origin}${path}</loc></url>`).join("")}</urlset>`,
      "application/xml; charset=utf-8",
    );
  }
  const sitemap = /^\/sitemaps\/resources-([1-9]\d{0,5})\.xml$/.exec(
    url.pathname,
  );
  if (sitemap) {
    const pages = await publicPages(env, {
      limit: 1000,
      offset: (Number(sitemap[1]) - 1) * 1000,
    });
    if (!pages.length)
      return new Response("Sitemap not found", {
        status: 404,
        headers: securityHeaders(),
      });
    return plain(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((p) => `<url><loc>${origin}/r/${p.slug}</loc><lastmod>${p.updated_at}</lastmod></url>`).join("")}</urlset>`,
      "application/xml; charset=utf-8",
    );
  }
  if (url.pathname === "/about")
    return siteHtml(
      (nonce) => renderAbout(nonce, origin, canonical),
      canonical,
    );
  if (url.pathname === "/") {
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100),
      category = (url.searchParams.get("category") ?? "").trim().slice(0, 80);
    const page = Math.min(
      10000,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
      ),
    );
    const [pages, categories, count] = await Promise.all([
      publicPages(env, { limit: 21, offset: (page - 1) * 20, query, category }),
      publicCategories(env),
      publicPageCount(env),
    ]);
    const indexable = canonical && !url.search && count > 0;
    return siteHtml(
      (nonce) =>
        renderDirectory(
          nonce,
          origin,
          indexable,
          pages.slice(0, 20),
          categories,
          { query, category, page, hasNext: pages.length > 20 },
        ),
      indexable,
    );
  }
  const match = /^\/(r|go)\/([A-Za-z0-9_-]+)(\.md)?$/.exec(url.pathname);
  if (!match || !validSlug(match[2]) || (match[1] === "go" && match[3]))
    return html(
      { title: "资源不存在", message: "请检查领取链接是否完整。" },
      404,
    );
  const row = await findBySlug(env, match[2]);
  if (!row)
    return html(
      { title: "资源不存在", message: "请检查领取链接是否完整。" },
      404,
    );
  if (!row.enabled)
    return html(
      { title: "资源已停用", message: "分享者已暂停此资源的领取。" },
      410,
    );
  if (!row.target_url)
    return html({ row, message: "分享链接正在更新，请稍后再次打开此页面。" });
  // Revalidate stored values before public output, including after a manual database edit.
  let target: string | null;
  try {
    target = destination(row, url.origin);
  } catch {
    return html(
      {
        title: "分享链接待更新",
        message: "当前分享链接暂时无法使用，请联系分享者更新。",
      },
      503,
    );
  }
  if (match[1] === "go" && target)
    return new Response(null, {
      status: 302,
      headers: { ...securityHeaders(), Location: target },
    });
  const page = await findPage(env, row.id);
  if (page && publishable(row, page)) {
    const doc = page.document!;
    if (match[3])
      return new Response(landingMarkdown(row, page, origin), {
        headers: {
          ...securityHeaders(),
          "Content-Type": "text/markdown; charset=utf-8",
          Link: `<${origin}/r/${row.slug}>; rel="canonical"`,
        },
      });
    const related = (
      await publicPages(env, { category: doc.source.category, limit: 5 })
    )
      .filter((p) => p.link_id !== row.id)
      .slice(0, 4);
    return siteHtml(
      (nonce) => renderLanding(nonce, row, page, origin, canonical, related),
      canonical,
    );
  }
  if (match[3])
    return html(
      { title: "内容尚未发布", message: "此资源暂未发布完整说明。" },
      404,
    );
  return html({ row, available: true });
}

function canonicalOrigin(env: Env): string {
  let url: URL;
  try {
    url = new URL(env.PUBLIC_ORIGIN);
  } catch {
    throw new HttpError(503, "PUBLIC_ORIGIN_REQUIRED", "公开域名尚未配置。");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new HttpError(503, "PUBLIC_ORIGIN_REQUIRED", "公开域名配置不正确。");
  return url.origin;
}
function siteHtml(render: (nonce: string) => string, indexable: boolean) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  return new Response(render(nonce), {
    headers: {
      ...securityHeaders(),
      ...pageHeaders(nonce),
      "X-Robots-Tag": indexable
        ? "index, follow, max-snippet:-1, max-image-preview:large"
        : "noindex, follow",
    },
  });
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(flushIndexNow(env));
  },
  async fetch(request: Request, env: Env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const key = indexNowKeyResponse(request, env);
    if (key) return key;
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    try {
      const content = isApi
        ? await api(request, env, url)
        : await publicPage(request, env, url);
      const response = searchVerification(request, content, env);
      if (isApi && request.method === "PUT" && response.ok)
        ctx.waitUntil(flushIndexNow(env).catch(() => {}));
      return request.method === "HEAD"
        ? new Response(null, {
            status: response.status,
            headers: response.headers,
          })
        : response;
    } catch (error) {
      if (isApi) {
        const issue =
          error instanceof HttpError
            ? error
            : new HttpError(
                503,
                "SERVICE_UNAVAILABLE",
                "服务暂时无法读取，请稍后重试；保存请求请继续使用原 operationId。",
              );
        return json(
          { error: { code: issue.code, message: issue.message } },
          issue.status,
          issue.status === 401 ? { "WWW-Authenticate": "Bearer" } : {},
        );
      }
      return html(
        {
          title: "暂时无法读取资源",
          message: "服务暂时不可用，请稍后刷新此页面。",
        },
        503,
      );
    }
  },
} satisfies ExportedHandler<Env>;
