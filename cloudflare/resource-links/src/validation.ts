import { HttpError, providers, type LinkWrite, type Provider } from "./types";

const identifierPattern = /^[A-Za-z0-9_-]{8,128}$/;
const slugPattern = /^[A-Za-z0-9_-]{8,32}$/;
const operationPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controls = /[\u0000-\u001f\u007f]/;
const hosts: Readonly<Record<string, Provider>> = {
  "pan.quark.cn": "quark",
  "pan.baidu.com": "baidu",
  "yun.baidu.com": "baidu",
  "drive.uc.cn": "uc",
  "pan.uc.cn": "uc",
  "fast.uc.cn": "uc",
  "pan.xunlei.com": "xunlei",
  "guangyapan.com": "guangya",
  "www.guangyapan.com": "guangya",
  "mypikpak.com": "pikpak",
};

function invalid(message: string): never {
  throw new HttpError(400, "INVALID_INPUT", message);
}

export function validId(value: string): boolean {
  return identifierPattern.test(value);
}

export function validSlug(value: string): boolean {
  return slugPattern.test(value);
}

/** Accept only a single official share URL, never an arbitrary redirect target. */
export function shareTarget(
  value: string,
  provider: Provider,
  code: string,
  origin: string,
): URL {
  if (value.length > 2048 || controls.test(value) || value !== value.trim()) {
    return invalid("网盘分享链接格式不正确。");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("请填写完整的 HTTPS 网盘分享链接。");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.origin === origin ||
    hosts[url.hostname] !== provider ||
    value.includes("\\")
  ) {
    return invalid(
      "目标必须是所选网盘的官方 HTTPS 分享链接，不能包含凭据、端口或片段。",
    );
  }
  const baiduInit = provider === "baidu" && url.pathname === "/share/init";
  if (!/^\/s\/[A-Za-z0-9_-]{1,256}\/?$/.test(url.pathname) && !baiduInit) {
    return invalid("仅支持网盘的分享页面地址。");
  }
  const allowed = baiduInit
    ? ["surl", "pwd"]
    : provider === "guangya"
      ? ["code", "pwd"]
      : ["pwd"];
  const seen = new Set<string>();
  for (const [key, item] of url.searchParams) {
    if (
      !allowed.includes(key) ||
      seen.has(key) ||
      controls.test(item) ||
      item.length > 256
    ) {
      return invalid("分享链接包含重复或不支持的查询参数。");
    }
    seen.add(key);
  }
  if (
    baiduInit &&
    !/^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get("surl") ?? "")
  ) {
    return invalid("百度分享链接缺少有效的分享 ID。");
  }
  const embeddedCodes = [
    url.searchParams.get("pwd"),
    url.searchParams.get("code"),
  ].filter((item) => item !== null);
  if (embeddedCodes.length > 1 || embeddedCodes.some((item) => item !== code)) {
    return invalid("链接中的提取码与单独填写的提取码不一致。");
  }
  return url;
}

export function parseWrite(value: unknown, origin: string): LinkWrite {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("请求内容必须是 JSON 对象。");
  const body = value as Record<string, unknown>;
  const fields = [
    "operationId",
    "expectedRevision",
    "slug",
    "title",
    "provider",
    "targetUrl",
    "code",
    "enabled",
  ];
  if (
    Object.keys(body).some((field) => !fields.includes(field)) ||
    fields.some((field) => !(field in body))
  ) {
    return invalid("请求字段不完整或包含未知字段。");
  }
  if (
    typeof body.operationId !== "string" ||
    !operationPattern.test(body.operationId)
  )
    return invalid("operationId 必须是 UUID。");
  if (
    typeof body.expectedRevision !== "number" ||
    !Number.isInteger(body.expectedRevision) ||
    body.expectedRevision < 0 ||
    body.expectedRevision >= 2_147_483_647
  ) {
    return invalid("expectedRevision 必须是有效的非负整数。");
  }
  if (typeof body.slug !== "string" || !validSlug(body.slug))
    return invalid("短码须为 8 至 32 位字母、数字、下划线或连字符。");
  if (
    typeof body.title !== "string" ||
    !body.title.trim() ||
    body.title.length > 200 ||
    controls.test(body.title)
  )
    return invalid("资源名称须为 1 至 200 个字符，不能包含控制字符。");
  if (
    typeof body.provider !== "string" ||
    !(providers as readonly string[]).includes(body.provider)
  )
    return invalid("不支持此网盘类型。");
  if (
    typeof body.code !== "string" ||
    body.code.length > 128 ||
    controls.test(body.code)
  )
    return invalid("提取码不得超过 128 个字符或包含控制字符。");
  if (typeof body.enabled !== "boolean")
    return invalid("enabled 必须是布尔值。");
  if (body.targetUrl !== null && typeof body.targetUrl !== "string")
    return invalid("targetUrl 必须是分享链接或 null。");
  if (body.targetUrl !== null)
    shareTarget(
      body.targetUrl as string,
      body.provider as Provider,
      body.code,
      origin,
    );
  return {
    operationId: body.operationId,
    expectedRevision: body.expectedRevision,
    slug: body.slug,
    title: body.title,
    provider: body.provider as Provider,
    targetUrl: body.targetUrl as string | null,
    code: body.code,
    enabled: body.enabled,
  };
}

export function destination(
  row: { target_url: string | null; provider: Provider; code: string },
  origin: string,
): string | null {
  if (row.target_url === null) return null;
  const url = shareTarget(row.target_url, row.provider, row.code, origin);
  if (row.code) {
    url.searchParams.delete("pwd");
    url.searchParams.delete("code");
    url.searchParams.set(row.provider === "guangya" ? "code" : "pwd", row.code);
  }
  return url.href;
}
