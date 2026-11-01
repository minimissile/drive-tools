import { BrowserWindow, type Session } from "electron";
import { setTimeout as wait } from "node:timers/promises";
import type {
  DistributionReadiness,
  DistributionSubmitResult,
} from "../shared/distribution";
import { AppError } from "../core/errors";
import { pikasooPageScript, pikasooReceipt } from "./pikasoo-distribution-page";

interface VerificationWait {
  resolve(): void;
  reject(error: unknown): void;
  text: string;
  continuing: boolean;
}

/** One official page survives the human CAPTCHA step; no CAPTCHA travels through IPC or storage. */
export class PikasooDistributionSession {
  private window?: BrowserWindow;
  private key = "";
  private loading?: Promise<void>;
  private waiting?: VerificationWait;
  private phase: "idle" | "waiting" | "submitting" | "uncertain" = "idle";
  private managedText = "";
  private busy = false;
  constructor(
    private profile: () => { key: string; profile: Session },
    private allowed: (url: string) => boolean,
  ) {}
  isOpen() {
    return (
      this.busy ||
      !!this.loading ||
      !!(
        this.window &&
        !this.window.isDestroyed() &&
        (this.phase !== "idle" || this.window.isVisible())
      )
    );
  }
  private async getWindow() {
    const profile = this.profile();
    if (this.window && !this.window.isDestroyed() && this.key !== profile.key)
      this.window.destroy();
    if (!this.window || this.window.isDestroyed()) {
      const window = new BrowserWindow({
        title: "皮卡搜索 · 内容分发 · 人工验证码",
        show: false,
        width: 1120,
        height: 800,
        minWidth: 960,
        minHeight: 640,
        autoHideMenuBar: true,
        webPreferences: {
          session: profile.profile,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      this.window = window;
      this.key = profile.key;
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (!this.allowed(url)) event.preventDefault();
      });
      window.webContents.on("will-redirect", (event, url) => {
        if (!this.allowed(url)) event.preventDefault();
      });
      window.webContents.on("page-title-updated", (event) =>
        event.preventDefault(),
      );
      window.on("closed", () => {
        if (this.window !== window) return;
        this.window = undefined;
        this.loading = undefined;
        this.waiting?.reject(
          new AppError(
            "DISTRIBUTION_VERIFICATION_CLOSED",
            "验证码窗口已关闭，本批尚未发送；重新开始后可继续。",
          ),
        );
        this.waiting = undefined;
        this.phase = "idle";
        this.managedText = "";
      });
      const loading = window
        .loadURL("https://www.pikasoo.top/")
        .then(
          () => {},
          (error) => {
            if (!window.isDestroyed()) window.destroy();
            throw error;
          },
        )
        .finally(() => {
          if (this.loading === loading) this.loading = undefined;
        });
      this.loading = loading;
    }
    await this.loading;
    if (!this.window || this.window.isDestroyed())
      throw new AppError(
        "DISTRIBUTION_PAGE_CLOSED",
        "皮卡搜索窗口已关闭，请重试。",
      );
    return this.window;
  }
  private async ensureForm(window: BrowserWindow) {
    for (let attempt = 0; attempt < 40; attempt++) {
      await window.webContents.executeJavaScript(pikasooPageScript("open"));
      const state = (await window.webContents.executeJavaScript(
        pikasooPageScript("inspect"),
      )) as Pick<DistributionReadiness, "status" | "message">;
      if (state.status === "ready" || state.message.includes("未提交内容"))
        return state;
      await wait(250);
    }
    return {
      status: "unavailable" as const,
      message: "皮卡搜索投稿表单未能加载，请打开官网检查后重试。",
    };
  }
  async open() {
    const window = await this.getWindow();
    if (!this.busy && this.phase === "idle") await this.ensureForm(window);
    window.setTitle("皮卡搜索 · 内容分发 · 人工验证码");
    window.show();
    window.focus();
  }
  async inspect(): Promise<DistributionReadiness> {
    if (this.busy || this.phase === "uncertain")
      return {
        status: "unavailable",
        message: "皮卡搜索仍有待处理的官网页面，请先核对结果并关闭该窗口。",
        checkedAt: new Date().toISOString(),
      };
    this.busy = true;
    try {
      const window = await this.getWindow();
      if (this.managedText) {
        await window.webContents.executeJavaScript(
          pikasooPageScript("reset", "", this.managedText),
        );
        this.managedText = "";
        await wait(250);
      }
      return {
        ...(await this.ensureForm(window)),
        checkedAt: new Date().toISOString(),
      };
    } finally {
      this.busy = false;
    }
  }
  async continue() {
    const pending = this.waiting,
      window = this.window;
    if (!pending || pending.continuing || !window || window.isDestroyed())
      throw new AppError(
        "DISTRIBUTION_NOT_WAITING",
        "当前没有等待验证码的批次，请刷新进度。",
      );
    pending.continuing = true;
    try {
      await window.webContents.executeJavaScript(
        pikasooPageScript("check", pending.text),
      );
      if (this.waiting !== pending)
        throw new AppError(
          "DISTRIBUTION_STOPPED",
          "该批次已暂停或窗口已关闭。",
        );
      this.waiting = undefined;
      pending.resolve();
      return true;
    } catch (error) {
      pending.continuing = false;
      throw error;
    }
  }
  async submit(
    text: string,
    beforeSubmit: () => Promise<void>,
    signal: AbortSignal,
    onWaiting: () => void,
  ): Promise<DistributionSubmitResult> {
    if (this.busy || this.phase === "uncertain")
      throw new AppError(
        "DISTRIBUTION_PAGE_BUSY",
        "皮卡搜索仍有待处理的批次，请先核对官网。",
      );
    this.busy = true;
    let checkpoint = false,
      managed = false;
    try {
      const window = await this.getWindow();
      signal.throwIfAborted();
      await this.ensureForm(window);
      signal.throwIfAborted();
      await window.webContents.executeJavaScript(
        pikasooPageScript("fill", text, this.managedText),
      );
      managed = true;
      this.managedText = text;
      this.phase = "waiting";
      const gate = this.waitForHuman(text, signal);
      try {
        onWaiting();
        window.setTitle("皮卡搜索 · 内容分发 · 人工验证码");
        window.show();
        window.focus();
      } catch (error) {
        this.waiting?.reject(error);
      }
      await gate;
      signal.throwIfAborted();
      await window.webContents.executeJavaScript(
        pikasooPageScript("check", text),
      );
      this.phase = "submitting";
      const result = await this.send(window, text, async () => {
        signal.throwIfAborted();
        await beforeSubmit();
        checkpoint = true;
      });
      if (result.status === "uncertain")
        this.phase = !window.isDestroyed() ? "uncertain" : "idle";
      else {
        this.phase = "idle";
        if (result.status === "accepted") {
          this.managedText = "";
          window.hide();
        }
      }
      return result;
    } catch (error) {
      if (checkpoint)
        this.phase =
          this.window && !this.window.isDestroyed() ? "uncertain" : "idle";
      else if (managed && this.window && !this.window.isDestroyed())
        this.window.destroy();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private waitForHuman(text: string, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const abort = () => pending.reject(signal.reason);
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        if (this.waiting === pending) this.waiting = undefined;
      };
      const pending: VerificationWait = {
        text,
        continuing: false,
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.waiting = pending;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  private async send(
    window: BrowserWindow,
    text: string,
    beforeSubmit: () => Promise<void>,
  ): Promise<DistributionSubmitResult> {
    const debug = window.webContents.debugger;
    debug.attach("1.3");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestId = "",
      status = 0;
    let finish!: (result: DistributionSubmitResult) => void;
    const uncertain = (): DistributionSubmitResult => ({
      status: "uncertain",
      message:
        "皮卡搜索本批回执未知，已保留官网页面，请核对后关闭；禁止自动重投。",
      receipt: "",
    });
    const receipt = new Promise<DistributionSubmitResult>((resolve) => {
      finish = resolve;
      timer = setTimeout(() => resolve(uncertain()), 35000);
    });
    const listener = (
      _event: Electron.Event,
      method: string,
      params: Record<string, any>,
    ) => {
      if (
        method === "Network.requestWillBeSent" &&
        params.request?.method === "POST" &&
        this.allowed(params.request.url)
      ) {
        const url = new URL(params.request.url);
        if (
          url.pathname === "/share-feedback/" &&
          new URLSearchParams(params.request.postData ?? "").get("content") ===
            text
        )
          requestId = params.requestId;
      }
      if (!requestId || params.requestId !== requestId) return;
      if (method === "Network.responseReceived")
        status = params.response.status;
      if (method === "Network.loadingFailed") finish(uncertain());
      if (method === "Network.loadingFinished")
        void debug
          .sendCommand("Network.getResponseBody", { requestId })
          .then((result) => {
            const body = result.base64Encoded
              ? Buffer.from(result.body, "base64").toString("utf8")
              : String(result.body);
            finish(
              body.length <= 256000
                ? pikasooReceipt(status, body)
                : uncertain(),
            );
          })
          .catch(() => finish(uncertain()));
    };
    debug.on("message", listener);
    try {
      await debug.sendCommand("Network.enable");
      await beforeSubmit();
      await window.webContents.executeJavaScript(
        pikasooPageScript("submit", text),
      );
      const result = await receipt;
      await wait(100); // Let the official callback refresh the CAPTCHA or close its form.
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      debug.removeListener("message", listener);
      if (debug.isAttached()) debug.detach();
    }
  }
}
