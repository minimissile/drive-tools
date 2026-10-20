import { chromium } from "playwright-core";
import type { BrowserBinding } from "../shared/types";
import { validateEditorUrl, validateLoopback } from "./links";
import { AppError } from "./errors";
import { fetchJson } from "./http";
import { platformSpecs } from "../shared/platforms";
export function assertEditorPage(
  editor: string,
  current: string,
  extensionText = "",
  httpStatus = 200,
) {
  const target = new URL(editor),
    page = new URL(current);
  if (page.protocol === "chrome-extension:") {
    if (
      /实名认证/.test(extensionText) &&
      /无法访问|不支持|认证/.test(extensionText)
    )
      throw new AppError(
        "BIT_REALNAME_REQUIRED",
        "比特客户端要求实名认证后才能访问此网站。请本人在比特个人中心完成认证并检查客户端版本，再回到盘序重试；当前未进入平台编辑器。",
      );
    throw new AppError(
      "BIT_CLIENT_BLOCKED",
      "比特客户端扩展拦截了网站访问。请在已打开的指纹窗口查看具体原因，处理后回到盘序重试。",
    );
  }
  const platform = platformSpecs.find((p) => p.hosts.includes(target.hostname));
  if (
    page.protocol !== "https:" ||
    page.username ||
    page.password ||
    page.port ||
    !(platform?.hosts ?? [target.hostname]).includes(page.hostname)
  )
    throw new AppError(
      "EDITOR_REDIRECTED",
      "已打开窗口，但页面跳转到登录或其他域名，请在窗口核对平台账号后重试。",
    );
  if (httpStatus >= 400)
    throw new AppError(
      "EDITOR_HTTP_ERROR",
      `编辑器返回HTTP ${httpStatus}，页面未能正常加载。请检查平台入口，或在比特窗口查看提示后重试。`,
    );
  if (/(^|\/)(login|signin|passport|auth)(\/|$)/i.test(page.pathname))
    throw new AppError(
      "EDITOR_LOGIN_REQUIRED",
      "已打开平台登录页。请本人在指定指纹窗口完成登录，再回到盘序打开编辑器。",
    );
}
export class BitBrowser {
  constructor(
    private config: () => Promise<{ url: string; key: string | null }>,
    private requestJson = fetchJson,
  ) {}
  private async call(path: string, data: unknown = {}) {
    const config = await this.config();
    const base = validateLoopback(config.url);
    if (base.pathname !== "/" && base.pathname !== "")
      throw new AppError(
        "INVALID_LOCAL_URL",
        "比特接口应填写服务根地址，不包含路径。",
      );
    const result = await this.requestJson(
      new URL(path, base).href,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.key ? { "x-api-key": config.key } : {}),
        },
        body: JSON.stringify(data),
      },
      30_000,
    );
    if (result.success === false)
      throw new AppError(
        "BIT_ERROR",
        `比特接口未成功：${String(result.msg ?? result.message ?? "请检查客户端和权限").slice(0, 160)}`,
      );
    return result;
  }
  async health() {
    await this.call("/health");
    return { connected: true };
  }
  async windows() {
    const windows: { id: string; name: string; seq: number | null }[] = [];
    for (let page = 0; page < 30; page++) {
      const response = await this.call("/browser/list", {
        page,
        pageSize: 100,
      });
      const rows = response.data?.list ?? response.data;
      if (!Array.isArray(rows))
        throw new AppError("BIT_SCHEMA_CHANGED", "比特窗口列表格式无法识别。");
      windows.push(
        ...rows.map((r: Record<string, any>) => {
          if (!r || typeof r.id !== "string" || !r.id.trim())
            throw new AppError(
              "BIT_SCHEMA_CHANGED",
              "比特窗口缺少有效ID，未建立账号映射。",
            );
          return {
            id: r.id,
            name: String(r.name ?? r.id),
            seq: typeof r.seq === "number" ? r.seq : null,
          };
        }),
      );
      if (rows.length < 100) return windows;
    }
    throw new AppError(
      "TOO_MANY_WINDOWS",
      "指纹窗口超过3000个，未返回不完整列表，请先在比特客户端整理窗口。",
    );
  }
  async open(binding: BrowserBinding) {
    const editor = validateEditorUrl(binding.platform, binding.editorUrl);
    const response = await this.call("/browser/open", {
      id: binding.windowId,
      loadExtensions: true,
    });
    const endpoint = String(response.data?.ws ?? "");
    const debug = validateLoopback(endpoint, true);
    if (!["ws:", "wss:"].includes(debug.protocol))
      throw new AppError(
        "BIT_DEBUG_ADDRESS",
        "比特未返回本机WebSocket调试地址。",
      );
    const browser = await chromium.connectOverCDP(endpoint, {
      timeout: 15_000,
    });
    try {
      const context = browser.contexts()[0];
      if (!context)
        throw new AppError("BIT_CONTEXT_MISSING", "未连接到指定指纹窗口。");
      // Leave existing editors and unsaved drafts untouched.
      const page = await context.newPage();
      const navigation = await page.goto(editor, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.bringToFront();
      const current = page.url();
      const extensionText =
        new URL(current).protocol === "chrome-extension:"
          ? await page
              .locator("body")
              .innerText({ timeout: 3000 })
              .catch(() => "")
          : "";
      assertEditorPage(
        editor,
        current,
        extensionText.slice(0, 12000),
        navigation?.status(),
      );
    } finally {
      await browser.close();
    } // CDP disconnects the client; the existing BitBrowser window is not closed.
    return { opened: true, url: editor };
  }
}
