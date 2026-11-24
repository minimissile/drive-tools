import type { DriveMembership } from "../../shared/drive-membership";
import { AppError } from "../errors";
import type { JsonObject } from "./provider";
const unknown = (): DriveMembership => ({
  status: "unknown",
  tier: null,
  expiresAt: null,
});
const none = (): DriveMembership => ({
  status: "none",
  tier: null,
  expiresAt: null,
});
function validCalendarDate(year: string, month: string, day: string) {
  const text = `${year}-${month}-${day}`;
  const date = new Date(`${text}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text
  );
}

/** Provider expiry fields only: never infer from quota, cancellation or an absent field. */
export function membershipExpiry(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim();
  let time: number;
  const date = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text);
  if (date) {
    const [, year, month, day] = date;
    if (!validCalendarDate(year, month, day)) return null;
    time = Date.parse(`${year}-${month}-${day}T23:59:59+08:00`);
  } else if (/^\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text);
    time = n < 1e11 ? n * 1000 : n;
  } else {
    const calendar = /^(\d{4})-(\d{2})-(\d{2})[T ]/.exec(text);
    if (calendar && !validCalendarDate(calendar[1], calendar[2], calendar[3]))
      return null;
    const zoned =
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;
    const local = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/;
    time = Date.parse(
      zoned.test(text)
        ? text.replace(" ", "T")
        : local.test(text)
          ? `${text.replace(" ", "T")}+08:00`
          : "",
    );
  }
  return Number.isFinite(time) &&
    time >= Date.UTC(2000, 0, 1) &&
    time < Date.UTC(10000, 0, 1)
    ? new Date(time).toISOString()
    : null;
}
function value(
  status: DriveMembership["status"],
  tier: string | null,
  expiry: unknown,
  time: number,
): DriveMembership {
  const expiresAt = membershipExpiry(expiry);
  return {
    status:
      status === "active" && expiresAt && Date.parse(expiresAt) <= time
        ? "expired"
        : status,
    tier,
    expiresAt,
  };
}
export function quarkMembership(
  data: JsonObject,
  time = Date.now(),
): DriveMembership {
  const type = String(data.member_type ?? "").toUpperCase();
  const names: Record<string, string> = {
    VIP: "VIP会员",
    SUPER_VIP: "超级会员",
    Z_VIP: "Z VIP会员",
    MINI_VIP: "MINI VIP会员",
    SVIP: "超级会员",
  };
  const expiry =
    type === "SUPER_VIP" || type === "SVIP"
      ? (data.super_vip_exp_at ?? data.exp_at)
      : type === "Z_VIP"
        ? (data.z_vip_exp_at ?? data.exp_at)
        : (data.exp_at ?? data.vip_exp_at);
  if (names[type]) return value("active", names[type], expiry, time);
  if (["NORMAL", "FREE", "NON_VIP", "NONE"].includes(type)) return none();
  return unknown();
}
/** Baidu's vip0 is a basic entitlement; 32-bit boundary values are placeholders. */
function baiduExpiry(raw: unknown) {
  const expiry = membershipExpiry(raw);
  if (!expiry) return null;
  return [2147483647, 2147483648, 4294967295].includes(
    Date.parse(expiry) / 1000,
  )
    ? null
    : expiry;
}
export function baiduMembership(
  result: JsonObject,
  time = Date.now(),
  flags?: JsonObject,
): DriveMembership {
  const bit = (raw: unknown) =>
    raw === true || raw === 1 || raw === "1"
      ? true
      : raw === false || raw === 0 || raw === "0"
        ? false
        : null;
  const vip = bit(flags?.is_vip),
    svip = bit(flags?.is_svip);
  const rows = Array.isArray(result.product_infos)
    ? result.product_infos
    : null;
  const entries = (rows ?? []).flatMap((product: any) => {
    if (!product || typeof product.product_name !== "string") return [];
    const name = product.product_name.trim();
    const paid =
      /^(?:svip|vip)(?:[1-9]\d*)?$/i.test(name) ||
      /^(?:超级会员|VIP会员|百度网盘超级会员|百度网盘VIP会员)$/i.test(name);
    const cluster = String(product.cluster ?? "");
    if (!paid || (cluster && !/^(?:s?vip|netdisk_s?vip)$/i.test(cluster)))
      return [];
    const starts = membershipExpiry(product.start_time);
    if (starts && Date.parse(starts) > time) return [];
    return [
      {
        tier: /svip|超级/i.test(name) ? "超级会员" : "VIP会员",
        expiresAt: baiduExpiry(product.end_time),
      },
    ];
  });
  const active = entries
    .filter((p) => p.expiresAt && Date.parse(p.expiresAt) > time)
    .sort(
      (a, b) =>
        Number(b.tier === "超级会员") - Number(a.tier === "超级会员") ||
        Date.parse(b.expiresAt!) - Date.parse(a.expiresAt!),
    );
  const expired = entries
    .filter((p) => p.expiresAt && Date.parse(p.expiresAt) <= time)
    .sort((a, b) => Date.parse(b.expiresAt!) - Date.parse(a.expiresAt!));
  if (svip === true || vip === true) {
    const tier = svip === true ? "超级会员" : "VIP会员";
    return {
      status: "active",
      tier,
      expiresAt: active.find((p) => p.tier === tier)?.expiresAt ?? null,
    };
  }
  if (svip === false && vip === false)
    return expired[0] ? { status: "expired", ...expired[0] } : none();
  if (active[0]) return { status: "active", ...active[0] };
  if (expired[0]) return { status: "expired", ...expired[0] };
  if (
    !rows ||
    entries.length ||
    rows.some(
      (p: any) =>
        !p ||
        typeof p.product_name !== "string" ||
        !p.product_name ||
        (/vip|会员/i.test(p.product_name) &&
          !/^vip0$/i.test(p.product_name) &&
          !/空间|容量|扩容|storage/i.test(p.product_name)),
    )
  )
    return unknown();
  return none();
}
export function pikpakMembership(
  result: JsonObject,
  uid: string | null,
  time = Date.now(),
): DriveMembership {
  const data = result.data;
  if (result.result !== "ACCEPTED" || !data || typeof data !== "object")
    return unknown();
  if (uid && data.user_id && String(data.user_id) !== uid)
    throw new AppError(
      "ACCOUNT_UID_MISMATCH",
      "会员信息与当前网盘账号不一致。",
    );
  if (data.type === "novip")
    return membershipExpiry(data.expire) &&
      Date.parse(membershipExpiry(data.expire)!) <= time
      ? value("expired", "VIP会员", data.expire, time)
      : none();
  if (data.status === "ok" && data.type)
    return value(
      "active",
      data.type === "platinum" ? "白金会员" : "VIP会员",
      data.expire,
      time,
    );
  if (
    data.status === "invalid" &&
    membershipExpiry(data.expire) &&
    Date.parse(membershipExpiry(data.expire)!) <= time
  )
    return value("expired", "VIP会员", data.expire, time);
  return unknown();
}
export function xunleiMembership(
  result: JsonObject,
  time = Date.now(),
): DriveMembership {
  if (!Array.isArray(result.vip_info)) return unknown();
  const rows = result.vip_info.filter(
    (p: any) =>
      p &&
      ((Number(p.user_vas) === 306 && Number(p.vas_type) === 5) ||
        (Number(p.user_vas) === 2 && [2, 3, 5].includes(Number(p.vas_type)))),
  );
  const knownRows = rows.filter((p: any) =>
    [0, 1, "0", "1"].includes(p.is_vip),
  );
  const parsed = knownRows.map((p: any) =>
    value(
      Number(p.is_vip) === 1 ? "active" : "none",
      Number(p.user_vas) === 306
        ? "云盘会员"
        : Number(p.vas_type) === 5
          ? "超级会员"
          : Number(p.vas_type) === 3
            ? "白金会员"
            : "VIP会员",
      p.expire_date ?? p.expire ?? p.expire_time,
      time,
    ),
  );
  const active = parsed
    .filter((p: any) => p.status === "active")
    .sort(
      (a: any, b: any) =>
        Date.parse(b.expiresAt ?? "") - Date.parse(a.expiresAt ?? ""),
    );
  if (active[0]) return active[0];
  if (
    knownRows.length !== rows.length ||
    result.vip_info.some(
      (p: any) =>
        !p ||
        p.user_vas == null ||
        p.vas_type == null ||
        ![0, 1, "0", "1"].includes(p.is_vip),
    )
  )
    return unknown();
  const expired = parsed
    .filter((p: any) => p.expiresAt && Date.parse(p.expiresAt) <= time)
    .sort(
      (a: any, b: any) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt),
    );
  if (expired[0]) return { ...expired[0], status: "expired" };
  return none();
}
export function guangyaMembership(
  data: JsonObject,
  time = Date.now(),
): DriveMembership {
  const status =
    data.svipStatus === 2 || data.vipStatus === 2
      ? "active"
      : data.svipStatus === 3 || data.vipStatus === 3
        ? "expired"
        : [data.vipStatus, data.svipStatus].some((s) => s === 0 || s === 1)
          ? "none"
          : "unknown";
  return status === "none"
    ? none()
    : status === "unknown"
      ? unknown()
      : value(
          status,
          data.svipStatus === (status === "active" ? 2 : 3)
            ? "超级会员"
            : "VIP会员",
          data.vipExpireTime,
          time,
        );
}
