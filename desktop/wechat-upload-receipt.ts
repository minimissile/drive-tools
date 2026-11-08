import { AppError } from "../core/errors";

type JsonRecord = Record<string, unknown>;
type ReceiptDiagnostic = {
  status: "accepted" | "rejected" | "missing";
  missing: string[];
  fields: string[];
  location?: { isNumeric: boolean; length: number | null; enum?: string };
  typeEnum?: string;
};
const record = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);
const valueType = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

export class WechatImageReceiptError extends AppError {
  constructor(
    message: string,
    readonly diagnostic: ReceiptDiagnostic,
  ) {
    super("WECHAT_IMAGE_UPLOAD", message);
  }
}

function uploadedUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["mmbiz.qpic.cn", "mmbiz.qlogo.cn"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname === "/"
    )
      return null;
    url.protocol = "https:";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function uploadedId(value: unknown) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  return /^[1-9]\d{0,29}$/.test(text) ? text : null;
}

const shortEnum = (value: unknown) =>
  typeof value === "string" && /^[a-z_]{1,24}$/.test(value) ? value : undefined;

function inspectWechatImageReceipt(value: unknown) {
  const root = record(value) ? value : {};
  const ret = record(root.base_resp) ? root.base_resp.ret : undefined;
  const status: ReceiptDiagnostic["status"] =
    ret === 0 || ret === "0"
      ? "accepted"
      : ret === undefined
        ? "missing"
        : "rejected";
  const containers: { value: JsonRecord; path: string; depth: number }[] = [
    { value: root, path: "", depth: 0 },
  ];
  const urls = new Set<string>(),
    ids = new Set<string>(),
    fields: string[] = [];
  const seen = new Set<object>();
  for (const container of containers) {
    if (seen.has(container.value)) continue;
    seen.add(container.value);
    for (const [name, item] of Object.entries(container.value).slice(0, 30)) {
      const key = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
      if (fields.length < 80)
        fields.push(`${container.path}${key}:${valueType(item)}`);
      if (["cdn_url", "content", "url", "file_url"].includes(name)) {
        const url = uploadedUrl(item);
        if (url) urls.add(url);
      }
      if (["file_id", "fileid", "fileId"].includes(name)) {
        const id = uploadedId(item);
        if (id) ids.add(id);
      }
      if (
        container.depth < 2 &&
        ["data", "result", "content", "file", "base_resp"].includes(name) &&
        record(item)
      )
        containers.push({
          value: item,
          path: `${container.path}${key}.`,
          depth: container.depth + 1,
        });
    }
  }
  // Modern editor uploads return an authenticated CDN URL without a material
  // ID. location/type describe the upload shape and are never used as IDs.
  const hasLocation = Object.hasOwn(root, "location");
  const missing = [
    ...(status !== "accepted" ? ["success_status"] : []),
    ...(urls.size === 0
      ? ["image_address"]
      : urls.size > 1
        ? ["unambiguous_image_address"]
        : []),
    ...(ids.size > 1 ? ["unambiguous_material_id"] : []),
  ];
  const diagnostic: ReceiptDiagnostic = {
    status,
    missing,
    fields,
    ...(hasLocation
      ? {
          location: {
            isNumeric:
              typeof root.location === "string" && /^\d+$/.test(root.location),
            length:
              typeof root.location === "string" ? root.location.length : null,
            ...(shortEnum(root.location)
              ? { enum: shortEnum(root.location) }
              : {}),
          },
        }
      : {}),
    ...(shortEnum(root.type) ? { typeEnum: shortEnum(root.type) } : {}),
  };
  return { urls, ids, diagnostic };
}

/** Safe schema/short-enum diagnostics only; URL and credential values stay private. */
export function describeWechatImageReceipt(value: unknown) {
  return inspectWechatImageReceipt(value).diagnostic;
}

/** A successful authenticated upload plus a trusted CDN URL proves image migration. */
export function decodeWechatImageReceipt(value: unknown): {
  url: string;
  id?: string;
} {
  const { urls, ids, diagnostic } = inspectWechatImageReceipt(value);
  const { missing, status } = diagnostic;
  if (missing.length) {
    throw new WechatImageReceiptError(
      status !== "accepted"
        ? "微信未确认接收图片，请检查公众号素材权限后重试。"
        : urls.size > 1 || ids.size > 1
          ? "微信返回的图片信息存在冲突，请到官方后台核对后重试。"
          : "微信未确认图片上传：缺少有效图片地址。请重试或更换图片。",
      diagnostic,
    );
  }
  return { url: [...urls][0], ...(ids.size === 1 ? { id: [...ids][0] } : {}) };
}

/** Never invent a cover material ID; modern URL-only receipts omit that field. */
export function wechatDraftCoverFields(cover: {
  url: string;
  id?: string;
}): Record<string, string> {
  return { cdn_url0: cover.url, ...(cover.id ? { fileid0: cover.id } : {}) };
}
