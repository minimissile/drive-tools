import { pageHeaders, renderPage } from "./page";
import {
  checkConnection,
  findById,
  findBySlug,
  putLink,
  remoteLink,
} from "./store";
import { HttpError, type Env } from "./types";
import { destination, parseWrite, validId, validSlug } from "./validation";

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

async function requestJson(request: Request): Promise<unknown> {
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
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes))
    throw new HttpError(413, "BODY_TOO_LARGE", "请求内容不得超过 16KB。");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_JSON", "请求内容不能为空。");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        throw new HttpError(413, "BODY_TOO_LARGE", "请求内容不得超过 16KB。");
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
  if (request.method !== "GET")
    return html(
      { title: "无法访问此页面", message: "请通过浏览器打开资源领取链接。" },
      405,
    );
  if (url.pathname === "/")
    return html({
      title: "资源领取",
      message: "请打开分享者提供的完整领取链接，查看资源及网盘地址。",
    });
  const match = /^\/(r|go)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (!match || !validSlug(match[2]))
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
  return html({ row, available: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    try {
      return isApi
        ? await api(request, env, url)
        : await publicPage(request, env, url);
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
