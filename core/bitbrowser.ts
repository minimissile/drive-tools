import { chromium, type BrowserContext } from "playwright-core";
import type { BrowserBinding } from "../shared/types";
import { validateEditorUrl, validateLoopback } from "./links";
import { AppError } from "./errors";
import { fetchJson } from "./http";
import { platformSpecs } from "../shared/platforms";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
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
    private lease?: <T>(binding: BrowserBinding, action: () => Promise<T>) => Promise<T>,
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
  async environmentConfiguration(profileId: string) {
    const response = await this.call("/browser/detail", { id: profileId });
    const data = response.data;
    if (!data || data.id !== profileId || !data.browserFingerPrint || typeof data.browserFingerPrint !== "object") throw new AppError("BIT_PROFILE_INVALID", "比特未返回完整环境配置，请确认配置仍存在且具有访问权限。");
    if (data.isDynamicIpChangeIp === true) throw new AppError("BIT_ROTATING_PROXY", "此环境会在打开时更换代理 IP，请在比特客户端关闭自动换 IP 后重试。");
    // Whitelist configuration only: never retain or return profile cookies or saved website credentials.
    const fingerprint = Object.fromEntries(Object.entries(data.browserFingerPrint).filter(([key]) => !["id", "seq", "browserId", "createdBy", "createdTime", "updateBy", "updateTime"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
    const config = { proxyMethod: data.proxyMethod, proxyType: data.proxyType, host: data.host, port: data.port, proxyUserName: data.proxyUserName, proxyPassword: data.proxyPassword, dynamicIpUrl: data.dynamicIpUrl, isGlobalProxyInfo: data.isGlobalProxyInfo, fingerprint };
    return { signature: createHash("sha256").update(JSON.stringify(config)).digest("hex"), proxy: data.proxyType === "noproxy" ? "direct" as const : "configured" as const, stopWhileNetError: data.stopWhileNetError === true };
  }
  async environmentExitIp(profileId: string) {
    return this.withProfile(profileId, async (context) => {
      const page = await context.newPage();
      try {
        const response = await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 15000 });
        const text = await response?.text();
        if (!response?.ok() || !text || text.length > 200) throw new AppError("ENVIRONMENT_NETWORK_UNKNOWN", "指纹环境出口检查失败，请在客户端检查代理。");
        const ip = JSON.parse(text).ip;
        if (typeof ip !== "string" || !isIP(ip)) throw new AppError("ENVIRONMENT_NETWORK_UNKNOWN", "指纹环境未返回有效出口 IP。");
        return ip;
      } finally { await page.close().catch(() => {}); }
    });
  }
  async assertProfileIdle(profileId: string) {
    const response = await this.call("/browser/pids", { ids: [profileId] });
    if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) throw new AppError("BIT_PROFILE_STATUS_UNKNOWN", "无法确认指纹环境是否已关闭，请检查比特连接后重试。");
    if (Number(response.data[profileId]) > 0) throw new AppError("ENVIRONMENT_WINDOW_OPEN", "请先关闭此指纹环境的浏览器窗口，再修改配置或迁移账号；登录状态会保留。");
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
    await this.withContext(binding, async (context) => {
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
          ? await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")
          : "";
      assertEditorPage(editor, current, extensionText.slice(0, 12000), navigation?.status());
    });
    return { opened: true, url: editor };
  }
  async withContext<T>(binding: BrowserBinding, action: (context: BrowserContext) => Promise<T>): Promise<T> {
    validateEditorUrl(binding.platform, binding.editorUrl);
    const run = () => this.withProfile(binding.windowId, action);
    return this.lease ? this.lease(binding, run) : run();
  }
  async withProfile<T>(profileId: string, action: (context: BrowserContext) => Promise<T>): Promise<T> {
    const response = await this.call("/browser/open", {
      id: profileId,
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
      return await action(context);
    } finally {
      await browser.close();
    } // CDP disconnects the client; the existing BitBrowser window is not closed.
  }
}
