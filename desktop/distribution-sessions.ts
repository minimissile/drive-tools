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
  const withWorker = async <T>(
    platformId: DistributionPlatformId,
    action: (window: BrowserWindow) => Promise<T>,
  ): Promise<T> => {
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
    reader.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    reader.webContents.on("will-navigate", (event, url) => {
      if (!allowedNavigation(platformId, url)) event.preventDefault();
    });
    reader.webContents.on("will-redirect", (event, url) => {
      if (!allowedNavigation(platformId, url)) event.preventDefault();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(reader),
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
      if (timer) clearTimeout(timer);
      workers.delete(reader);
      if (!reader.isDestroyed()) reader.destroy();
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
      state = (await window.webContents.executeJavaScript(
        distributionFormScript(),
      )) as DistributionFormState;
      if (state.status !== "unavailable") return state;
      await wait(250);
    }
    return state;
  };
  return {
    isOpen: () =>
      workers.size > 0 ||
      [...windows.values()].some((window) => !window.isDestroyed()),
    async inspect(platformId) {
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
    async submit(platformId, text, beforeSubmit, signal) {
      return withWorker(platformId, async (window) => {
        const state = await loadForm(window, platformId);
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
