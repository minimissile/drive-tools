import type { BrowserContext } from "playwright-core";
import type { WebsiteSessionState } from "../../shared/website-accounts";
import { officialBrowserPage } from "../browser-pages";
import { AppError } from "../errors";
import { tiebaCurrentUser, tiebaHomeIdentityScript } from "./identity";

export async function verifyBitTieba(
  context: BrowserContext,
): Promise<WebsiteSessionState> {
  const page = await context.newPage();
  let blockedOrigin = "";
  try {
    // Identity reads must never follow a legacy redirect that downgrades login
    // cookies to HTTP. This guard belongs only to this disposable verifier page.
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        const target = new URL(request.url());
        if (target.origin !== "https://tieba.baidu.com") {
          blockedOrigin = target.origin;
          await route.abort();
          return;
        }
      }
      await route.continue();
    });
    const read = async (path: "/dc/common/tbs" | "/f/user/json_userinfo") => {
      const response = await page.goto(`https://tieba.baidu.com${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      if (!officialBrowserPage(page, ["tieba.baidu.com"])) {
        const target = new URL(page.url());
        const verification = [
          "passport.baidu.com",
          "wappass.baidu.com",
        ].includes(target.hostname);
        throw new AppError(
          "TIEBA_IDENTITY_LOAD",
          verification
            ? "贴吧要求重新登录或安全验证，请在官方窗口完成后重试。"
            : `贴吧身份接口跳转到 ${target.origin}，未能核实账号，请稍后重试。`,
        );
      }
      if (!response?.ok())
        throw new AppError(
          "TIEBA_IDENTITY_HTTP",
          `贴吧${path === "/dc/common/tbs" ? "登录状态" : "当前账号"}接口返回 HTTP ${response?.status() ?? "未知"}，请稍后重试或在官方窗口完成验证。`,
        );
      return page.evaluate(`(() => {
      const text = document.body?.innerText ?? '';
      if (text.length > 128000) throw Error('贴吧身份响应异常');
      let data;
      try { data = JSON.parse(text); } catch {
        throw Error('贴吧身份接口未返回账号数据，请在官方窗口完成登录或安全验证后重试');
      }
      ${
        path === "/dc/common/tbs"
          ? `if ([true, 1, '1'].includes(data.is_login)) return true;
             if ([false, 0, '0'].includes(data.is_login)) return false;
             throw Error('贴吧登录状态响应已变化，请稍后重试');`
          : `const currentUser = (${tiebaCurrentUser.toString()});
             return currentUser(data.data?.user) ?? currentUser(data.data);`
      }
    })()`);
    };
    const response = await page.goto("https://tieba.baidu.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (!response?.ok() || !officialBrowserPage(page, ["tieba.baidu.com"]))
      throw new AppError(
        "TIEBA_LOGIN_REQUIRED",
        "请在关联的指纹环境中完成贴吧登录或安全验证后重试。",
      );
    // Navigate the browser to official JSON documents: keeps its proxy, cookies and
    // browser request fingerprint, without depending on the home page's fetch/CSP.
    const viewer = (await page.evaluate(
      tiebaHomeIdentityScript(),
    )) as ReturnType<typeof tiebaCurrentUser>;
    let identity: {
      uid: string;
      nickname: string;
    } | null = viewer;
    let viewerError: unknown;
    if (!identity) {
      try {
        identity = (await read("/f/user/json_userinfo")) as ReturnType<
          typeof tiebaCurrentUser
        >;
      } catch (error) {
        viewerError = error;
      }
    }
    // This endpoint has no target user parameter: a valid UID belongs to the
    // signed-in viewer. The auxiliary TBS endpoint must not gate this proof.
    if (!identity) {
      let loggedIn: boolean;
      try {
        loggedIn = (await read("/dc/common/tbs")) as boolean;
      } catch (error) {
        throw viewerError ?? error;
      }
      if (loggedIn) {
        if (!viewer)
          throw new AppError(
            "TIEBA_UID_UNAVAILABLE",
            "未能读取贴吧当前账号的 UID，请在官方窗口完成登录或验证后重试。",
          );
        identity = viewer;
      }
    }
    return {
      hasSession: !!identity,
      uid: identity?.uid ?? null,
      nickname: identity?.nickname ?? null,
      checkedAt: new Date().toISOString(),
      windowOpen: false,
      expired: !identity,
      error: identity
        ? null
        : "贴吧尚未登录，请打开此账号的指纹窗口登录后再检查。",
    };
  } catch (error) {
    if (blockedOrigin)
      throw new AppError(
        "TIEBA_IDENTITY_REDIRECT",
        blockedOrigin === "http://tieba.baidu.com"
          ? "贴吧旧身份接口要求使用 HTTP，已停止读取。请在官方 HTTPS 首页完成登录后重试。"
          : "贴吧要求重新登录或安全验证，请在官方窗口完成后重试。",
      );
    if (error instanceof AppError) throw error;
    throw new AppError(
      "TIEBA_IDENTITY_FAILED",
      "贴吧身份检查未完成，请检查此指纹环境的网络并在官方窗口完成登录或安全验证后重试。",
    );
  } finally {
    await page.close().catch(() => {});
  }
}
