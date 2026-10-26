import { runtimeDataPath } from "./runtime-paths";
import { watchDevParent } from "./dev-parent";
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  session,
  shell,
  protocol,
} from "electron";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { isAbsolute, join, basename } from "node:path";
import { AppService, type AppPorts } from "../core/service";
import { createZhidaoSession } from "./zhidao-session";
import { createWebsiteSessions } from "./website-sessions";
import { createEnvironmentSessions } from "./browser-environment-session";
import { readTableBytes } from "../core/table-files";
import { QuarkProvider } from "../core/providers/quark";
import { UcProvider } from "../core/providers/uc";
import { PikPakProvider } from "../core/providers/pikpak";
import { GuangyaProvider } from "../core/providers/guangya";
import { providerRequestReferer } from "../core/providers/request-context";
import { XunleiProvider } from "../core/providers/xunlei";
import { WebTokenSession } from "../core/providers/web-token-session";
import {
  providerSpecs,
  providerAuthAllowed,
  providerApiAllowed,
} from "../shared/providers";
import { BaiduProvider } from "../core/providers/baidu";
import type { ProviderTransport } from "../core/providers/provider";
import type { Account, Result } from "../shared/types";
import { AppError, ProviderHttpError, safeMessage } from "../core/errors";
import { readLimited } from "../core/http";
import { ZodError } from "zod";
import { createUpdater } from "./updater";
import type { UpdateManager } from "../core/updates";
import { snapshotBeforeUpdate } from "../core/update-backup";

app.setName("盘序");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "panxu-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
const defaultDataPath = runtimeDataPath(app.getPath("appData"), app.isPackaged);
mkdirSync(defaultDataPath, { recursive: true, mode: 0o700 });
app.setPath("userData", defaultDataPath);
app.setPath("sessionData", defaultDataPath);
// Lock the application environment before selecting a workspace. Temporary data
// directories must not bypass the desktop single-instance policy.
const locked = app.requestSingleInstanceLock();
const workspaceLocation = join(defaultDataPath, "workspace-location.json");
let startupError: Error | null = null;
let selectedDataPath: string | undefined;
try {
  selectedDataPath = process.env.PANXU_DATA_DIR
    ? runtimeDataPath(
        app.getPath("appData"),
        app.isPackaged,
        process.env.PANXU_DATA_DIR,
      )
    : undefined;
} catch (e) {
  startupError = e instanceof Error ? e : new Error("工作空间路径无效。");
}
if (selectedDataPath && !isAbsolute(selectedDataPath))
  startupError = new Error(
    "PANXU_DATA_DIR必须是绝对路径，未打开其他工作空间。",
  );
if (!selectedDataPath && existsSync(workspaceLocation)) {
  try {
    const saved = JSON.parse(readFileSync(workspaceLocation, "utf8"));
    if (
      typeof saved.path !== "string" ||
      !isAbsolute(saved.path) ||
      !existsSync(join(saved.path, "panxu.db"))
    )
      throw new Error(
        "恢复工作空间的位置无效。请保留数据目录并检查workspace-location.json。",
      );
    selectedDataPath = saved.path;
  } catch (error) {
    startupError =
      error instanceof Error ? error : new Error("工作空间配置无法读取。");
  }
}
if (selectedDataPath && isAbsolute(selectedDataPath)) {
  mkdirSync(selectedDataPath, { recursive: true, mode: 0o700 });
  app.setPath("userData", selectedDataPath);
  app.setPath("sessionData", selectedDataPath);
}
let window: BrowserWindow | null = null;
let service: AppService;
let updater: UpdateManager;
let activeOperations = 0;
let installingUpdate = false;
let quitting = false;
let devRestarting = false;
const developmentUrl = `http://127.0.0.1:${Number(process.env.PANXU_DEV_PORT || 8070)}`;
const development =
  !app.isPackaged && process.env.PANXU_DEV_URL === developmentUrl;
// A crashed/killed dev supervisor must not leave an orphan Dock application.
if (development) {
  watchDevParent(process, () => {
    quitting = true;
    app.quit();
  });
}
// The source runtime has its own DEV artwork; packaged resources keep the brand icon.
const appIconPath = app.isPackaged
  ? join(process.resourcesPath, "brand", "icon.png")
  : join(
      import.meta.dirname,
      "../build",
      development ? "icon-dev.png" : "icon.png",
    );
