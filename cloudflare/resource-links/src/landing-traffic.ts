import {
  landingTrafficEventSchema,
  landingTrafficSchema,
  landingReferrerRules,
} from "../../../shared/landing-traffic";
import type { Env } from "./types";
import { HttpError } from "./types";
import { findById, findBySlug } from "./store";
import { findPage, publicPageCount } from "./landing-store";
import { publishable } from "./landing-eligibility";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

export async function recordTraffic(
  request: Request,
  env: Env,
  read: () => Promise<unknown>,
) {
  const url = new URL(request.url);
  if (request.method !== "POST")
    return new Response(null, {
      status: 405,
      headers: { ...headers, Allow: "POST" },
    });
  if (
    url.origin !== env.PUBLIC_ORIGIN ||
    request.headers.get("Origin") !== url.origin ||
    request.headers.get("Sec-Fetch-Site") !== "same-origin"
  )
    return new Response(null, { status: 403, headers });
  // Anonymous ingestion is bounded per location; hitting the ceiling never blocks reading or downloads.
  const limit = await env.LANDING_EVENTS_LIMITER.limit({
    key: "panxu-resource-links:events",
  });
  if (!limit.success) return new Response(null, { status: 429, headers });
  const event = landingTrafficEventSchema.safeParse(await read());
  if (!event.success) return new Response(null, { status: 400, headers });
  const { path, kind, channel } = event.data;
  if (path === "/") {
    if (kind !== "view" || !(await publicPageCount(env)))
      return new Response(null, { status: 404, headers });
  } else {
    const link = await findBySlug(env, path.slice(3));
    if (!link || !publishable(link, await findPage(env, link.id)))
      return new Response(null, { status: 404, headers });
  }
  await env.DB.prepare(
    `INSERT INTO landing_traffic_daily(day,path,channel,kind,events)
    VALUES(strftime('%Y-%m-%d','now'),?1,?2,?3,1)
    ON CONFLICT(day,path,channel,kind) DO UPDATE SET events=events+1`,
  )
    .bind(path, channel, kind)
    .run();
  return new Response(null, { status: 204, headers });
}

export async function readTraffic(env: Env, id: string) {
  const link = await findById(env, id);
  if (!link) throw new HttpError(404, "NOT_FOUND", "资源入口不存在。");
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 27 * 86400000).toISOString().slice(0, 10);
  const meta = await env.DB.prepare(
    "SELECT tracking_since FROM landing_traffic_meta WHERE id=1",
  ).first<{ tracking_since: string }>();
  if (!meta)
    throw new HttpError(
      503,
      "TRAFFIC_NOT_READY",
      "访问统计尚未部署，请先更新固定入口服务。",
    );
  const { results } = await env.DB.prepare(
    `SELECT channel,
    sum(CASE WHEN kind='view' THEN events ELSE 0 END) AS views,
    sum(CASE WHEN kind='outbound' THEN events ELSE 0 END) AS outbound,
    sum(CASE WHEN kind='copy' THEN events ELSE 0 END) AS copies
    FROM landing_traffic_daily WHERE path=?1 AND day>=?2 AND day<=?3 GROUP BY channel ORDER BY views DESC,channel`,
  )
    .bind(`/r/${link.slug}`, from, to)
    .all<{
      channel: string;
      views: number;
      outbound: number;
      copies: number;
    }>();
  return landingTrafficSchema.parse({
    from,
    to,
    trackingSince: meta.tracking_since,
    totals: results.reduce(
      (n, row) => ({
        views: n.views + row.views,
        outbound: n.outbound + row.outbound,
        copies: n.copies + row.copies,
      }),
      { views: 0, outbound: 0, copies: 0 },
    ),
    channels: results.map(({ channel, views, outbound }) => ({
      channel,
      views,
      outbound,
    })),
  });
}

export async function pruneTraffic(env: Env) {
  await env.DB.prepare(
    "DELETE FROM landing_traffic_daily WHERE day<date('now','-90 days')",
  ).run();
}

// No third-party scripts or tracking identifiers. One view per document, one outbound/copy event each.
export const trafficScript = `(()=>{if(navigator.doNotTrack==='1'||navigator.globalPrivacyControl)return;
const path=location.pathname,seen=new Set(),rules=${JSON.stringify(landingReferrerRules)};
let channel='direct';try{if(document.referrer){const u=new URL(document.referrer);channel=u.origin===location.origin?'internal':(rules.find(([,hosts])=>hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))?.[0]||'other');}}catch{}
function track(kind){if(seen.has(kind))return;seen.add(kind);void fetch('/events',{method:'POST',mode:'same-origin',credentials:'omit',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({path,kind,channel})}).catch(()=>{});}
if(document.visibilityState==='visible')track('view');else document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')track('view');});
document.addEventListener('click',e=>{if(e.isTrusted&&e.target instanceof Element&&e.target.closest('a[href^="/go/"]'))track('outbound');});document.addEventListener('panxu:copied',()=>track('copy'));})();`;
