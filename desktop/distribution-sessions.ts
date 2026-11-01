import { BrowserWindow, dialog, session } from "electron";
import { createHash } from "node:crypto";
import {
  distributionPlatform,
  type DistributionPlatformId,
} from "../shared/distribution";
import type { AppPorts } from "../core/ports";
import { AppError } from "../core/errors";
import { setTimeout as wait } from "node:timers/promises";
import {
  distributionFormScript,
  distributionFillScript,
  distributionClickScript,
  distributionReceipt,
  type DistributionFormState,
} from "./distribution-page";
import { yisoPageScript, type YisoPageResult } from "./yiso-distribution-page";
import { PikasooDistributionSession } from "./pikasoo-distribution-session";
import type {
  DistributionReadiness,
  DistributionSubmitResult,
} from "../shared/distribution";

/** One persistent website session per workspace and platform; no account pool. */
export function createDistributionSessions(
  workspace: () => string,
): NonNullable<AppPorts["distributionSessions"]> {
  const windows = new Map<string, BrowserWindow>();
  const workers = new Set<BrowserWindow>();
  let yisoWorker: BrowserWindow | undefined;
  const profile = (platformId: DistributionPlatformId) => {
    const key = createHash("sha256")
      .update(`${workspace()}\0distribution\0${platformId}`)
      .digest("hex")
      .slice(0, 24);
    const value = session.fromPartition(`persist:panxu-distribution-${key}`);
    value.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    value.setPermissionCheckHandler(() => false);
    return { key, profile: value };
  };
  const pikasoo = new PikasooDistributionSession(
    () => profile("pikasoo"),
    (url) => allowedNavigation("pikasoo", url),
  );
  const withWorker = async <T>(
    platformId: DistributionPlatformId,
    action: (window: BrowserWindow, assertActive: () => void) => Promise<T>,
  ): Promise<T> => {
    if (platformId === "yiso") {
      const existing = windows.get(profile(platformId).key);
      if (yisoWorker || (existing && !existing.isDestroyed()))
        throw new AppError(
          "DISTRIBUTION_PAGE_BUSY",
          "易搜只允许一个投稿页，请关闭已打开的易搜官网窗口后重新准备。",
        );
    }
    const reader = new BrowserWindow({
      show: false,
      width: 1120,
      height: 800,
      webPreferences: {
        session: profile(platformId).profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    workers.add(reader);
    if (platformId === "yiso") yisoWorker = reader;
    reader.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    reader.webContents.on("will-navigate", (event, url) => {
      if (!allowedNavigation(platformId, url)) event.preventDefault();
    });
    reader.webContents.on("will-redirect", (event, url) => {
      if (!allowedNavigation(platformId, url)) event.preventDefault();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    try {
      return await Promise.race([
        action(reader, () => {
          if (!active)
            throw new AppError(
              "DISTRIBUTION_TIMEOUT",
              "平台处理窗口已超时，未继续发送。",
            );
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AppError(
                  "DISTRIBUTION_TIMEOUT",
                  "平台响应超时，已保留本地提交断点。",
                ),
              ),
            65000,
          );
        }),
      ]);
    } finally {
      active = false;
      if (timer) clearTimeout(timer);
      // Let the official page release its one-page registration through its own unload handler.
      // Unknown submissions retain the actual page, so its processing is not interrupted.
      if (
        platformId === "yiso" &&
        !reader.isDestroyed() &&
        windows.get(profile(platformId).key) !== reader
      ) {
        let releaseTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            reader.loadURL("https://yiso.fun/"),
            new Promise<void>((resolve) => {
              releaseTimer = setTimeout(resolve, 5000);
            }),
          ]);
        } catch {
        } finally {
          if (releaseTimer) clearTimeout(releaseTimer);
        }
      }
      workers.delete(reader);
      if (yisoWorker === reader) yisoWorker = undefined;
      if (
        !reader.isDestroyed() &&
        windows.get(profile(platformId).key) !== reader
      )
        reader.destroy();
    }
  };
  const loadForm = async (
    window: BrowserWindow,
    platformId: DistributionPlatformId,
  ): Promise<DistributionFormState> => {
    await window.loadURL(distributionPlatform(platformId).submitUrl);
    let state: DistributionFormState = {
      status: "unavailable",
      message: "平台表单未加载。",
    };
    for (let attempt = 0; attempt < 40; attempt++) {
      if (platformId === "yiso")
        await window.webContents.executeJavaScript(yisoPageScript("dismiss"));
      state = (await window.webContents.executeJavaScript(
        platformId === "yiso"
          ? yisoPageScript("inspect")
          : distributionFormScript(),
      )) as DistributionFormState;
      if (state.status !== "unavailable") return state;
      await wait(250);
    }
    return state;
  };
  const retainYiso = (window: BrowserWindow) => {
    if (window.isDestroyed()) return;
    const key = profile("yiso").key;
    if (windows.get(key) === window) return;
    windows.set(key, window);
    window.on("closed", () => {
      if (windows.get(key) === window) windows.delete(key);
    });
  };
  return {
    isOpen: () =>
      pikasoo.isOpen() ||
      workers.size > 0 ||
      [...windows.values()].some((window) => !window.isDestroyed()),
    async inspect(platformId) {
      if (platformId === "pikasoo") return pikasoo.inspect();
      if (distributionPlatform(platformId).format === "unverified")
        return {
          status: "rules_required",
          message: "投稿规则待登录核实，自动分发暂不可用。",
          checkedAt: new Date().toISOString(),
        };
      const state = await withWorker(platformId, (window) =>
        loadForm(window, platformId),
      );
      return {
        ...state,
        checkedAt: new Date().toISOString(),
      } as DistributionReadiness;
    },
    async continue(platformId) {
      if (platformId !== "pikasoo")
        throw new AppError(
          "DISTRIBUTION_NOT_WAITING",
          "该平台当前没有人工验证码批次。",
        );
      return pikasoo.continue();
    },
    async submit(platformId, text, beforeSubmit, signal, onWaiting) {
      if (platformId === "pikasoo")
        return pikasoo.submit(
          text,
          beforeSubmit,
          signal,
          onWaiting ?? (() => {}),
        );
      return withWorker(platformId, async (window, assertActive) => {
        const state = await loadForm(window, platformId);
        assertActive();
        signal.throwIfAborted();
        if (state.status !== "ready")
          return {
            status:
              state.status === "login_required"
                ? "login_required"
                : state.status === "verification_required"
                  ? "verification_required"
                  : "rejected",
            message: state.message,
            receipt: "",
          } as DistributionSubmitResult;
        if (platformId === "yiso") {
          await window.webContents.executeJavaScript(
            yisoPageScript("fill", text),
          );
          await wait(100);
          assertActive();
          signal.throwIfAborted();
          await beforeSubmit();
          retainYiso(window);
          try {
            await window.webContents.executeJavaScript(
              yisoPageScript("submit", text),
            );
            // The official page performs the request. No debugger, API reconstruction or token reads.
            for (let attempt = 0; attempt < 140; attempt++) {
              const result = (await window.webContents.executeJavaScript(
                yisoPageScript("result", text),
              )) as YisoPageResult;
              if (
                result?.status === "accepted" ||
                result?.status === "rejected"
              ) {
                // A timed-out outer worker already returned an unknown result to the ledger.
                // Keep its page available even if this late observer subsequently sees success.
                if (workers.has(window)) windows.delete(profile("yiso").key);
                return result;
              }
              if (result && result.status !== "ready") {
                retainYiso(window);
                return {
                  status: "uncertain",
                  message: `${result.message} 已保留官网页面，请打开投稿页核对，禁止自动重投。`,
                  receipt: "",
                };
              }
              // Once clicked, pause waits for this link's outcome instead of cancelling its request.
              await wait(250);
            }
          } catch (error) {
            retainYiso(window);
            throw error;
          }
          retainYiso(window);
          return {
            status: "uncertain",
            message:
              "易搜未返回此链接的最终处理结果。官网页面已保留，请打开投稿页核对后关闭，禁止自动重投。",
            receipt: "",
          };
        }
        await window.webContents.executeJavaScript(
          distributionFillScript(text),
        );
        await wait(100);
        signal.throwIfAborted();
        // Observe the official form's request; never reconstruct its tokens or call private APIs.
        const debug = window.webContents.debugger;
        debug.attach("1.3");
        await debug.sendCommand("Network.enable");
        let timer: ReturnType<typeof setTimeout> | undefined;
        let requestId: string | undefined,
          httpStatus = 0;
        let finish!: (result: DistributionSubmitResult) => void;
        const receipt = new Promise<DistributionSubmitResult>((resolve) => {
          finish = resolve;
          timer = setTimeout(
            () =>
              resolve({
                status: "uncertain",
                message: "未取得本批明确回执，请核对官网状态，禁止自动重投。",
                receipt: "",
              }),
            35000,
          );
        });
        const listener = (
          _event: Electron.Event,
          method: string,
          params: Record<string, any>,
        ) => {
          if (
            method === "Network.requestWillBeSent" &&
            params.request?.method === "POST" &&
            allowedNavigation(platformId, params.request.url)
          ) {
            let content = params.request.postData;
            try {
              const parsed = JSON.parse(content);
              content = parsed.text;
            } catch {
              try {
                content = new URLSearchParams(content).get("text");
              } catch {}
            }
            if (content === text) requestId = params.requestId;
          }
          if (
            requestId &&
            params.requestId === requestId &&
            method === "Network.responseReceived"
          )
            httpStatus = params.response.status;
          if (
            requestId &&
            params.requestId === requestId &&
            method === "Network.loadingFinished"
          )
            void debug
              .sendCommand("Network.getResponseBody", { requestId })
              .then((result) => {
                const body = result.base64Encoded
                  ? Buffer.from(result.body, "base64").toString("utf8")
                  : String(result.body);
                if (body.length <= 256000)
                  finish(distributionReceipt(httpStatus, body));
                else
                  finish({
                    status: "uncertain",
                    message: "平台回执过大，已停止自动判断，请核对官网结果。",
                    receipt: "",
                  });
              })
              .catch(() =>
                finish({
                  status: "uncertain",
                  message: "平台回执未能读取，请核对官网结果。",
                  receipt: "",
                }),
              );
        };
        debug.on("message", listener);
        try {
          await beforeSubmit();
          await window.webContents.executeJavaScript(
            distributionClickScript(text),
          );
          return await receipt;
        } finally {
          if (timer) clearTimeout(timer);
          debug.removeListener("message", listener);
          if (debug.isAttached()) debug.detach();
        }
      });
    },
    async open(platformId, page) {
      if (platformId === "pikasoo") return pikasoo.open();
      if (platformId === "yiso" && yisoWorker)
        throw new AppError(
          "DISTRIBUTION_PAGE_BUSY",
          "易搜正在检查或提交链接，请暂停并等待本条结果后再打开投稿页。",
        );
      const platform = distributionPlatform(platformId);
      const { key, profile: browserProfile } = profile(platformId);
      const target =
        page === "login"
          ? (platform.loginUrl ?? platform.submitUrl)
          : platform.submitUrl;
      const existing = windows.get(key);
      if (existing && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        if (existing.webContents.getURL() !== target) {
          const destination = page === "login" ? "登录页" : "投稿页";
          const choice = await dialog.showMessageBox(existing, {
            type: "question",
            title: `${platform.name} · 内容分发`,
            message: `前往${destination}？`,
            detail:
              "平台窗口正停留在其他页面。跳转可能丢失尚未提交的表单内容。",
            buttons: ["保留当前页面", `前往${destination}`],
            defaultId: 0,
            cancelId: 0,
          });
          if (choice.response === 1 && !existing.isDestroyed())
            await existing.loadURL(target);
        }
        return;
      }
      const allowed = (text: string) => allowedNavigation(platformId, text);
      const window = new BrowserWindow({
        title: `${platform.name} · 内容分发`,
        width: 1120,
        height: 800,
        minWidth: 960,
        minHeight: 640,
        autoHideMenuBar: true,
        webPreferences: {
          session: browserProfile,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      windows.set(key, window);
      window.on("closed", () => windows.delete(key));
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (allowed(url)) void window.loadURL(url).catch(() => {});
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, url) => {
        if (!allowed(url)) event.preventDefault();
      });
      window.webContents.on("will-redirect", (event, url) => {
        if (!allowed(url)) event.preventDefault();
      });
      window.webContents.on("page-title-updated", (event) =>
        event.preventDefault(),
      );
      try {
        await window.loadURL(target);
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    },
  };
}
function allowedNavigation(platformId: DistributionPlatformId, value: string) {
  try {
    const url = new URL(value),
      host = distributionPlatform(platformId).host.replace(/^www\./, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      [host, `www.${host}`].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
