import type { WebContents } from "electron";
import { AppError } from "../core/errors";
import {
  jianshuCreatedDraftUrl,
  jianshuEditorScript,
  prepareJianshuDraftCreation,
  type JianshuEditorDriver,
} from "../core/jianshu/editor";

const createEndpoint = "https://www.jianshu.com/author/notes";
const maxResponseBytes = 256000;

type NetworkObservation = {
  requestId?: string;
  request?: { method?: string; url?: string; postData?: string };
  response?: { url?: string; status?: number };
  redirectResponse?: unknown;
};

function requestNotebook(body: string | undefined): string | null {
  if (!body || body.length > 16000) return null;
  let value: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = (parsed as Record<string, unknown>).notebook_id;
  } catch {
    value = new URLSearchParams(body).get("notebook_id");
  }
  return (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) &&
    /^[1-9]\d*$/.test(String(value)) ? String(value) : null;
}

/** Observe only this owned editor's create request; never infer a new note from routing. */
export async function createNativeJianshuDraft(
  contents: WebContents,
  timeoutMs = 25000,
): Promise<string> {
  const driver: JianshuEditorDriver = {
    url: () => contents.getURL(),
    evaluate: <T>(script: string) => contents.executeJavaScript(script) as Promise<T>,
  };
  const snapshot = await prepareJianshuDraftCreation(driver);
  if (contents.isDestroyed())
    throw new AppError("JIANSHU_CREATE_WINDOW", "简书编辑窗口已关闭，未点击新建文章。");
  const debug = contents.debugger;
  if (debug.isAttached())
    throw new AppError(
      "JIANSHU_CREATE_INSPECTOR_BUSY",
      "简书编辑窗口正在被调试，请关闭该窗口的开发者工具后再试；未点击新建文章。",
    );

  let owned = false;
  let clicked = false;
  let settled = false;
  let readingBody = false;
  let requestId: string | null = null;
  let responseStatus = 0;
  let responseUrl = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveReceipt!: (url: string) => void;
  let rejectReceipt!: (error: AppError) => void;
  const receipt = new Promise<string>((resolve, reject) => {
    resolveReceipt = resolve;
    rejectReceipt = reject;
  });
  // A local failure may occur while the response observer is still pending.
  void receipt.catch(() => {});
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    rejectReceipt(new AppError("JIANSHU_CREATE_UNCERTAIN", message, clicked));
  };
  const finish = (url: string) => {
    if (settled) return;
    settled = true;
    resolveReceipt(url);
  };
  const detached = () => {
    owned = false;
    fail("简书草稿回执观察已中断，请检查官网原稿；不会自动重复新建。");
  };
  const destroyed = () =>
    fail("简书编辑窗口已关闭，新建结果待核对；不会自动重复新建。");
  const message = (
    _event: Electron.Event,
    method: string,
    params: NetworkObservation,
    sessionId?: string,
  ) => {
    if (!clicked || settled || sessionId) return;
    if (method === "Network.requestWillBeSent") {
      // Redirects keep a CDP request ID. They cannot serve as an official create receipt.
      if (requestId && params.requestId === requestId && params.redirectResponse) {
        fail("简书新建请求发生跳转，已保留官网页面，请核对后继续。");
        return;
      }
      if (
        params.request?.method !== "POST" ||
        params.request.url !== createEndpoint ||
        requestNotebook(params.request.postData) !== snapshot.notebookId ||
        !params.requestId
      ) return;
      if (requestId && requestId !== params.requestId) {
        fail("简书出现多条新建草稿请求，无法确定本次原稿，请先在官网核对。");
        return;
      }
      requestId = params.requestId;
      return;
    }
    if (!requestId || params.requestId !== requestId) return;
    if (method === "Network.responseReceived") {
      responseStatus = params.response?.status ?? 0;
      responseUrl = params.response?.url ?? "";
      if (responseUrl !== createEndpoint || responseStatus < 200 || responseStatus >= 300)
        fail("简书未返回本次新建草稿的成功回执，请在官网核对；不会自动重建。");
    } else if (method === "Network.loadingFailed") {
      fail("简书新建请求连接中断，结果待核对；不会自动重复新建。");
    } else if (method === "Network.loadingFinished" && !readingBody) {
      readingBody = true;
      if (responseUrl !== createEndpoint || responseStatus < 200 || responseStatus >= 300) {
        fail("简书新建回执尚未确认，请先核对官网原稿。");
        return;
      }
      void debug.sendCommand("Network.getResponseBody", { requestId }).then((result) => {
        if (settled) return;
        if (typeof result?.body !== "string" || result.body.length > maxResponseBytes * 2)
          throw Error("Create response is too large");
        const body = result.base64Encoded
          ? Buffer.from(result.body, "base64").toString("utf8")
          : result.body;
        if (Buffer.byteLength(body, "utf8") > maxResponseBytes)
          throw Error("Create response is too large");
        const url = jianshuCreatedDraftUrl(JSON.parse(body), snapshot.notebookId);
        if (!url) throw Error("Create response did not identify an unpublished note");
        finish(url);
      }).catch(() => {
        fail("简书新建回执未能准确识别，请先检查官网原稿；不会根据页面跳转猜测或重建。");
      });
    }
  };

  try {
    debug.attach("1.3");
    owned = true;
    debug.on("message", message);
    debug.on("detach", detached);
    contents.on("destroyed", destroyed);
    timer = setTimeout(() => fail("简书新建草稿回执等待超时，请先检查官网；不会自动重复新建。"), timeoutMs);
    await Promise.race([debug.sendCommand("Network.enable"), receipt]);
    if (contents.isDestroyed() || contents.getURL() !== snapshot.editorUrl)
      throw new AppError("JIANSHU_CREATE_CHANGED", "简书页面已切换，未点击新建文章；请检查官网后继续。");
    clicked = true;
    await Promise.race([
      driver.evaluate(jianshuEditorScript({
        action: "create",
        expectedEditorUrl: snapshot.editorUrl,
        expectedNotebookId: snapshot.notebookId,
      })),
      receipt,
    ]);
    return await receipt;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "JIANSHU_CREATE_OBSERVER",
      clicked
        ? "简书新建结果尚未确认，请先检查官网；不会自动重复新建。"
        : "简书新建回执观察尚未就绪，未点击新建文章，请稍后重试。",
      clicked,
    );
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    debug.removeListener("message", message);
    debug.removeListener("detach", detached);
    contents.removeListener("destroyed", destroyed);
    // Never detach a debugger that was already present or replaced ours after detach.
    if (owned && !contents.isDestroyed() && debug.isAttached()) debug.detach();
  }
}