const loginWindows = new Map<string, BrowserWindow>();
const clearingSessions = new Set<string>();
const partition = (accountId: string) =>
  session.fromPartition(`persist:panxu-${accountId}`);
function allowedProviderUrl(accountId: string, text: string) {
  const account = service.repo.getAccount(accountId);
  if (!providerApiAllowed(account.provider, text))
    throw new AppError(
      "PROVIDER_URL_BLOCKED",
      "请求目标不属于此网盘账号的允许接口。",
    );
  return new URL(text);
}
async function providerResponse(
  accountId: string,
  text: string,
  init: RequestInit = {},
) {
  const url = allowedProviderUrl(accountId, text);
  const requestSession = partition(accountId);
  const referrer = providerRequestReferer(
    service.repo.getAccount(accountId).provider,
    url,
  );
  const response = await requestSession.fetch(url.href, {
    ...init,
    credentials: init.credentials ?? "include",
    signal: AbortSignal.timeout(45_000),
    headers: { Referer: referrer, ...init.headers },
  });
  if (![200, 201, 202].includes(response.status)) {
    let detail = "";
    let remoteCode = "";
    try {
      const data = JSON.parse(await readLimited(response, 64000));
      remoteCode = String(
        data.code ?? data.errno ?? data.error_code ?? "",
      ).slice(0, 30);
      detail = `（${String(data.code ?? data.errno ?? data.error_code ?? "").slice(0, 30)}：${String(data.message ?? data.errmsg ?? data.error_msg ?? data.error_description ?? data.error ?? "").slice(0, 180)}）`;
    } catch {}
    throw new ProviderHttpError(
      response.status,
      remoteCode,
      safeMessage(
        new Error(
          `网盘接口 ${url.pathname} 返回 HTTP ${response.status}${detail}，未确认操作成功。`,
        ),
      ),
      init.method === "POST",
    );
  }
  return response;
}
const captureErrors = new Map<string, Error>();
const transport: ProviderTransport = {
  async ownShareCode(accountId, shareId) {
    const copy = service.db.get<{ id: string }>(
      "SELECT id FROM copies WHERE account_id=? AND share_id=? LIMIT 1",
      accountId,
      shareId,
    );
    if (copy) return service.secrets.get(`share:${copy.id}`);
    const item = service.db.get<{ id: string }>(
      "SELECT i.id FROM split_items i JOIN copies c ON c.id=i.copy_id WHERE c.account_id=? AND i.share_id=? LIMIT 1",
      accountId,
      shareId,
    );
    return item ? service.secrets.get(`split:${item.id}`) : null;
  },
  async authHeaders(accountId, refresh) {
    const error = captureErrors.get(accountId);
    if (error) throw error;
    return tokenSession(service.repo.getAccount(accountId).provider).headers(
      accountId,
      refresh,
    );
  },
  async principalId(accountId, provider) {
    if (provider !== "quark" && provider !== "uc") return null;
    const uid = (
      await partition(accountId).cookies.get({
        url: providerSpecs[provider].home,
      })
    ).find((c) => c.name === "__uid")?.value;
    // Only the provider-assigned user ID is exposed to adapters; credentials
    // and the rest of the cookie jar stay inside Electron's session.
    return uid && /^[a-zA-Z0-9_-]{4,128}$/.test(uid) ? uid : null;
  },
  async json(accountId, url, init) {
    const response = await providerResponse(accountId, url, init);
    const text = await readLimited(response);
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        "网盘返回非JSON数据，可能需要重新登录或人工验证。",
        init?.method === "POST",
      );
    }
  },
  async text(accountId, url, init) {
    return readLimited(await providerResponse(accountId, url, init));
  },
  async setCookie(accountId, url, name, value) {
    allowedProviderUrl(accountId, url);
    await partition(accountId).cookies.set({
      url,
      name,
      value,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
  },
};
const thunderSessions = new WebTokenSession(() => service.secrets, transport);
const pikpakSessions = new WebTokenSession(
  () => service.secrets,
  transport,
  "pikpak",
);
const guangyaSessions = new WebTokenSession(
  () => service.secrets,
  transport,
  "guangya",
);
const usesTokenSession = (provider: string) =>
  ["xunlei", "pikpak", "guangya"].includes(provider);
function tokenSession(provider: string) {
  if (provider === "pikpak") return pikpakSessions;
  if (provider === "guangya") return guangyaSessions;
  if (provider === "xunlei") return thunderSessions;
  throw new AppError("AUTH_EXPIRED", "该网盘不使用令牌会话。");
}
const authHostAllowed = providerAuthAllowed;

async function captureTokenStorage(account: Account, auth: BrowserWindow) {
  let origin = "";
  if (!auth.isDestroyed()) {
    try {
      origin = new URL(auth.webContents.getURL()).origin;
    } catch {}
  }
  if (
    !usesTokenSession(account.provider) ||
    auth.isDestroyed() ||
    origin !== new URL(providerSpecs[account.provider].home).origin
  )
    return;
  const candidates = await auth.webContents.executeJavaScript(`(() => {
    const values = [];
    for (const key of Object.keys(localStorage).filter(k => k.startsWith('credentials_')).slice(0, 10)) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw || raw.length > 64000) continue;
        const entry = JSON.parse(raw);
        const value = entry && typeof entry.value === 'object' ? entry.value : entry;
        if (value && typeof value.access_token === 'string' && typeof value.refresh_token === 'string') values.push({ access_token: value.access_token, refresh_token: value.refresh_token });
      } catch {}
    }
    return values;
  })()`);
  await tokenSession(account.provider).captureRefresh(account.id, candidates);
}
async function openAccountWindow(account: Account, url?: string) {
  const existing = loginWindows.get(account.id);
  if (existing && !existing.isDestroyed()) {
    if (url) await existing.loadURL(url);
    existing.show();
    existing.focus();
    return;
  }
  const authSession = partition(account.id);
  authSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  authSession.setPermissionCheckHandler(() => false);
  const auth = new BrowserWindow({
    width: 1100,
    height: 790,
    title: `${account.alias} · 盘序隔离账号窗口`,
    autoHideMenuBar: true,
    webPreferences: {
      session: authSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  loginWindows.set(account.id, auth);
  if (usesTokenSession(account.provider)) {
    const captureFailure = (error: unknown) => {
      if (auth.isDestroyed() || clearingSessions.has(account.id) || quitting)
        return;
      captureErrors.set(
        account.id,
        error instanceof Error
          ? error
          : new AppError(
              "AUTH_CAPTURE_FAILED",
              "网盘本机会话未能安全保存，请重新登录。",
            ),
      );
    };
    authSession.webRequest.onBeforeSendHeaders(
      {
        urls: providerSpecs[account.provider].apiHosts.map(
          (host) => `https://${host}/*`,
        ),
      },
      (details, callback) => {
        callback({ requestHeaders: details.requestHeaders });
        if (auth.isDestroyed() || details.webContentsId !== auth.webContents.id)
          return;
        void tokenSession(account.provider)
          .capture(account.id, details.requestHeaders)
          .then(async (captured) => {
            if (!captured) return;
            captureErrors.delete(account.id);
            await captureTokenStorage(account, auth);
          })
          .catch(captureFailure);
      },
    );
    auth.webContents.on("did-finish-load", () => {
      void captureTokenStorage(account, auth).catch(captureFailure);
    });
    let closing = false;
    auth.on("close", (event) => {
      if (closing || quitting) return;
      event.preventDefault();
      closing = true;
      void captureTokenStorage(account, auth)
        .catch(captureFailure)
        .finally(() => {
          if (!auth.isDestroyed()) auth.destroy();
        });
    });
  }

  auth.webContents.setWindowOpenHandler(({ url: target }) => {
    if (authHostAllowed(account.provider, target)) void auth.loadURL(target);
    return { action: "deny" };
  });
  auth.webContents.on("will-navigate", (event, target) => {
    if (!authHostAllowed(account.provider, target)) event.preventDefault();
  });
  auth.on("closed", () => {
    loginWindows.delete(account.id);
    if (clearingSessions.has(account.id) || quitting) return;
    void service.invoke("account.check", { id: account.id }).catch(() => {
      /* status remains unverified until user checks */
    });
  });
  await auth.loadURL(url ?? providerSpecs[account.provider].home);
}
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
function changed() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (window && !window.isDestroyed())
      window.webContents.send("panxu:changed");
  }, 80);
}
const environmentSessions = createEnvironmentSessions((ref) => service.environments.forAccount(ref));
const websiteSessions = createWebsiteSessions(() => service.dataPath, (account) => environmentSessions.profile({ kind: "website", id: account.id }));
const ports: AppPorts = {
  browserEnvironments: environmentSessions,
  zhidaoSession: createZhidaoSession((id) => environmentSessions.profile({ kind: "zhidao", id })),
  baiduKeywords: websiteSessions.baiduKeywords,
  websiteSessions: websiteSessions.sessions,
  weiboPublisher: websiteSessions.weiboPublisher,
  async readWeiboImages() {
    const result = await dialog.showOpenDialog(window!, {
      title: "选择微博配图（最多 9 张）",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "微博图片", extensions: ["png", "jpg", "jpeg", "gif"] }],
    });
    if (result.canceled) return null;
    if (result.filePaths.length > 9) throw new AppError("WEIBO_IMAGE_LIMIT", "一次最多选择 9 张图片。");
    const images = [];
    for (const path of result.filePaths) {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size >= 20 * 1024 * 1024) throw new AppError("WEIBO_IMAGE_INVALID", "每张图片必须为小于 20MB 的本地文件。");
      images.push({ name: basename(path), bytes: await readFile(path) });
    }
    return images;
  },
  pansouBinary: join(
    app.isPackaged
      ? process.resourcesPath
      : join(import.meta.dirname, "../build"),
    "pansou",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "pansou-server.exe" : "pansou-server",
  ),
  async readTable(kind) {
    const selected = await dialog.showOpenDialog(window!, {
      title: kind === "keywords" ? "导入关键词文件" : "导入资源表",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "表格与文本",
          extensions:
            kind === "keywords" ? ["txt", "csv", "xlsx"] : ["csv", "xlsx"],
        },
      ],
    });
    if (selected.canceled || !selected.filePaths.length) return null;
    if (selected.filePaths.length > 20)
      throw new AppError("FILE_LIMIT", "一次最多导入20份文件。");
    const rows: string[][] = [];
    for (const path of selected.filePaths) {
      if ((await stat(path)).size > 8_000_000)
        throw new AppError("FILE_TOO_LARGE", "每份导入文件不能超过8MB。");
      rows.push(
        ...readTableBytes(
          path,
          await import("node:fs/promises").then((fs) => fs.readFile(path)),
        ),
      );
      if (rows.length > 501)
        throw new AppError("ROW_LIMIT", "一次最多导入500条记录。");
    }
    return {
      name: selected.filePaths
        .map((path) => path.split(/[\\/]/).pop()!)
        .join("、"),
      rows,
    };
  },
  login: (a) => openAccountWindow(a),
  async closeAccountWindow(accountId) {
    clearingSessions.add(accountId);
    try {
      const win = loginWindows.get(accountId);
      if (win && !win.isDestroyed())
        await new Promise<void>((resolve) => {
          win.once("closed", () => resolve());
          win.close();
        });
    } finally {
      clearingSessions.delete(accountId);
    }
  },
  async clearSession(accountId) {
    clearingSessions.add(accountId);
    try {
      const win = loginWindows.get(accountId);
      if (win && !win.isDestroyed())
        await new Promise<void>((resolve) => {
          win.once("closed", () => resolve());
          win.close();
        });
      if (usesTokenSession(service.repo.getAccount(accountId).provider))
        await tokenSession(service.repo.getAccount(accountId).provider).clear(
          accountId,
        );
      captureErrors.delete(accountId);
      await partition(accountId).clearStorageData();
      await partition(accountId).clearCache();
    } finally {
      clearingSessions.delete(accountId);
    }
  },
  async chooseDirectory(kind, defaultPath) {
    const result = await dialog.showOpenDialog(window!, {
      title: {
        vault: "选择Obsidian Vault根目录",
        backup: "选择备份保存目录",
        restore: "选择盘序备份文件夹",
        content: "选择内容包保存目录",
      }[kind],
      properties: ["openDirectory", "createDirectory"],
      defaultPath,
    });
    return result.canceled ? null : result.filePaths[0];
  },
  async readText(kind) {
    const result = await dialog.showOpenDialog(window!, {
      title: kind === "csv" ? "选择资源CSV" : "选择资源说明文本",
      properties: ["openFile"],
      filters: [
        {
          name: kind === "csv" ? "CSV表格" : "文本或Markdown",
          extensions: kind === "csv" ? ["csv"] : ["txt", "md"],
        },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const { readFile, stat } = await import("node:fs/promises");
    const path = result.filePaths[0];
    if ((await stat(path)).size > 2_000_000)
      throw new AppError("FILE_TOO_LARGE", "文本文件不能超过2MB。");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(path),
    );
    return {
      name: path.split(/[\\/]/).pop()!,
      text: text.replace(/^\uFEFF/, ""),
    };
  },
  async activateDataPath(path) {
    if (!isAbsolute(path) || !existsSync(join(path, "panxu.db")))
      throw new AppError(
        "WORKSPACE_MISSING",
        "恢复工作空间不存在，未重启应用。",
      );
    if (process.env.PANXU_DATA_DIR) process.env.PANXU_DATA_DIR = path;
    else {
      const { mkdir, writeFile, rename } = await import("node:fs/promises");
      await mkdir(defaultDataPath, { recursive: true, mode: 0o700 });
      const temp = workspaceLocation + ".tmp";
      await writeFile(temp, JSON.stringify({ path }), { mode: 0o600 });
      await rename(temp, workspaceLocation);
    }
    setTimeout(() => {
      quitting = true;
      service.queue.stop();
      app.relaunch();
      app.exit(0);
    }, 300);
  },
  async normalizeCover(bytes) {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty())
      throw new AppError("INVALID_COVER", "图片内容无法解码。");
    const { width, height } = image.getSize();
    if (width * height > 60_000_000)
      throw new AppError(
        "COVER_TOO_LARGE",
        "图片分辨率过大，请使用封面尺寸的图片。",
      );
    return (
      Math.max(width, height) > 1600
        ? image.resize({
            width: width >= height ? 1600 : undefined,
            height: height > width ? 1600 : undefined,
          })
        : image
    ).toPNG();
  },
  async openPath(path) {
    const error = await shell.openPath(path);
    if (error)
      throw new AppError(
        "OPEN_PATH_FAILED",
        "无法打开本地路径，请检查文件是否仍存在。",
      );
  },
  openAccountPage: (a, url) => openAccountWindow(a, url),
  async openExternal(url) {
    await shell.openExternal(url);
  },
  async copyImage(bytes) {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new AppError("IMAGE_INVALID", "图片读取失败，未复制。");
    await clipboard.write([new ClipboardItem({"image/png": new Blob([new Uint8Array(image.toPNG())], {type:"image/png"})})]);
  },
  async copyRichText(html, text) { await clipboard.write([new ClipboardItem({"text/html":html,"text/plain":text})]); },
  async copyText(text) {
    await clipboard.writeText(text);
  },
  async saveFile(name, bytes) {
    const extension =
      name.match(/\.(csv|xlsx|md|json|txt|png|mp4)$/)?.[1] ?? "txt";
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: name,
      filters: [
        {
          name: (
            {
              csv: "CSV表格",
              xlsx: "Excel工作簿",
              md: "Markdown文档",
              json: "JSON档案",
              txt: "文本文件",
              png: "PNG图片",
              mp4: "MP4视频",
            } as Record<string, string>
          )[extension],
          extensions: [extension],
        },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(result.filePath, bytes);
    return result.filePath;
  },
};
function createWindow() {
  window = new BrowserWindow({
    show: false,
    width: 1320,
    height: 900,
    minWidth: 840,
    minHeight: 650,
    title: development
      ? "盘序 · 开发调试（源码实时更新）"
      : "盘序 · 内容营销工作台",
    backgroundColor: "#f6f8fc",
    icon: appIconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      devTools: !app.isPackaged,
      // Keep job state and frames in sync while the workbench is in the background.
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.once("ready-to-show", () => {
    window?.maximize();
    window?.show();
  });
  if (development)
    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window?.setTitle("盘序 · 开发调试（源码实时更新）");
    });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback) =>
      callback(permission === "clipboard-sanitized-write"),
  );
  window.on("close", (event) => {
    if (quitting) return;
    const running = service.repo
      .jobs(true)
      .filter((j) =>
        [
          "preflight",
          "transferring",
          "verifying",
          "sharing",
          "archiving",
        ].includes(j.stage),
      );
    if (
      running.length ||
      service.studio.isBusy ||
      service.websiteAccounts.isBusy ||
      service.weibo.isBusy ||
      service.csdn.isBusy ||
      service.zhidao.isBusy ||
      service.driveFiles.isBusy
    ) {
      const choice = dialog.showMessageBoxSync(window!, {
        type: "question",
        title: "任务仍在执行",
        message: "关闭窗口后继续运行任务，还是退出盘序？",
        buttons: ["后台继续", "退出盘序"],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice === 0) {
        event.preventDefault();
        window!.hide();
      } else quitting = true;
    }
  });
  const devUrl = !app.isPackaged ? process.env.PANXU_DEV_URL : undefined;
  if (devUrl) {
    const u = new URL(devUrl);
    if (u.origin !== developmentUrl || u.pathname !== "/" || u.search || u.hash)
      throw new Error("开发服务地址不在允许范围。");
    void window.loadURL(devUrl);
  } else void window.loadFile(join(import.meta.dirname, "../dist/index.html"));
}
if (!locked) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      window.show();
      window.focus();
    }
  });
  void app
    .whenReady()
    .then(async () => {
      if (startupError) throw startupError;
      if (process.platform === "darwin") app.dock?.setIcon(appIconPath);
      const codec = {
        available: () => safeStorage.isEncryptionAvailable(),
        async encrypt(text: string) {
          return (await safeStorage.encryptStringAsync(text)).toString(
            "base64",
          );
        },
        async decrypt(value: string) {
          return (
            await safeStorage.decryptStringAsync(Buffer.from(value, "base64"))
          ).result;
        },
      };
      protocol.handle("panxu-media", async (request) => {
        try {
          const url = new URL(request.url);
          if (
            url.hostname !== "asset" ||
            !["GET", "HEAD"].includes(request.method)
          )
            return new Response("Not found", { status: 404 });
          const name = url.pathname.slice(1),
            path = await service.studio.assetPath(name),
            size = (await stat(path)).size;
          let start = 0,
            end = size - 1,
            status = 200;
          const range = request.headers.get("range");
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (!match[1] && !match[2]))
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${size}` },
              });
            start = match[1]
              ? Number(match[1])
              : Math.max(0, size - Number(match[2]));
            end =
              match[1] && match[2]
                ? Math.min(size - 1, Number(match[2]))
                : size - 1;
            if (start > end || start >= size)
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${size}` },
              });
            status = 206;
          }
          const headers: Record<string, string> = {
            "Content-Type": name.endsWith(".mp4") ? "video/mp4" : "image/png",
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
          };
          if (status === 206)
            headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
          return new Response(
            request.method === "HEAD"
              ? null
              : (Readable.toWeb(
                  createReadStream(path, { start, end }),
                ) as BodyInit),
            { status, headers },
          );
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      service = new AppService(
        app.getPath("userData"),
        codec,
        {
          quark: new QuarkProvider(transport),
          baidu: new BaiduProvider(transport),
          uc: new UcProvider(transport),
          xunlei: new XunleiProvider(transport),
          pikpak: new PikPakProvider(transport),
          guangya: new GuangyaProvider(transport),
        },
        ports,
        changed,
      );
      updater = createUpdater(
        service,
        (state) => {
          if (window && !window.isDestroyed())
            window.webContents.send("panxu:update", state);
        },
        async (version) => {
          const assertIdle = () => service.assertUpdateIdle(activeOperations);
          assertIdle();
          const result = await dialog.showMessageBox(window!, {
            type: "question",
            title: "重启并安装更新",
            message: `即将从 ${app.getVersion()} 更新到 ${version}`,
            detail:
              "请先保存正在编辑的内容。盘序会保存本机数据库快照，然后关闭并重启；工作空间和登录数据保留。",
            buttons: ["稍后", "重启并安装"],
            defaultId: 0,
            cancelId: 0,
          });
          if (result.response !== 1) return false;
          assertIdle();
          installingUpdate = true;
          service.queue.stop();
          await service.notes.flush();
          const backup = await snapshotBeforeUpdate(
            service.db,
            service.dataPath,
          );
          service.db.setSetting("updater.lastInstall", {
            from: app.getVersion(),
            to: version,
            backup,
            at: new Date().toISOString(),
          });
          service.db.run("PRAGMA wal_checkpoint(FULL)");
          quitting = true;
          return true;
        },
        () => {
          if (!installingUpdate) return;
          installingUpdate = false;
          quitting = false;
          service.queue.start();
        },
      );
      ipcMain.handle(
        "panxu:invoke",
        async (event, request: unknown): Promise<Result<unknown>> => {
          if (
            !window ||
            event.sender.id !== window.webContents.id ||
            event.senderFrame !== window.webContents.mainFrame
          )
            return {
              ok: false,
              error: {
                code: "UNTRUSTED_SENDER",
                message: "此页面无权调用桌面服务。",
              },
            };
          try {
            if (
              !request ||
              typeof request !== "object" ||
              !("method" in request) ||
              typeof request.method !== "string" ||
              request.method.length > 100
            )
              throw new AppError("INVALID_REQUEST", "请求格式不正确。");
            const args = "args" in request ? request.args : undefined;
            if (development && request.method === "dev.status")
              return {
                ok: true,
                value: {
                  mode: "development",
                  root: process.env.PANXU_DEV_ROOT,
                  revision: process.env.PANXU_DEV_REVISION,
                  builtAt: process.env.PANXU_DEV_BUILT_AT,
                  pid: process.pid,
                },
              };
            if (development && request.method === "dev.tools") {
              window.webContents.toggleDevTools();
              return { ok: true, value: true };
            }
            if (devRestarting && request.method !== "snapshot")
              throw new AppError(
                "DEV_RESTARTING",
                "后端源码已更新，正在重启开发窗口，请稍候。",
              );
            if (request.method.startsWith("updater."))
              return {
                ok: true,
                value: await updater.invoke(request.method, args),
              };
            if (installingUpdate && request.method !== "snapshot")
              throw new AppError(
                "UPDATE_INSTALLING",
                "正在准备重启安装更新，请稍候。",
              );
            if (request.method !== "snapshot") activeOperations++;
            try {
              return {
                ok: true,
                value: await service.invoke(request.method, args),
              };
            } finally {
              if (request.method !== "snapshot") activeOperations--;
            }
          } catch (error) {
            return {
              ok: false,
              error: {
                code:
                  error instanceof AppError
                    ? error.code
                    : error instanceof ZodError
                      ? "INVALID_INPUT"
                      : "OPERATION_FAILED",
                message:
                  error instanceof ZodError
                    ? "输入格式不正确，请检查必填字段及长度。"
                    : safeMessage(error),
              },
            };
          }
        },
      );
      createWindow();
      service.queue.start();
      updater.start();
      if (development && process.send) {
        process.send({
          type: "panxu:dev-ready",
          revision: process.env.PANXU_DEV_REVISION,
        });
        process.on("message", async (message) => {
          if (
            !message ||
            typeof message !== "object" ||
            !("type" in message) ||
            message.type !== "panxu:dev-restart" ||
            devRestarting
          )
            return;
          try {
            service.assertUpdateIdle(activeOperations);
            if (
              loginWindows.size ||
              clearingSessions.size ||
              ports.zhidaoSession?.isOpen?.() ||
              ports.websiteSessions?.isOpen()
            )
              throw new Error("请先完成并关闭账号登录窗口。");
            devRestarting = true;
            service.queue.stop();
            await service.notes.flush();
            service.db.run("PRAGMA wal_checkpoint(FULL)");
            quitting = true;
            app.quit();
          } catch {
            if (devRestarting) {
              devRestarting = false;
              service.queue.start();
            }
            process.send?.({
              type: "panxu:dev-busy",
              reason: "仍有任务、接口操作或账号窗口，请完成或停止后自动重启。",
            });
          }
        });
      }
      app.on("activate", () => {
        if (!window || window.isDestroyed()) createWindow();
        else window.show();
      });
    })
    .catch((error) => {
      console.error("启动失败:", safeMessage(error));
      dialog.showErrorBox(
        "盘序启动失败",
        safeMessage(error) +
          "\n原有文件未删除。请保留数据目录后排查或恢复备份。",
      );
      app.quit();
    });
  app.on("before-quit", () => {
    quitting = true;
    service?.queue.stop();
    updater?.dispose();
  });
  app.on("window-all-closed", () => app.quit());
}
