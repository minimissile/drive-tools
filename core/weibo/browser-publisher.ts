export interface PublisherWindow {
  show(): void;
  webContents: {
    executeJavaScript(script: string, gesture?: boolean): Promise<any>;
    debugger: {
      isAttached(): boolean;
      attach(version: string): void;
      detach(): void;
      sendCommand(method: string, params?: any): Promise<any>;
      on(event: "message", callback: (event: unknown, method: string, params: any) => void): unknown;
      removeListener(event: "message", callback: (event: unknown, method: string, params: any) => void): unknown;
    };
  };
}
import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { AppError } from "../errors";
import type {
  WeiboEditorPayload,
  WeiboEditorState,
  WeiboSubmitReceipt,
} from "../../shared/weibo-publishing";
import { weiboReceiptUrl } from "../../shared/weibo-marketing";
import { weiboPublisherPage } from "./weibo-publisher-page";

export function weiboSubmitReceipt(
  value: unknown,
  status: number,
  uid: string,
): WeiboSubmitReceipt {
  const body = value as any;
  if (!body || typeof body !== "object" || status >= 500 || body.data?.verify)
    throw new AppError(
      "WEIBO_RECEIPT_UNKNOWN",
      "微博未返回明确发布回执，请保留官方窗口核对；不要重复点击发布。",
    );
  if (body.ok !== 1 || body.error)
    return {
      status: "rejected",
      message: `微博未接受提交：${String(body.msg ?? body.message ?? body.error ?? "请检查官方窗口提示").slice(0, 240)}`,
    };
  const data = body.data?.status ?? body.data;
  const author = String(data?.user?.idstr ?? data?.user?.id ?? "");
  const postId = String(data?.mblogid ?? data?.bid ?? "");
  if ((author && author !== uid) || !/^[a-zA-Z0-9]{5,32}$/.test(postId))
    throw new AppError(
      "WEIBO_RECEIPT_UNKNOWN",
      "微博返回成功但作者或单条微博 ID 不完整，请在官方窗口核对后登记链接。",
    );
  return {
    status: "submitted",
    postId,
    url: weiboReceiptUrl(`https://weibo.com/${uid}/${postId}`, uid),
  };
}

export class WeiboPublisher {
  constructor(
    private window: () => Promise<PublisherWindow>,
    private verify: () => Promise<void>,
  ) {}
  private async action(
    win: PublisherWindow,
    payload: WeiboEditorPayload,
    action: "fill" | "assert" | "submit",
  ) {
    const images = [];
    if (action === "fill")
      for (const image of payload.images) {
        const stat = await lstat(image.path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size <= 0 ||
          stat.size >= 20 * 1024 * 1024
        )
          throw new AppError(
            "WEIBO_IMAGE_INVALID",
            "配图文件无效或达到 20MB，请重新选择。",
          );
        const bytes = await readFile(image.path);
        if (createHash("sha256").update(bytes).digest("hex") !== image.sha256)
          throw new AppError("WEIBO_IMAGE_CHANGED", "配图已变化，请重新准备。");
        const extension = extname(image.name).toLowerCase();
        const mime =
          extension === ".png"
            ? "image/png"
            : extension === ".gif"
              ? "image/gif"
              : [".jpg", ".jpeg"].includes(extension)
                ? "image/jpeg"
                : null;
        if (!mime)
          throw new AppError(
            "WEIBO_IMAGE_INVALID",
            "微博配图仅支持 PNG、JPG、GIF。",
          );
        images.push({
          name: image.name,
          mime,
          base64: bytes.toString("base64"),
          sha256: image.sha256,
        });
      }
    const input = {
      action,
      taskId: payload.taskId,
      uid: payload.uid,
      text: payload.text,
      visibility: payload.visibility,
      aiAssisted: payload.aiAssisted,
      hashes: payload.images.map((image) => image.sha256),
      images,
    };
    try {
      return (await win.webContents.executeJavaScript(
        `(() => { const __name = (fn) => fn; return (${weiboPublisherPage.toString()})(${JSON.stringify(input)}); })()`,
        true,
      )) as WeiboEditorState;
    } catch (error) {
      // Electron errors contain script locations; return only the page's actionable message.
      const message =
        error instanceof Error
          ? error.message
              .replace(/^Error invoking remote method.*?: Error: /, "")
              .replace(/^Error: /, "")
          : "微博发布器操作失败，请查看官方窗口。";
      throw new AppError("WEIBO_EDITOR_BLOCKED", message.slice(0, 400));
    }
  }
  async prepare(payload: WeiboEditorPayload) {
    const win = await this.window();
    await this.verify();
    win.show();
    return this.action(win, payload, "fill");
  }
  async submit(payload: WeiboEditorPayload, beforeSubmit: () => Promise<void>) {
    const win = await this.window();
    await this.verify();
    await this.action(win, payload, "assert");
    const debuggerApi = win.webContents.debugger;
    if (debuggerApi.isAttached())
      throw new AppError(
        "WEIBO_INSPECTOR_BUSY",
        "请关闭微博窗口的开发者工具后再发布。",
      );
    debuggerApi.attach("1.3");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestId: string | undefined;
    let httpStatus = 0;
    let settle!: (value: WeiboSubmitReceipt) => void;
    let reject!: (error: unknown) => void;
    const receipt = new Promise<WeiboSubmitReceipt>((resolve, fail) => {
      settle = resolve;
      reject = fail;
    });
    // Avoid an unhandled rejection if local revalidation fails before the browser click.
    void receipt.catch(() => {});
    const message = async (_event: unknown, method: string, params: any) => {
      try {
        if (method === "Network.requestWillBeSent" && !requestId) {
          const request = params.request;
          const url = new URL(request.url);
          if (
            url.protocol !== "https:" ||
            !["weibo.com", "www.weibo.com"].includes(url.hostname) ||
            !!url.port ||
            url.pathname !== "/ajax/statuses/update" ||
            request.method !== "POST"
          )
            return;
          const body = new URLSearchParams(request.postData ?? "");
          if (
            body.get("content") !== payload.text ||
            body.get("visible") !== (payload.visibility === "self" ? "1" : "0")
          )
            return;
          requestId = params.requestId;
        } else if (requestId && params.requestId === requestId) {
          if (method === "Network.responseReceived")
            httpStatus = params.response.status;
          if (method === "Network.loadingFailed")
            reject(
              new AppError(
                "WEIBO_RECEIPT_UNKNOWN",
                "微博提交连接中断，请核对官方窗口，避免重复发布。",
              ),
            );
          if (method === "Network.loadingFinished") {
            const response = await debuggerApi.sendCommand(
              "Network.getResponseBody",
              { requestId },
            );
            const text = response.base64Encoded
              ? Buffer.from(response.body, "base64").toString("utf8")
              : response.body;
            settle(
              weiboSubmitReceipt(JSON.parse(text), httpStatus, payload.uid),
            );
          }
        }
      } catch (error) {
        reject(error);
      }
    };
    debuggerApi.on("message", message);
    try {
      await debuggerApi.sendCommand("Network.enable");
      await beforeSubmit();
      await this.verify();
      await this.action(win, payload, "submit");
      timer = setTimeout(
        () =>
          reject(
            new AppError(
              "WEIBO_RECEIPT_UNKNOWN",
              "尚未取得微博发布回执，请检查安全验证或平台提示；不要重复发帖。",
            ),
          ),
        35000,
      );
      return await receipt;
    } finally {
      if (timer) clearTimeout(timer);
      debuggerApi.removeListener("message", message);
      if (debuggerApi.isAttached()) debuggerApi.detach();
    }
  }
}
