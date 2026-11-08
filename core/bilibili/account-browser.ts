import type { BrowserContext } from "playwright-core";
import type { WebsiteSessionState } from "../../shared/website-accounts";
import { AppError } from "../errors";
import { officialBrowserPage } from "../browser-pages";
import { bilibiliCurrentUser, bilibiliIdentityScript } from "./identity";

/** A disposable official API document reads identity without exposing browser credentials. */
export async function verifyBitBilibili(
  context: BrowserContext,
): Promise<WebsiteSessionState> {
  const page = await context.newPage();
  let navigationBlocked = false;
  try {
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        const url = new URL(request.url());
        if (
          url.origin !== "https://api.bilibili.com" ||
          url.pathname !== "/x/web-interface/nav"
        ) {
          navigationBlocked = true;
          await route.abort();
          return;
        }
      }
      await route.fallback();
    });
    const response = await page.goto(
      "https://api.bilibili.com/x/web-interface/nav",
      {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      },
    );
    if (!response?.ok() || !officialBrowserPage(page, ["api.bilibili.com"]))
      throw new AppError(
        "BILIBILI_IDENTITY_HTTP",
        "哔哩哔哩身份接口暂不可用，请检查关联环境网络并完成官网验证后重试。",
      );
    const identity = (await page.evaluate(
      bilibiliIdentityScript(),
    )) as ReturnType<typeof bilibiliCurrentUser>;
    return {
      hasSession: !!identity,
      uid: identity?.uid ?? null,
      nickname: identity?.nickname ?? null,
      checkedAt: new Date().toISOString(),
      windowOpen: false,
      expired: !identity,
      error: identity
        ? null
        : "哔哩哔哩尚未登录，请在此账号的官方窗口完成登录后检查。",
    };
  } catch (error) {
    return {
      hasSession: false,
      uid: null,
      unverified: true,
      windowOpen: false,
      error: navigationBlocked
        ? "哔哩哔哩要求登录或安全验证，请在官方窗口完成后重试。"
        : error instanceof AppError
          ? error.message
          : "哔哩哔哩身份检查未完成，请检查关联环境网络并完成官网验证后重试。",
    };
  } finally {
    await page.close().catch(() => {});
  }
}
