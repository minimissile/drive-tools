import type { Env } from "./types";

export function indexNowConfig(env: Env) {
  const key = env.INDEXNOW_KEY;
  if (!key || !/^[a-zA-Z0-9-]{8,128}$/.test(key) || !env.PUBLIC_ORIGIN)
    return null;
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    return null;
  return {
    key,
    origin: origin.origin,
    host: origin.hostname,
    keyLocation: `${origin.origin}/${key}.txt`,
  };
}
export function indexNowKeyResponse(
  request: Request,
  env: Env,
): Response | null {
  const config = indexNowConfig(env),
    url = new URL(request.url);
  if (
    !config ||
    url.origin !== config.origin ||
    url.pathname !== `/${config.key}.txt`
  )
    return null;
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  return new Response(request.method === "HEAD" ? null : config.key, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
interface Submission {
  path: string;
  revision: number;
  attempts: number;
}
export async function flushIndexNow(
  env: Env,
  send: typeof fetch = (...args) => globalThis.fetch(...args),
) {
  const config = indexNowConfig(env);
  if (!config) return;
  const { results } = await env.DB.prepare(
    "SELECT path,revision,attempts FROM indexnow_submissions WHERE status='pending' AND next_attempt_at<=?1 ORDER BY updated_at LIMIT 100",
  )
    .bind(Date.now())
    .all<Submission>();
  const rows = results.filter(
    (r) =>
      r.path === "/" ||
      r.path === "/about" ||
      r.path === "/catalogs" ||
      /^\/(?:r|c)\/[A-Za-z0-9_-]{8,32}$/.test(r.path),
  );
  if (!rows.length) return;
  let status = 0;
  for (const endpoint of [
    "https://api.indexnow.org/indexnow",
    "https://www.bing.com/indexnow",
  ]) {
    try {
      const response = await send(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          host: config.host,
          key: config.key,
          keyLocation: config.keyLocation,
          urlList: rows.map((r) => config.origin + r.path),
        }),
        // Workers supports manual/follow; manual also prevents key forwarding.
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      status = response.status;
      await response.body?.cancel();
      break;
    } catch {
      /* A network failure can use the other official IndexNow endpoint. */
    }
  }
  const accepted = status === 200 || status === 202;
  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        "UPDATE indexnow_submissions SET status=?1,attempts=attempts+1,next_attempt_at=?2,http_status=?3,submitted_at=CASE WHEN ?4=1 THEN ?5 ELSE submitted_at END WHERE path=?6 AND revision=?7 AND status='pending'",
      ).bind(
        accepted ? "submitted" : "pending",
        accepted
          ? 0
          : Date.now() +
              Math.min(21600000, 60000 * 2 ** Math.min(row.attempts, 9)),
        status || null,
        Number(accepted),
        new Date().toISOString(),
        row.path,
        row.revision,
      ),
    ),
  );
}
