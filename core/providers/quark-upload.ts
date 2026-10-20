import { AppError } from "../errors";
import {
  digest,
  storageRequest,
  storageUrl,
  type UploadAsset,
} from "./small-upload";
import type { JsonObject } from "./provider";
export async function uploadQuark(
  provider: "quark" | "uc",
  parent: string,
  asset: UploadAsset,
  request: (path: string, body: unknown) => Promise<JsonObject>,
) {
  const pre = await request("file/upload/pre", {
    ccp_hash_update: true,
    dir_name: "",
    file_name: asset.name,
    format_type: asset.mime,
    l_created_at: Date.now(),
    l_updated_at: Date.now(),
    pdir_fid: parent,
    size: asset.bytes.length,
  });
  const p = pre.data;
  if (!p?.task_id)
    throw new AppError("UPLOAD_SCHEMA", "预上传没有返回任务标识。", true);
  const hashed = await request("file/update/hash", {
    task_id: p.task_id,
    md5: digest("md5", asset.bytes),
    sha1: digest("sha1", asset.bytes),
  });
  if (hashed.data?.finish) return;
  if (!p.bucket || !p.upload_url || !p.obj_key || !p.upload_id || !p.auth_info)
    throw new AppError("UPLOAD_SCHEMA", "预上传没有返回完整存储参数。", true);
  const endpoint = new URL(
    /^https?:/.test(p.upload_url) ? p.upload_url : `https://${p.upload_url}`,
  );
  endpoint.protocol = "https:";
  if (!endpoint.hostname.startsWith(p.bucket + "."))
    endpoint.hostname = p.bucket + "." + endpoint.hostname;
  endpoint.pathname =
    "/" + String(p.obj_key).split("/").map(encodeURIComponent).join("/");
  const url = storageUrl(provider, endpoint.href),
    ua = "aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit";
  const auth = async (
    method: string,
    mime: string,
    query: string,
    md5 = "",
    callback = "",
  ) => {
    const date = new Date().toUTCString();
    const extra =
      (callback ? `x-oss-callback:${callback}\n` : "") +
      `x-oss-date:${date}\nx-oss-user-agent:${ua}\n`;
    const result = await request("file/upload/auth", {
      task_id: p.task_id,
      auth_info: p.auth_info,
      auth_meta: `${method}\n${md5}\n${mime}\n${date}\n${extra}/${p.bucket}/${p.obj_key}?${decodeURIComponent(query)}`,
    });
    if (!result.data?.auth_key)
      throw new AppError("UPLOAD_SCHEMA", "存储授权结果不完整。", true);
    return {
      Authorization: String(result.data.auth_key),
      "Content-Type": mime,
      "x-oss-date": date,
      "x-oss-user-agent": ua,
      Referer:
        provider === "uc" ? "https://drive.uc.cn/" : "https://pan.quark.cn/",
    };
  };
  const partSize = Number(pre.metadata?.part_size ?? 4 * 1024 * 1024);
  if (
    !Number.isSafeInteger(partSize) ||
    partSize < 1024 ||
    partSize > 64 * 1024 * 1024
  )
    throw new AppError("UPLOAD_SCHEMA", "网盘返回的分片大小无效。", true);
  const parts: string[] = [];
  for (
    let offset = 0, n = 1;
    offset < asset.bytes.length;
    offset += partSize, n++
  ) {
    const query = `partNumber=${n}&uploadId=${encodeURIComponent(p.upload_id)}`;
    url.search = query;
    const response = await storageRequest(provider, url, {
      method: "PUT",
      headers: await auth("PUT", asset.mime, query),
      body: new Uint8Array(asset.bytes.subarray(offset, offset + partSize)),
    });
    const etag = response.headers.get("etag");
    await response.body?.cancel();
    if (!etag || !/^"?[a-fA-F0-9-]+"?$/.test(etag))
      throw new AppError("UPLOAD_SCHEMA", "上传分片没有返回有效 ETag。", true);
    parts.push(
      `<Part><PartNumber>${n}</PartNumber><ETag>${etag.replace(/"/g, "&quot;")}</ETag></Part>`,
    );
  }
  const xml = `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`;
  const md5 = digest("md5", xml, "base64"),
    callback = Buffer.from(JSON.stringify(p.callback)).toString("base64");
  const query = `uploadId=${encodeURIComponent(p.upload_id)}`;
  url.search = query;
  const response = await storageRequest(provider, url, {
    method: "POST",
    headers: {
      ...(await auth("POST", "application/xml", query, md5, callback)),
      "Content-MD5": md5,
      "x-oss-callback": callback,
    },
    body: xml,
  });
  // OSS may report an error in a 200 response; the authoritative final list is checked separately.
  const text = await response.text();
  if (text.includes("<Error>"))
    throw new AppError("UPLOAD_REJECTED", "存储合并未成功，请核对远端。", true);
  await request("file/upload/finish", {
    obj_key: p.obj_key,
    task_id: p.task_id,
  });
}
