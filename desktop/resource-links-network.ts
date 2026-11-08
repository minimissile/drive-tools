import { AppError } from "../core/errors";

/** Credential-bearing requests may only reach the service's narrow admin routes. */
export function resourceLinksTarget(url: string, method: string) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.port ||
    target.search ||
    target.hash ||
    !/^\/api\/(?:connection|(?:links|pages|traffic)\/[A-Za-z0-9_-]{8,128}|catalogs\/catalog_[\w-]{1,100})$/.test(
      target.pathname,
    ) ||
    !["GET", "PUT", "DELETE"].includes(method) ||
    (method === "DELETE" && !target.pathname.startsWith("/api/catalogs/")) ||
    (method === "PUT" && (target.pathname === "/api/connection" || target.pathname.startsWith("/api/traffic/")))
  )
    throw new AppError(
      "RESOURCE_LINK_REQUEST_BLOCKED",
      "固定入口请求不在允许的服务接口范围内。",
    );
  return target;
}
