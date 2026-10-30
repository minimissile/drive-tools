import type { BrowserWindow } from "electron";
import type { Provider } from "../shared/types";
import { providerAuthAllowed, providerSpecs } from "../shared/providers";
import { AppError } from "../core/errors";
import { isAbortedNavigation } from "./website-session-policy";

/** An opened official window can keep navigating after its first load is cancelled. */
export async function loadProviderPage(
  window: BrowserWindow,
  provider: Provider,
  url: string,
) {
  if (!providerAuthAllowed(provider, url))
    throw new AppError(
      "ACCOUNT_PAGE_BLOCKED",
      "此地址不属于当前网盘的官方登录页面。",
    );
  try {
    await window.loadURL(url);
  } catch (error) {
    // Redirects, replacement navigation and closing a window cancel the old load.
    // This only means the window opened; account.check still verifies login/UID.
    if (window.isDestroyed() || isAbortedNavigation(error)) return;
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    const detail = /^ERR_[A-Z0-9_]{1,64}$/.test(code) ? `（${code}）` : "";
    throw new AppError(
      "ACCOUNT_PAGE_LOAD_FAILED",
      `${providerSpecs[provider].name}网盘官方页面加载失败${detail}，请检查网络后重新打开登录窗口。`,
    );
  }
}
