import { brandHashes, brandPng, brandSvg, faviconIco } from "./brand-assets";

export const siteName = "盘序资源";

export function organization(origin: string) {
  return {
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: siteName,
    url: origin + "/",
    logo: {
      "@type": "ImageObject",
      url: origin + "/brand.png",
      width: 256,
      height: 256,
    },
  };
}

export function website(origin: string) {
  return {
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: siteName,
    alternateName: ["盘序", "Panxu"],
    url: origin + "/",
    inLanguage: "zh-CN",
    publisher: { "@id": `${origin}/#organization` },
  };
}

/** Public, stable brand URLs must be crawlable independently of D1 and secrets. */
export function brandAsset(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  const asset =
    path === "/brand.svg"
      ? { content: brandSvg, type: "image/svg+xml", hash: brandHashes.svg, binary: false }
      : path === "/favicon.ico"
        ? { content: faviconIco, type: "image/x-icon", hash: brandHashes.ico, binary: true }
        : ["/favicon.png", "/brand.png", "/apple-touch-icon.png"].includes(path)
          ? { content: brandPng, type: "image/png", hash: brandHashes.png, binary: true }
          : null;
  if (!asset) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const etag = `"${asset.hash}"`;
  const headers = {
    "Content-Type": asset.type,
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: etag,
  };
  if (
    request.headers.get("If-None-Match")?.split(",")
      .some((tag) => [etag, `W/${etag}`, "*"].includes(tag.trim()))
  )
    return new Response(null, { status: 304, headers });
  const body = request.method === "HEAD"
    ? null
    : asset.binary
      ? Uint8Array.from(atob(asset.content), (char) => char.charCodeAt(0))
      : asset.content;
  return new Response(body, { headers });
}
