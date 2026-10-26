import type { Page } from "playwright-core";
import { AppError } from "./errors";

/** Fetch inside the browser so cookies and the profile's proxy remain in that environment. */
export async function browserPageRequest(
  page: Page,
  url: string,
  init: RequestInit = {},
) {
  init.signal?.throwIfAborted();
  const fields: {
    name: string;
    text?: string;
    file?: { name: string; type: string; base64: string };
  }[] = [];
  if (init.body instanceof FormData) {
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
        let body: string | FormData | undefined = input.body;
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
          credentials: "include",
          signal: controller.signal,
        });
        const text = await response.text();
        if (text.length > 8_000_000)
          throw new Error("平台响应过大，请缩小查询范围。");
        return { status: response.status, body: text };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers)),
      fields,
      body: init.body instanceof FormData ? undefined : init.body?.toString(),
    },
  );
  init.signal?.throwIfAborted();
  return result;
}
