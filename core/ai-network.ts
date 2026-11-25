import { AppError } from "./errors";
import { fetchJson } from "./http";

export function openRouterTarget(raw: string, method = "GET") {
  const url = new URL(raw);
  const allowed =
    method.toUpperCase() === "GET"
      ? ["/api/v1/key", "/api/v1/models"].includes(url.pathname)
      : method.toUpperCase() === "POST" &&
        url.pathname === "/api/v1/chat/completions";
  if (
    url.origin !== "https://openrouter.ai" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowed
  )
    throw new AppError(
      "AI_NETWORK_TARGET",
      "AI网络请求不属于允许的OpenRouter接口。",
    );
  return url;
}

export function openRouterJsonRequest(
  request?: (url: string, init: RequestInit) => Promise<Response>,
): typeof fetchJson {
  if (!request) return fetchJson;
  return async (url, init = {}, timeout, onResponse) =>
    fetchJson(
      openRouterTarget(url, init.method).href,
      init,
      timeout,
      onResponse,
      request,
    );
}
