import { AppError } from "../core/errors";
const endpoints = new Set([
  "fetch_search",
  "fetch_home_feed",
  "fetch_user_post_list",
  "fetch_hashtag_post_list",
  "fetch_post_comment_list",
]);
export function pipixNetworkTarget(raw: string, method: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.tikhub.io" ||
    url.username ||
    url.password ||
    url.port ||
    method.toUpperCase() !== "GET" ||
    !(
      url.pathname === "/" ||
      (url.pathname.startsWith("/api/v1/pipixia/app/") &&
        endpoints.has(url.pathname.slice("/api/v1/pipixia/app/".length)))
    )
  )
    throw new AppError(
      "PIPIX_NETWORK_TARGET",
      "数据源网络请求不在允许的TikHub读取范围内。",
    );
  return url;
}
