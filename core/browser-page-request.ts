import type { Page } from "playwright-core";
import { AppError } from "./errors";

/** Fetch inside the browser so cookies and the profile's proxy remain in that environment. */
export async function browserPageRequest(
  page: Page,
  url: string,
  init: RequestInit = {},
  options: {
    binary?: boolean;
    maxBytes?: number;
    responseHeaders?: boolean;
    credentials?: "include" | "omit";
  } = {},
) {
  init.signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  const requestedReferrer = headers.get("referer");
  let referrer: string | undefined;
  if (requestedReferrer) {
    try {
      const value = new URL(requestedReferrer);
      if (
        value.origin === new URL(page.url()).origin &&
        !value.username &&
        !value.password
      )
        referrer = value.href;
    } catch {}
  }
  for (const name of [...headers.keys()])
    if (
      [
        "cookie",
        "origin",
        "referer",
        "host",
        "user-agent",
        "content-length",
      ].includes(name) ||
      name.startsWith("sec-")
    )
      headers.delete(name);
  const fields: {
    name: string;
    text?: string;
    file?: { name: string; type: string; base64: string };
  }[] = [];
  let binaryBody: string | undefined;
  if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
    const bytes =
      init.body instanceof ArrayBuffer
        ? new Uint8Array(init.body)
        : new Uint8Array(
            init.body.buffer,
            init.body.byteOffset,
            init.body.byteLength,
          );
    if (bytes.byteLength > 50_000_000)
      throw new AppError("BROWSER_UPLOAD_LIMIT", "文件超过浏览器上传上限。");
    binaryBody = Buffer.from(bytes).toString("base64");
  } else if (init.body instanceof FormData) {
    for (const [name, value] of init.body.entries()) {
      if (typeof value === "string") fields.push({ name, text: value });
      else {
        if (value.size > 50_000_000)
          throw new AppError(
            "BROWSER_UPLOAD_LIMIT",
            "文件超过浏览器上传上限。",
          );
        fields.push({
          name,
          file: {
            name: value.name,
            type: value.type,
            base64: Buffer.from(await value.arrayBuffer()).toString("base64"),
          },
        });
      }
    }
  } else if (
    init.body &&
    typeof init.body !== "string" &&
    !(init.body instanceof URLSearchParams)
  )
    throw new AppError(
      "BROWSER_BODY_UNSUPPORTED",
      "此请求格式暂不支持浏览器传输。",
    );
  const result = await page.evaluate(
    async (input) => {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 45000);
      try {
        let body: string | FormData | Uint8Array<ArrayBuffer> | undefined =
          input.body;
        if (input.binaryBody !== undefined)
          body = Uint8Array.from(atob(input.binaryBody), (c) =>
            c.charCodeAt(0),
          );
        if (input.fields.length) {
          const form = new FormData();
          for (const field of input.fields) {
            if (field.file) {
              const bytes = Uint8Array.from(atob(field.file.base64), (char) =>
                char.charCodeAt(0),
              );
              form.append(
                field.name,
                new Blob([bytes], { type: field.file.type }),
                field.file.name,
              );
            } else form.append(field.name, field.text ?? "");
          }
          body = form;
        }
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body,
          redirect: "error",
          credentials: input.options.credentials ?? "include",
          cache: input.cache,
          referrer: input.referrer,
          signal: controller.signal,
        });
        const maxBytes = input.options.maxBytes ?? 8_000_000;
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        try {
          if (Number(response.headers.get("content-length")) > maxBytes)
            throw new Error("平台响应过大，请缩小查询范围。");
          while (reader) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes)
              throw new Error("平台响应过大，请缩小查询范围。");
            chunks.push(value);
          }
        } finally {
          await reader?.cancel().catch(() => {});
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let bodyText: string;
        if (input.options.binary) {
          let raw = "";
          for (let i = 0; i < bytes.length; i += 32768)
            raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
          bodyText = btoa(raw);
        } else bodyText = new TextDecoder().decode(bytes);
        return {
          status: response.status,
          body: bodyText,
          ...(input.options.responseHeaders
            ? { headers: Object.fromEntries(response.headers) }
            : {}),
        };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers),
      cache: init.cache,
      referrer,
      fields,
      binaryBody,
      options,
      body:
        init.body instanceof FormData || binaryBody !== undefined
          ? undefined
          : init.body?.toString(),
    },
  );
  init.signal?.throwIfAborted();
  return result;
}
