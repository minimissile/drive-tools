import { BrowserWindow, type Session } from "electron";
import { websiteNavigationAllowed } from "./website-session-policy";
import { weiboStatisticsScript } from "../core/weibo/statistics-page";
import { weiboStatisticsReading } from "../shared/weibo-statistics";
import { AppError } from "../core/errors";

/** A new reader uses the account environment and never navigates an existing editor. */
export async function readNativeWeiboStatistics(
  profile: Session,
  uid: string,
  url: string,
) {
  const reader = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: profile,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  reader.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  reader.webContents.on("will-navigate", (event) => {
    if (!websiteNavigationAllowed("weibo", event.url)) event.preventDefault();
  });
  reader.webContents.on("will-redirect", (event) => {
    if (event.isMainFrame && !websiteNavigationAllowed("weibo", event.url))
      event.preventDefault();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await reader.loadURL(url);
        return weiboStatisticsReading.parse(
          await reader.webContents.executeJavaScript(
            weiboStatisticsScript(uid, url),
          ),
        );
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(
                "WEIBO_STATISTICS_TIMEOUT",
                "微博统计读取超时，请检查网络后重试；历史数据已保留。",
              ),
            ),
          30000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!reader.isDestroyed()) reader.destroy();
  }
}
