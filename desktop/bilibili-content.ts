import { BrowserWindow, type Session } from "electron";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";
import {
  bilibiliEditorUrl,
  type BilibiliContentPort,
  type BilibiliEditorPayload,
  type BilibiliPreparation,
} from "../shared/bilibili";
import { AppError } from "../core/errors";
import { websiteNavigationAllowed } from "./website-session-policy";

import {
  bilibiliFillPage,
  bilibiliVideoUploadPage,
  bilibiliReopenedPreparation,
} from "../core/bilibili/editor-page";
import {
  bilibiliUploadPage,
  waitForBilibiliUpload,
  type BilibiliUploadProbe,
} from "../core/bilibili/upload-page";

type Context = { profile: Session };
type WindowState = {
  win: BrowserWindow;
  fingerprint: string;
  receipt?: Omit<BilibiliPreparation, "preparedAt">;
};
export function createBilibiliContent(
  context: (account: WebsiteAccount) => Context,
  verify: (account: WebsiteAccount) => Promise<WebsiteSessionState>,
) {
  const windows = new Map<string, WindowState>();
  let generation = 0;
  const assertCurrent = (token: number, win?: BrowserWindow) => {
    if (token !== generation || win?.isDestroyed())
      throw new AppError(
        "BILIBILI_CLOSED",
        "原工作空间已关闭，未继续填写或上传。",
      );
  };
  const assertEditor = (win: BrowserWindow, editorUrl: string) => {
    const expected = new URL(editorUrl),
      current = new URL(win.webContents.getURL());
    if (
      expected.origin !== current.origin ||
      expected.pathname.replace(/\/$/, "") !==
        current.pathname.replace(/\/$/, "")
    )
      throw new AppError(
        "BILIBILI_EDITOR_MOVED",
        "官网窗口已离开当前稿件编辑器，未填写或选择素材。请在原窗口核对。",
      );
  };
  const ensureIdentity = async (account: WebsiteAccount, uid: string) => {
    const identity = await verify(account);
    if (!identity.hasSession || identity.unverified || identity.uid !== uid)
      throw new AppError(
        "BILIBILI_IDENTITY",
        "B站官网当前身份与目标账号不一致，请检查登录；未填写稿件。",
      );
  };
  const uploadState = (win: BrowserWindow) =>
    win.webContents.executeJavaScript(
      `(() => { const __name = (fn) => fn; return (${bilibiliVideoUploadPage.toString()})(); })()`,
    ) as Promise<ReturnType<typeof bilibiliVideoUploadPage>>;
  const selectFile = async (
    win: BrowserWindow,
    kind: "video" | "image",
    path: string,
    editorUrl: string,
    token: number,
    beforeSelect: () => Promise<void>,
  ) => {
    assertCurrent(token, win);
    assertEditor(win, editorUrl);
    const marker = `data-panxu-bilibili-${kind}`;
    const probe = (allowFallback = true) =>
      win.webContents.executeJavaScript(
        `(() => { const __name = (fn) => fn; return (${bilibiliUploadPage.toString()})(${JSON.stringify({ kind, editorUrl, marker, allowFallback })}); })()`,
        true,
      ) as Promise<BilibiliUploadProbe>;
    let found =
      kind === "video"
        ? await waitForBilibiliUpload(
            () => probe(false),
            () => {
              assertCurrent(token, win);
              assertEditor(win, editorUrl);
            },
          )
        : (await probe()).ready;
    if (kind === "video" && !found) {
      assertCurrent(token, win);
      assertEditor(win, editorUrl);
      found = (await probe()).ready;
    }
    assertCurrent(token, win);
    assertEditor(win, editorUrl);
    if (!found) return false;
    const debug = win.webContents.debugger;
    if (debug.isAttached()) return false;
    debug.attach("1.3");
    try {
      const { root } = await debug.sendCommand("DOM.getDocument");
      assertCurrent(token, win);
      assertEditor(win, editorUrl);
      const { nodeId } = await debug.sendCommand("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: `input[${marker}='1']`,
      });
      if (!nodeId) return false;
      await beforeSelect();
      assertCurrent(token, win);
      assertEditor(win, editorUrl);
      await debug.sendCommand("DOM.setFileInputFiles", {
        nodeId,
        files: [path],
      });
      assertCurrent(token, win);
      return !!(await win.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(`input[${marker}='1']`)})?.files?.length === 1`,
      ));
    } finally {
      if (!win.isDestroyed()) {
        await win.webContents
          .executeJavaScript(
            `document.querySelector(${JSON.stringify(`input[${marker}='1']`)})?.removeAttribute(${JSON.stringify(marker)})`,
          )
          .catch(() => {});
        if (debug.isAttached()) debug.detach();
      }
    }
  };
  const port: BilibiliContentPort = {
    async prepare(account, payload) {
      const token = generation;
      if (
        account.provider !== "bilibili" ||
        !account.uid ||
        account.uid !== payload.uid
      )
        throw new AppError(
          "BILIBILI_ACCOUNT",
          "投稿目标账号不正确，未打开官网填写。",
        );
      let profile: Session;
      try {
        profile = context(account).profile;
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === "ENVIRONMENT_ENGINE_MISMATCH"
        )
          throw new AppError(
            "BILIBILI_NATIVE",
            "B站官网填写目前使用内置浏览器，请选择或连接内置账号。",
          );
        throw error;
      }
      await ensureIdentity(account, payload.uid);
      assertCurrent(token);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ accountId: account.id, ...payload }))
        .digest("hex");
      const previous = windows.get(fingerprint);
      if (previous && !previous.win.isDestroyed()) {
        assertEditor(previous.win, bilibiliEditorUrl(payload.kind));
        let message = "";
        if (payload.kind === "video") {
          const status = await uploadState(previous.win);
          assertCurrent(token, previous.win);
          message = status.message;
        }
        previous.win.show();
        previous.win.focus();
        return bilibiliReopenedPreparation(
          bilibiliEditorUrl(payload.kind),
          message,
        );
      }
      const win = new BrowserWindow({
        title: `哔哩哔哩 · ${account.alias} · 投稿准备`,
        show: true,
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
      const state: WindowState = { win, fingerprint };
      windows.set(fingerprint, state);
      win.on("closed", () => {
        if (windows.get(fingerprint) === state) windows.delete(fingerprint);
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => {
        if (!websiteNavigationAllowed("bilibili", event.url))
          event.preventDefault();
      });
      win.webContents.on("will-redirect", (event) => {
        if (
          event.isMainFrame &&
          !websiteNavigationAllowed("bilibili", event.url)
        )
          event.preventDefault();
      });
      const editorUrl = bilibiliEditorUrl(payload.kind);
      try {
        await win.loadURL(editorUrl);
        assertCurrent(token, win);
        await ensureIdentity(account, payload.uid);
        assertCurrent(token, win);
        assertEditor(win, editorUrl);
        if (
          win.isDestroyed() ||
          !websiteNavigationAllowed("bilibili", win.webContents.getURL())
        )
          throw new AppError(
            "BILIBILI_EDITOR",
            "官网编辑器未能打开，请检查原窗口。",
          );
        let mediaSelected = false,
          imageSelected = false;
        if (payload.kind === "video" && payload.videoPath) {
          mediaSelected = await selectFile(
            win,
            "video",
            payload.videoPath,
            editorUrl,
            token,
            () => ensureIdentity(account, payload.uid),
          );
          // The official site may mount title/description only after choosing a video.
          if (mediaSelected) {
            const until = Date.now() + 15000;
            while (!win.isDestroyed() && Date.now() < until) {
              const ready = await win.webContents.executeJavaScript(
                `Array.from(document.querySelectorAll('input,textarea')).some(element => /标题/.test(element.getAttribute('placeholder') || '') && element.getClientRects().length)`,
              );
              assertCurrent(token, win);
              assertEditor(win, editorUrl);
              if (ready) break;
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }
        }
        await ensureIdentity(account, payload.uid);
        assertCurrent(token, win);
        assertEditor(win, editorUrl);
        if (context(account).profile !== profile)
          throw new AppError(
            "BILIBILI_CONTEXT",
            "账号浏览器环境已变化，未继续填写。",
          );
        const fill = (await win.webContents.executeJavaScript(
          `(() => { const __name = (fn) => fn; return (${bilibiliFillPage.toString()})(${JSON.stringify({ kind: payload.kind, title: payload.title, text: payload.text, tags: payload.tags, automaticVideoTitle: payload.videoPath ? basename(payload.videoPath, extname(payload.videoPath)) : undefined })}); })()`,
          true,
        )) as { fields: string[]; missing: string[] };
        assertCurrent(token, win);
        if (payload.coverPath) {
          await ensureIdentity(account, payload.uid);
          assertCurrent(token, win);
          assertEditor(win, editorUrl);
          imageSelected = await selectFile(
            win,
            "image",
            payload.coverPath,
            editorUrl,
            token,
            () => ensureIdentity(account, payload.uid),
          );
        }
        const missing = [...fill.missing];
        const status = payload.kind === "video" ? await uploadState(win) : null;
        assertCurrent(token, win);
        if (payload.kind === "video" && !mediaSelected)
          missing.push("视频文件");
        if (status && status.state !== "completed")
          missing.push("视频上传或人工验证状态");
        if (!imageSelected)
          missing.push(payload.kind === "video" ? "封面" : "配图");
        const receipt: Omit<BilibiliPreparation, "preparedAt"> = {
          status: missing.length ? "partial" : "filled",
          editorUrl,
          filledFields: fill.fields,
          mediaSelected,
          imageSelected,
          message: `${fill.fields.length ? `已填写${fill.fields.join("、")}。` : "官网窗口已打开。"}${status?.message ?? ""}${imageSelected ? "已选入图片。" : ""}${missing.length ? `请在官网补充或核对：${[...new Set(missing)].join("、")}。` : "请在官网核对分区、声明及可见范围。"}尚未提交发布。`,
        };
        state.receipt = receipt;
        win.show();
        win.focus();
        return receipt;
      } catch (error) {
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
        }
        if (error instanceof AppError) throw error;
        throw new AppError(
          "BILIBILI_EDITOR",
          "官网填写未完成，请在已打开的原窗口核对登录、权限或编辑器状态；未自动重试。",
          true,
        );
      }
    },
  };
  const isOpen = () =>
    [...windows.values()].some(({ win }) => !win.isDestroyed());
  const close = () => {
    generation++;
    for (const { win } of windows.values()) if (!win.isDestroyed()) win.close();
  };
  port.isOpen = isOpen;
  port.close = close;
  return { port, isOpen, close };
}
