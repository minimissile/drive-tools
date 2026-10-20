import { createHash, createHmac } from "node:crypto";
import { AppError } from "../errors";
import type { Provider } from "../../shared/types";
export interface UploadAsset {
  name: string;
  mime: string;
  bytes: Buffer;
}
export const digest = (
  algorithm: string,
  bytes: Buffer | string,
  encoding: "hex" | "base64" = "hex",
) => createHash(algorithm).update(bytes).digest(encoding);
export function gcid(bytes: Buffer) {
  let block = 0x40000;
  while (bytes.length / block > 0x200 && block < 0x200000) block *= 2;
  const result = createHash("sha1");
  for (let offset = 0; offset < bytes.length; offset += block)
    result.update(
      createHash("sha1")
        .update(bytes.subarray(offset, offset + block))
        .digest(),
    );
  return result.digest("hex").toUpperCase();
}
const families: Record<Provider, string[]> = {
  quark: ["aliyuncs.com", "quark.cn"],
  uc: ["aliyuncs.com", "uc.cn"],
  baidu: ["pcs.baidu.com"],
  xunlei: ["xunlei.com", "sandai.net"],
  pikpak: ["mypikpak.net", "mypikpak.com", "aliyuncs.com"],
  guangya: ["aliyuncs.com", "guangyapan.com"],
};
export function storageUrl(provider: Provider, value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !families[provider].some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith("." + domain),
    )
  )
    throw new AppError(
      "INVALID_UPLOAD_HOST",
      "网盘返回了未受信任的上传地址，已停止。",
    );
  return url;
}
/** Temporary storage credentials only; never attach the account cookie/bearer token. No write retries. */
export async function storageRequest(
  provider: Provider,
  url: URL,
  init: RequestInit,
) {
  storageUrl(provider, url.href);
  try {
    const result = await fetch(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
    if (!result.ok) {
      await result.body?.cancel();
      throw new AppError(
        "UPLOAD_REJECTED",
        `存储服务返回 ${result.status}，请核对远端结果。`,
        true,
      );
    }
    return result;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      "UNCERTAIN_REMOTE_RESULT",
      "上传请求中断，远端结果待核对，未自动重试。",
      true,
    );
  }
}
function objectUrl(
  provider: Provider,
  endpoint: string,
  bucket: string,
  key: string,
) {
  if (
    !/^[a-zA-Z0-9.-]+$/.test(bucket) ||
    !key ||
    key.split("/").some((p) => p === "." || p === "..")
  )
    throw new AppError("UPLOAD_SCHEMA", "上传存储参数不完整。");
  const url = storageUrl(
    provider,
    endpoint.startsWith("https://") ? endpoint : `https://${endpoint}`,
  );
  if (!url.hostname.startsWith(bucket + "."))
    url.hostname = bucket + "." + url.hostname;
  url.pathname = "/" + key.split("/").map(encodeURIComponent).join("/");
  url.search = "";
  return storageUrl(provider, url.href);
}
export interface StorageCredentials {
  endpoint: string;
  bucket: string;
  key: string;
  accessKey: string;
  secret: string;
  token: string;
}
export async function uploadOss(
  provider: Provider,
  p: StorageCredentials,
  asset: UploadAsset,
) {
  if (!p.accessKey || !p.secret || !p.token)
    throw new AppError("UPLOAD_SCHEMA", "临时上传凭据不完整。");
  const url = objectUrl(provider, p.endpoint, p.bucket, p.key),
    date = new Date().toUTCString();
  const md5 = digest("md5", asset.bytes, "base64");
  const canonical = `PUT\n${md5}\n${asset.mime}\n${date}\nx-oss-security-token:${p.token}\n/${p.bucket}/${p.key}`;
  const authorization = `OSS ${p.accessKey}:${createHmac("sha1", p.secret).update(canonical).digest("base64")}`;
  const response = await storageRequest(provider, url, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      Date: date,
      "Content-Type": asset.mime,
      "Content-MD5": md5,
      "x-oss-security-token": p.token,
    },
    body: new Uint8Array(asset.bytes),
  });
  await response.body?.cancel();
}
export async function uploadS3(
  provider: Provider,
  p: StorageCredentials,
  asset: UploadAsset,
) {
  if (!p.accessKey || !p.secret || !p.token)
    throw new AppError("UPLOAD_SCHEMA", "临时上传凭据不完整。");
  const url = objectUrl(provider, p.endpoint, p.bucket, p.key);
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    day = date.slice(0, 8),
    hash = digest("sha256", asset.bytes);
  const scope = `${day}/xunlei/s3/aws4_request`,
    names = "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
  const headers = `host:${url.host}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\nx-amz-security-token:${p.token}\n`;
  const canonical = `PUT\n${url.pathname}\n\n${headers}\n${names}\n${hash}`;
  const sign = (key: Buffer | string, text: string) =>
    createHmac("sha256", key).update(text).digest();
  const key = sign(
    sign(sign(sign("AWS4" + p.secret, day), "xunlei"), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", key)
    .update(
      `AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest("sha256", canonical)}`,
    )
    .digest("hex");
  const response = await storageRequest(provider, url, {
    method: "PUT",
    headers: {
      "Content-Type": asset.mime,
      "x-amz-content-sha256": hash,
      "x-amz-date": date,
      "x-amz-security-token": p.token,
      Authorization: `AWS4-HMAC-SHA256 Credential=${p.accessKey}/${scope}, SignedHeaders=${names}, Signature=${signature}`,
    },
    body: new Uint8Array(asset.bytes),
  });
  await response.body?.cancel();
}
export function credentials(p: Record<string, any>): StorageCredentials {
  const nested = p.creds ?? {};
  return {
    endpoint: String(p.endpoint ?? p.fullEndPoint ?? p.endPoint ?? ""),
    bucket: String(p.bucket ?? p.bucketName ?? ""),
    key: String(p.key ?? p.objectPath ?? ""),
    accessKey: String(
      p.access_key_id ?? p.accessKeyID ?? nested.accessKeyID ?? "",
    ),
    secret: String(
      p.access_key_secret ?? p.secretAccessKey ?? nested.secretAccessKey ?? "",
    ),
    token: String(
      p.security_token ?? p.sessionToken ?? nested.sessionToken ?? "",
    ),
  };
}
