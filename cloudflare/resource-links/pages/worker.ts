/** Keep all public paths and authenticated APIs on the Pages origin. */
export default {
  async fetch(request, env) {
    try {
      // A service binding invokes the existing Worker inside Cloudflare. No
      // browser or server-side HTTP request to its workers.dev hostname occurs.
      return await env.RESOURCE_LINKS.fetch(request);
    } catch {
      const headers = {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "X-Content-Type-Options": "nosniff",
      };
      return new URL(request.url).pathname.startsWith("/api/")
        ? Response.json(
            {
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "固定入口服务暂时无法连接，请稍后重试。",
              },
            },
            { status: 503, headers },
          )
        : new Response(
            '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>暂时无法访问</title><h1>资源暂时无法读取</h1><p>请稍后重新打开此链接。</p></html>',
            {
              status: 503,
              headers: {
                ...headers,
                "Content-Type": "text/html; charset=utf-8",
              },
            },
          );
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
