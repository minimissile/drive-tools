import {
  createTemporaryPage,
  expectTemporaryPageNavigation,
  releaseTemporaryPage,
} from "../browser-page-lifecycle";
import { captureTiebaModernPage } from "./modern-page";
import { tiebaPageError } from "./page-errors";
import type { BrowserContext, Page } from "playwright-core";
import type { WebsiteAccount } from "../../shared/website-accounts";
import { AppError } from "../errors";
import { officialBrowserPage } from "../browser-pages";
import { verifyBitTieba } from "./browser-session";

export async function assertTiebaViewer(
  context: BrowserContext,
  expectedUid: string,
) {
  const state = await verifyBitTieba(context);
  if (!state.hasSession || !state.uid)
    throw new AppError(
      "TIEBA_LOGIN_REQUIRED",
      "贴吧登录已失效，请在该账号的官方窗口重新登录。",
    );
  if (state.uid !== expectedUid)
    throw new AppError(
      "TIEBA_IDENTITY_MISMATCH",
      "贴吧当前身份与任务账号不一致，已停止执行。",
    );
}

/** All requests and navigation belong to a new disposable business page. */
export async function withTiebaBusinessPage<T>(
  context: BrowserContext,
  action: (page: Page, go: (url: string) => Promise<void>) => Promise<T>,
) {
  const page = await createTemporaryPage(context).catch((error) => {
    throw tiebaPageError(error);
  });
  captureTiebaModernPage(page);
  let blocked = false;
  try {
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        const url = new URL(request.url());
        if (
          url.origin !== "https://tieba.baidu.com" ||
          url.username ||
          url.password ||
          url.port
        ) {
          blocked = true;
          await route.abort();
          return;
        }
      }
      await route.fallback();
    });
    const go = async (url: string) => {
      try {
        const target = new URL(url);
        if (
          target.origin === "https://tieba.baidu.com" &&
          !target.username &&
          !target.password &&
          !target.port
        )
          expectTemporaryPageNavigation(page, url);
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        // Chromium can upgrade an HTTP redirect through HSTS before routing it.
        // Inspect the actual chain as well as the final document URL.
        for (
          let request = response?.request() ?? null;
          request;
          request = request.redirectedFrom()
        ) {
          const redirected = await request.response();
          const location = redirected?.headers().location;
          if (location) {
            const destination = new URL(location, request.url());
            if (
              destination.origin !== "https://tieba.baidu.com" ||
              destination.username ||
              destination.password ||
              destination.port
            )
              blocked = true;
          }
        }
        if (
          blocked ||
          !officialBrowserPage(page, ["tieba.baidu.com"]) ||
          (!response?.ok() && page.url() !== new URL(url).href)
        )
          throw new AppError(
            "TIEBA_PAGE_REDIRECT",
            "贴吧页面跳转到登录、验证或非官方地址，已停止本次执行。",
          );
        if (!response?.ok())
          throw new AppError(
            "TIEBA_PAGE_HTTP",
            `贴吧页面暂时不可用（HTTP ${response?.status() ?? "未知"}），请稍后重新检查。`,
          );
      } catch (error) {
        if (blocked)
          throw new AppError(
            "TIEBA_PAGE_REDIRECT",
            "贴吧页面要求跳转到登录、验证或非 HTTPS 地址，已停止本次执行。",
          );
        throw error;
      }
    };
    return await action(page, go);
  } catch (error) {
    throw tiebaPageError(error);
  } finally {
    await releaseTemporaryPage(page);
  }
}

export function assertTiebaAccount(
  account: WebsiteAccount,
  expectedUid: string,
) {
  if (
    account.provider !== "tieba" ||
    !/^[1-9]\d{0,19}$/.test(expectedUid) ||
    account.uid !== expectedUid
  )
    throw new AppError(
      "TIEBA_ACCOUNT_INVALID",
      "请使用已核验身份的贴吧账号执行该任务。",
    );
}
