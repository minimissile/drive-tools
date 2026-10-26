import type { BrowserContext } from "playwright-core";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../../shared/website-accounts";
import { AppError } from "../errors";
import { WeiboPublisher, type PublisherWindow } from "./browser-publisher";
import { weiboViewerScript, type WeiboViewer } from "./weibo-identity";
import {
  officialBrowserPage as official,
  findEnvironmentPage as pageFor,
} from "../browser-pages";

export const verifyBitWeibo = async (
  context: BrowserContext,
): Promise<WebsiteSessionState> => {
  const page = await context.newPage();
  try {
    const response = await page.goto("https://weibo.com/", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    const result = response?.ok()
      ? await page.evaluate<WeiboViewer>(weiboViewerScript)
      : { kind: "unknown" as const };
    return {
      hasSession: result.kind === "identity",
      uid: result.kind === "identity" ? result.identity.uid : null,
      nickname: result.kind === "identity" ? result.identity.nickname : null,
      checkedAt: new Date().toISOString(),
      windowOpen: false,
      expired: result.kind === "guest",
      error:
        result.kind === "unknown"
          ? "暂时无法核实微博身份，请检查指纹窗口的登录与网络。"
          : null,
    };
  } finally {
    await page.close().catch(() => {});
  }
};

export async function useBitWeiboPublisher<T>(
  context: BrowserContext,
  a: WebsiteAccount,
  action: (publisher: WeiboPublisher) => Promise<T>,
): Promise<T> {
  const page = await pageFor(
    context,
    `panxu:weibo:${a.id}`,
    "https://weibo.com/",
  );
  if (!official(page, ["weibo.com", "www.weibo.com"]))
    throw new AppError(
      "WEIBO_PAGE_CHANGED",
      "微博发布页已跳转，请在指纹窗口完成登录后重试。",
    );
  const cdp = await context.newCDPSession(page);
  let attached = false;
  const listeners = new Map<unknown, [string, (params: any) => void][]>();
  const bridge: PublisherWindow = {
    show: () => {
      void page.bringToFront().catch(() => {});
    },
    webContents: {
      executeJavaScript: (script) => page.evaluate(script),
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
        },
        sendCommand: (method, params) => cdp.send(method as any, params),
        on: (_event, listener) => {
          const methods = [
            "Network.requestWillBeSent",
            "Network.responseReceived",
            "Network.loadingFailed",
            "Network.loadingFinished",
          ];
          const entries: [string, (params: any) => void][] = methods.map(
            (method) => {
              const callback = (params: any) =>
                listener(undefined, method, params);
              cdp.on(method as any, callback);
              return [method, callback];
            },
          );
          listeners.set(listener, entries);
        },
        removeListener: (_event, listener) => {
          for (const [method, callback] of listeners.get(listener) ?? [])
            cdp.removeListener(method as any, callback);
          listeners.delete(listener);
        },
      },
    },
  };
  try {
    return await action(
      new WeiboPublisher(
        async () => bridge,
        async () => {
          const state = await verifyBitWeibo(context);
          if (!state.hasSession || state.uid !== a.uid)
            throw new AppError(
              "WEIBO_ACCOUNT_MISMATCH",
              "指纹环境当前微博身份与任务不一致，请检查登录。",
            );
        },
      ),
    );
  } finally {
    await cdp.detach().catch(() => {});
  }
}
