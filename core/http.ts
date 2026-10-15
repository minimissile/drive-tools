import { AppError } from "./errors";
export async function readLimited(
  response: Response,
  maxBytes = 8_000_000,
): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes)
    throw new AppError(
      "RESPONSE_TOO_LARGE",
      "服务返回的数据过大，已停止读取。",
    );
  if (!response.body) return "";
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
  return Buffer.concat(chunks).toString("utf8");
}
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeout = 30_000,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeout),
    redirect: "error",
  });
  const text = await readLimited(response);
  let value: Record<string, any>;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError(
      "INVALID_RESPONSE",
      `服务返回非JSON数据（HTTP ${response.status}）。`,
    );
  }
  if (!response.ok)
    throw new AppError(
      "HTTP_ERROR",
      `服务请求失败（HTTP ${response.status}）。${String(value.error?.message ?? value.message ?? "").slice(0, 180)}`,
    );
  return value;
}
