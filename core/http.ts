import { AppError, ServiceHttpError } from "./errors";
export function retryAfterMilliseconds(
  value: string | null,
  at = Date.now(),
): number | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const duration = /^\d+(?:\.\d+)?$/.test(trimmed)
    ? Number(trimmed) * 1000
    : Date.parse(trimmed) - at;
  return Number.isSafeInteger(Math.ceil(duration)) && duration >= 0
    ? Math.ceil(duration)
    : null;
}
export async function readLimited(
  response: Response,
  maxBytes = 8_000_000,
): Promise<string> {
  return (await readLimitedBytes(response, maxBytes)).toString("utf8");
}
export async function readLimitedBytes(
  response: Response,
  maxBytes = 8_000_000,
): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes)
    throw new AppError(
      "RESPONSE_TOO_LARGE",
      "服务返回的数据过大，已停止读取。",
    );
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes)
        throw new AppError(
          "RESPONSE_TOO_LARGE",
          "服务返回的数据过大，已停止读取。",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeout = 30_000,
  onResponse?: (text: string, status: number) => void,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeout),
    redirect: "error",
  });
  const text = await readLimited(response);
  onResponse?.(text, response.status);
  let value: Record<string, any>;
  try {
    value = JSON.parse(text);
  } catch {
    if (response.status === 429)
      throw new ServiceHttpError(
        response.status,
        `服务请求失败（HTTP ${response.status}），服务未返回JSON错误详情。`,
        "HTTP_ERROR",
        retryAfterMilliseconds(response.headers.get("retry-after")),
      );
    throw new AppError(
      "INVALID_RESPONSE",
      `服务返回非JSON数据（HTTP ${response.status}）。`,
    );
  }
  if (!response.ok)
    throw new ServiceHttpError(
      response.status,
      `服务请求失败（HTTP ${response.status}）。${String(value.error?.message ?? value.message ?? "").slice(0, 180)}`,
      "HTTP_ERROR",
      retryAfterMilliseconds(response.headers.get("retry-after")),
    );
  return value;
}
