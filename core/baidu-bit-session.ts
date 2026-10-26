import type { BrowserContext } from "playwright-core";
import type { WebsiteAccount } from "../shared/website-accounts";
import { buildBaiduResearchRequest } from "./baidu-research";
import { browserPageRequest } from "./browser-page-request";
import {
  officialBrowserPage as official,
  findEnvironmentPage as pageFor,
} from "./browser-pages";
import { AppError } from "./errors";
import { randomUUID, createHash } from "node:crypto";

export async function bitBaiduExchange(
  context: BrowserContext,
  a: WebsiteAccount,
  spec: ReturnType<typeof buildBaiduResearchRequest>,
  file?: { name: string; bytes: Buffer },
) {
  const host = spec.host,
    cookies = await context.cookies(`https://${host}/`);
  const token = cookies.find((c) =>
    host === "cdp.baidu.com"
      ? c.name === "CPTK_590"
      : ["CPTK_3", "__cas__st__3"].includes(c.name),
  )?.value;
  if (!token || !a.uid)
    throw new AppError(
      "BAIDU_LOGIN_REQUIRED",
      "请先在此环境完成百度官方工具登录并检查身份。",
    );
  const page = await pageFor(
    context,
    `panxu:baidu-transport:${a.id}:${host}`,
    host === "cdp.baidu.com"
      ? `https://${host}/static/?targetUserId=${a.uid}`
      : `https://${host}/fc/toolscenter/orientation/kr/user/${a.uid}`,
  );
  if (!official(page, [host]))
    throw new AppError(
      "BAIDU_LOGIN_REQUIRED",
      "百度工具已跳转，请在指纹窗口完成验证。",
    );
  const headers: Record<string, string> = {};
  const capture = (request: import("playwright-core").Request) => {
    if (request.url().startsWith(`https://${host}/hairuo/request.ajax`))
      for (const [name, value] of Object.entries(request.headers()))
        if (["ds", "tk"].includes(name)) headers[name] = value;
  };
  page.on("request", capture);
  try {
    await page
      .reload({ waitUntil: "networkidle", timeout: 15000 })
      .catch(() => {});
    if (!official(page, [host]))
      throw new AppError(
        "BAIDU_LOGIN_REQUIRED",
        "百度官方工具要求重新验证，请在窗口处理后重试。",
      );
    const reqid = randomUUID(),
      url = `https://${host}/hairuo/request.ajax?${new URLSearchParams({ path: spec.path, reqid })}`;
    const fields = {
      reqid,
      userid: a.uid,
      token,
      path: spec.path,
      params: JSON.stringify(spec.params),
    };
    let body: URLSearchParams | FormData = new URLSearchParams(fields);
    if (file) {
      body = new FormData();
      for (const [key, value] of Object.entries(fields))
        body.append(key, value);
      body.append("filename", file.name);
      body.append(
        "signature",
        createHash("md5").update(file.bytes).digest("hex"),
      );
      body.append(
        "file",
        new Blob([new Uint8Array(file.bytes)], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        file.name,
      );
    }
    return {
      ...(await browserPageRequest(page, url, {
        method: "POST",
        headers: {
          ...headers,
          ...(!file
            ? {
                "Content-Type":
                  "application/x-www-form-urlencoded; charset=UTF-8",
              }
            : {}),
        },
        body,
      })),
      userId: a.uid,
    };
  } finally {
    page.removeListener("request", capture);
  }
}
