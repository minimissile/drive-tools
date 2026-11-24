import { AppError } from "./errors";

/** Keep transport diagnostics useful without logging URLs, headers or credentials. */
export function resourceLinkNetworkError(
  cause: unknown,
  method: string,
  path: string,
  signal: AbortSignal,
) {
  const service = path.startsWith("/api/pages/")
    ? "落地页"
    : path.startsWith("/api/catalogs/")
      ? "清单站点"
      : "固定入口";
  let code = "UNKNOWN",
    timeout = signal.aborted && signal.reason?.name === "TimeoutError";
  const seen = new Set<unknown>();
  for (
    let error = cause, depth = 0;
    error && typeof error === "object" && depth < 5 && !seen.has(error);
    depth++
  ) {
    seen.add(error);
    const item = error as {
      name?: string;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    timeout ||= item.name === "TimeoutError";
    const match =
      typeof item.message === "string"
        ? item.message.match(/\b(?:net::)?(ERR_[A-Z_]+)\b/)
        : null;
    const candidate = typeof item.code === "string" ? item.code : match?.[1];
    if (candidate && /^(?:ERR_|UND_ERR_)?[A-Z][A-Z0-9_]{1,70}$/.test(candidate))
      code = candidate;
    error = item.cause;
  }
  timeout ||= /TIMEOUT|TIMEDOUT/.test(code);
  const reason = timeout
    ? "响应超时"
    : /PROXY|TUNNEL|SOCKS/.test(code)
      ? "代理连接失败"
      : /NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(code)
        ? "域名解析失败"
        : /CERT_|SSL_|TLS_/.test(code)
          ? "安全连接失败"
          : "连接中断";
  const write = method !== "GET";
  const error = new AppError(
    "RESOURCE_LINK_NETWORK",
    `${service}服务${reason}。${
      write
        ? "暂时无法确认同步结果，请读取云端状态或重试原操作，原入口地址保留。"
        : "请检查网络和系统代理后重试。"
    }`,
    write,
    { service, requestMethod: method, networkCode: code, timedOut: !!timeout },
  );
  Object.defineProperty(error, "cause", { value: cause });
  return error;
}
