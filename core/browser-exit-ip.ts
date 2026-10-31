import { isIP } from "node:net";
import type { BrowserContext } from "playwright-core";
import { AppError, safeMessage } from "./errors";

const sources = [
  { url: "https://myip.ipip.net/", format: "ipip" },
  { url: "https://api.ipify.org/?format=json", format: "json" },
] as const;

/** Probe inside the actual profile. An unavailable probe never selects a native request. */
export async function browserExitIp(context: BrowserContext) {
  const errors: string[] = [];
  for (const source of sources) {
    const page = await context.newPage();
    const host = new URL(source.url).hostname;
    try {
      const response = await page.goto(source.url, {
        waitUntil: "domcontentloaded",
        timeout: 8000,
      });
      if (new URL(page.url()).origin !== new URL(source.url).origin)
        throw new Error("出口检查被重定向或被浏览器扩展拦截");
      if (!response?.ok())
        throw new Error(`HTTP ${response?.status() ?? "未知"}`);
      const body = await response.text();
      if (!body || body.length > 1024) throw new Error("出口服务响应格式异常");
      const ip: unknown =
        source.format === "json"
          ? JSON.parse(body).ip
          : body.match(/^当前 IP[：:]\s*([\da-fA-F:.]+)\s+来自于[：:]/)?.[1];
      if (typeof ip !== "string" || !isIP(ip))
        throw new Error("未返回有效出口 IP");
      return ip;
    } catch (error) {
      errors.push(
        `${host}：${safeMessage(error)
          .split("\n")[0]
          .replace(/\u001b\[[\d;]*m/g, "")}`,
      );
    } finally {
      await page.close().catch(() => {});
    }
  }
  throw new AppError(
    "ENVIRONMENT_NETWORK_UNKNOWN",
    `无法确认比特环境的实际出口。${errors.join("；")}。请检查环境网络后重试。`,
  );
}
