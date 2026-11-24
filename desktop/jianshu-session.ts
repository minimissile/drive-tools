import { BrowserWindow } from "electron";
import type { JianshuPort } from "../shared/jianshu";
import { jianshuDraftUrl } from "../shared/jianshu";
import type { ContentImage } from "../shared/content-sources";
import type { WebsiteAccount } from "../shared/website-accounts";
import { AppError } from "../core/errors";
import { fillJianshuEditor } from "../core/jianshu/editor";
import {
  checkJianshuArticle,
  jianshuArticleUrl,
  jianshuEditorUrl,
  jianshuIdentityScript,
  jianshuSessionObservation,
  readJianshuArticle,
  type JianshuArticleObservation,
} from "../core/jianshu/browser-state";
import {
  createWebsiteIdentitySession,
  type WebsiteIdentityContext,
} from "./website-identity-session";
import { websiteNavigationAllowed } from "./website-session-policy";
import { createNativeJianshuDraft } from "./jianshu-create-draft";

export function createJianshuSession(
  context: (account: WebsiteAccount) => WebsiteIdentityContext,
  readImage?: (image: ContentImage) => Promise<Buffer>,
) {
  const identity = createWebsiteIdentitySession(context, {
    provider: "jianshu",
    label: "简书",
    home: jianshuEditorUrl,
    cookieNames:
      /^(?:remember_user_token|_m7e_session_core|_m7e_session|sign_in_redirect)$/,
    cookieDomain: /(^|\.)jianshu\.com$/,
    script: jianshuIdentityScript(),
  });
  const configure = (
    win: BrowserWindow,
    allowed = (url: string) => websiteNavigationAllowed("jianshu", url),
  ) => {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (details) => {
      if (!allowed(details.url)) details.preventDefault();
    });
    win.webContents.on("will-redirect", (details) => {
      if (details.isMainFrame && !allowed(details.url))
        details.preventDefault();
    });
  };
  // Keep article work separate from login and from every other local draft.
  const editors = new Map<WebsiteIdentityContext, Map<string, BrowserWindow>>();
  const windows = new Set<BrowserWindow>();
  const accountEditors = (ctx: WebsiteIdentityContext) => {
    let entries = editors.get(ctx);
    if (!entries) {
      entries = new Map();
      editors.set(ctx, entries);
    }
    return entries;
  };
  const findEditor = (
    entries: Map<string, BrowserWindow>,
    target: string,
  ) => [...entries.values()].find(
    (win) =>
      !win.isDestroyed() &&
      jianshuDraftUrl(win.webContents.getURL()) === target,
  );
  const createEditor = async (
    ctx: WebsiteIdentityContext,
    key: string,
    target: string,
  ) => {
    const entries = accountEditors(ctx);
    const win = new BrowserWindow({
      width: 1280,
      height: 840,
      title: "简书 · 官方文章编辑",
      webPreferences: {
        session: ctx.profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    entries.set(key, win);
    windows.add(win);
    configure(win);
    win.on("closed", () => {
      windows.delete(win);
      // Read-only opening and local filling may point to the same owned window.
      for (const [entryKey, value] of entries)
        if (value === win) entries.delete(entryKey);
      if (!entries.size && editors.get(ctx) === entries) editors.delete(ctx);
    });
    await win.loadURL(target);
    return win;
  };
  const port: JianshuPort = {
    async openEditor(account, rawUrl) {
      const target = jianshuDraftUrl(rawUrl);
      if (account.provider !== "jianshu" || !account.uid || !target)
        throw new AppError(
          "JIANSHU_EDITOR_INPUT",
          "请选择简书账号，并打开已关联的准确官网草稿。",
        );
      const ctx = context(account);
      const win =
        findEditor(accountEditors(ctx), target) ??
        await createEditor(ctx, `note:${target}`, target);
      win.show();
      win.focus();
      if (jianshuDraftUrl(win.webContents.getURL()) !== target)
        throw new AppError(
          "JIANSHU_EDITOR_ORIGIN",
          "简书原稿尚未打开，请在官网窗口完成登录或验证后重试。",
        );
      return { opened: true, editorUrl: target };
    },
    async prepare(account, payload, onCheckpoint) {
      if (account.provider !== "jianshu")
        throw new AppError("JIANSHU_ACCOUNT", "请先选择简书账号。");
      const ctx = context(account);
      const articleEditors = accountEditors(ctx);
      const target =
        jianshuDraftUrl(payload.editorUrl) ??
        jianshuDraftUrl(payload.fillCheckpoint?.editorUrl);
      let win = articleEditors.get(payload.id);
      // A user may have changed this window to another note. Keep that work open.
      if (
        win &&
        !win.isDestroyed() &&
        target &&
        jianshuDraftUrl(win.webContents.getURL()) !== target
      )
        win = undefined;
      if ((!win || win.isDestroyed()) && target)
        win = findEditor(articleEditors, target);
      if (!win || win.isDestroyed()) {
        win = await createEditor(ctx, payload.id, target ?? jianshuEditorUrl);
      }
      articleEditors.set(payload.id, win);
      if (!websiteNavigationAllowed("jianshu", win.webContents.getURL()))
        throw new AppError(
          "JIANSHU_EDITOR_ORIGIN",
          "简书窗口尚未加载官方页面，请重新打开并完成登录。",
        );
      win.show();
      win.focus();
      const editor = win;
      return fillJianshuEditor(
        {
          url: () => editor.webContents.getURL(),
          evaluate: <T>(script: string) =>
            editor.webContents.executeJavaScript(script) as Promise<T>,
          createDraft: () => createNativeJianshuDraft(editor.webContents),
        },
        payload,
        onCheckpoint,
        readImage,
      );
    },
    async checkResult(account, rawUrl, payload) {
      const url = jianshuArticleUrl(rawUrl);
      if (!url || account.provider !== "jianshu" || !account.uid)
        throw new AppError(
          "JIANSHU_RECEIPT_INPUT",
          "请选择已核实的简书账号，并填写本人公开文章链接。",
        );
      const verifier = new BrowserWindow({
        show: false,
        webPreferences: {
          session: context(account).profile,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      configure(verifier, (value) => jianshuArticleUrl(value) === url);
      const timeout = setTimeout(() => {
        if (!verifier.isDestroyed()) verifier.destroy();
      }, 30000);
      try {
        await verifier.loadURL(url);
        const observation = (await verifier.webContents.executeJavaScript(
          `(() => { const __name = fn => fn; return (${readJianshuArticle.toString()})(); })()`,
        )) as JianshuArticleObservation | null;
        return checkJianshuArticle(observation, account.uid, url, payload);
      } catch {
        return {
          verified: false,
          url,
          reason:
            "简书文章读取未完成，请检查官网页面后重试；未认定为发布失败，也不会自动重发。",
        };
      } finally {
        clearTimeout(timeout);
        if (!verifier.isDestroyed()) verifier.destroy();
      }
    },
  };
  return {
    isOpen: () => [...windows].some((win) => !win.isDestroyed()),
    status: (account: WebsiteAccount) =>
      jianshuSessionObservation(identity.status(account)),
    verify: async (account: WebsiteAccount) =>
      jianshuSessionObservation(await identity.verify(account)),
    invalidate: identity.invalidate,
    port,
  };
}
