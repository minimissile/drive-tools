import type { Provider } from "../../shared/types";
import type {
  ProviderShareStatistic,
  ShareMetric,
  ShareState,
} from "../../shared/share-statistics";
import { AppError } from "../errors";
import { parseShare } from "../links";
import type { JsonObject } from "./provider";

export function numericCount(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+$/.test(value))
  )
    return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
export function shareMetric(value: unknown, limited = false): ShareMetric {
  const plus = typeof value === "string" && /^\d+\+$/.test(value);
  const n = numericCount(plus ? value.slice(0, -1) : value);
  return n == null
    ? {
        value: null,
        precision: "unknown",
        reason:
          value == null ? "网盘未返回此指标" : "网盘返回值无法确认为有效次数",
      }
    : {
        value: n,
        precision: plus || limited ? "at_least" : "exact",
        ...(plus || limited
          ? { reason: "网盘返回受限计数，仅表示已知下限" }
          : {}),
      };
}
export function shareTime(value: unknown): string | null {
  if (
    value == null ||
    value === "" ||
    value === 0 ||
    value === "0" ||
    value === -1 ||
    value === "-1"
  )
    return null;
  const numeric =
    typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value));
  if (
    !numeric &&
    (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value))
  )
    return null;
  const n = numeric ? Number(value) : NaN;
  const date = new Date(numeric ? (n < 1e12 ? n * 1000 : n) : String(value));
  return Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() >= 1970 &&
    date.getUTCFullYear() < 10000
    ? date.toISOString()
    : null;
}
function shareUrl(value: unknown, provider: Provider): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const parsed = parseShare(value);
    return parsed.provider === provider ? parsed.url : null;
  } catch {
    return null;
  }
}
export function normalizeShareStatistic(
  row: JsonObject,
  provider: Provider,
): ProviderShareStatistic {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new AppError("REMOTE_SCHEMA_CHANGED", "网盘分享统计记录结构已变化。");
  const rawId =
    provider === "baidu" ? (row.shareId ?? row.shareid) : row.share_id;
  if (
    (typeof rawId !== "string" && typeof rawId !== "number") ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(String(rawId)) ||
    (typeof rawId === "number" && !Number.isSafeInteger(rawId))
  )
    throw new AppError(
      "REMOTE_SCHEMA_CHANGED",
      "网盘分享记录缺少有效分享ID，统计未更新。",
    );
  const cloud = provider === "quark" || provider === "uc";
  const createdAt = shareTime(
    cloud ? row.created_at : provider === "baidu" ? row.ctime : row.create_time,
  );
  const expiresAt = shareTime(
    cloud
      ? row.expired_at
      : provider === "baidu"
        ? (row.expiredTime ?? row.expired_time)
        : provider === "pikpak"
          ? row.expiration_at
          : row.expiration_time,
  );
  let state: ShareState = "unknown";
  if (expiresAt && Date.parse(expiresAt) < Date.now()) state = "expired";
  else if (
    (provider === "xunlei" || provider === "pikpak") &&
    typeof row.share_status === "string"
  )
    state =
      row.share_status.toUpperCase() === "OK"
        ? "active"
        : row.share_status.toUpperCase() === "EXPIRED"
          ? "expired"
          : "unavailable";
  else if (row.status != null && /^\d+$/.test(String(row.status)))
    state = Number(row.status) === (cloud ? 1 : 0) ? "active" : "unavailable";
  const pwdId =
    typeof row.pwd_id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(row.pwd_id)
      ? row.pwd_id
      : null;
  const url = shareUrl(
    cloud
      ? (row.share_url ??
          (pwdId
            ? `https://${provider === "uc" ? "drive.uc.cn" : "pan.quark.cn"}/s/${pwdId}`
            : null))
      : provider === "baidu"
        ? (row.shortlink ?? row.link)
        : row.share_url,
    provider,
  );
  let views = shareMetric(
    cloud ? row.click_pv : provider === "baidu" ? row.vCnt : row.view_count,
  );
  // The official Thunder share list renders its -1 sentinel as “100+”.
  if (
    provider === "xunlei" &&
    (row.view_count === -1 || row.view_count === "-1")
  )
    views = {
      value: 100,
      precision: "at_least",
      reason: "迅雷以100+返回浏览量，无法计算精确增量",
    };
  return {
    shareId: String(rawId),
    title: String(
      row.title ??
        row.filename ??
        row.first_file?.file_name ??
        (typeof row.typicalPath === "string"
          ? row.typicalPath.split("/").filter(Boolean).at(-1)
          : undefined) ??
        "未命名分享",
    ).slice(0, 500),
    url,
    state,
    createdAt,
    expiresAt,
    metrics: {
      views,
      saves: shareMetric(
        cloud
          ? row.save_pv
          : provider === "baidu"
            ? row.tCnt
            : row.restore_count,
      ),
      downloads: shareMetric(
        cloud
          ? row.download_pv
          : provider === "baidu"
            ? row.dCnt
            : provider === "pikpak"
              ? undefined
              : row.download_count,
        cloud && [true, 1, "1"].includes(row.download_pvlimited),
      ),
    },
  };
}
