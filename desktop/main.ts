import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  session,
  shell,
} from "electron";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AppService, type AppPorts } from "../core/service";
import { QuarkProvider } from "../core/providers/quark";
import { BaiduProvider } from "../core/providers/baidu";
import type { ProviderTransport } from "../core/providers/provider";
import type { Account, Result } from "../shared/types";
import { AppError, ProviderHttpError, safeMessage } from "../core/errors";
import { readLimited } from "../core/http";
import { ZodError } from "zod";

app.setName("盘序");
const defaultDataPath = app.getPath("userData");
const workspaceLocation = join(defaultDataPath, "workspace-location.json");
let startupError: Error | null = null;
let selectedDataPath = process.env.PANXU_DATA_DIR;
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
let quitting = false;
const loginWindows = new Map<string, BrowserWindow>();
const clearingSessions = new Set<string>();
const partition = (accountId: string) =>
  session.fromPartition(`persist:panxu-${accountId}`);
const providerHosts = new Set([
  "pan.quark.cn",
  "drive-pc.quark.cn",
  "pan.baidu.com",
]);
function allowedProviderUrl(text: string) {
  const url = new URL(text);
  if (
    url.protocol !== "https:" ||
    !providerHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new AppError("PROVIDER_URL_BLOCKED", "网盘请求目标不在允许列表。");
  return url;
}
async function providerResponse(
  accountId: string,
  text: string,
  init: RequestInit = {},
) {
  const url = allowedProviderUrl(text);
  const requestSession = partition(accountId);
  const referrer = url.hostname.includes("quark")
    ? "https://pan.quark.cn/"
    : "https://pan.baidu.com/disk/home";
  const response = await requestSession.fetch(url.href, {
    ...init,
    credentials: "include",
    signal: AbortSignal.timeout(45_000),
    headers: { Referer: referrer, ...init.headers },
  });
  if (![200, 201].includes(response.status)) {
    let detail = "";
    let remoteCode = "";
    try {
      const data = JSON.parse(await readLimited(response, 64000));
      remoteCode = String(
        data.code ?? data.errno ?? data.error_code ?? "",
      ).slice(0, 30);
      detail = `（${String(data.code ?? data.errno ?? data.error_code ?? "").slice(0, 30)}：${String(data.message ?? data.errmsg ?? data.error_msg ?? "").slice(0, 180)}）`;
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
const transport: ProviderTransport = {
  async principalId(accountId, provider) {
    if (provider !== "quark") return null;
    const uid = (
      await partition(accountId).cookies.get({ url: "https://pan.quark.cn/" })
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
    allowedProviderUrl(url);
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
function authHostAllowed(provider: Account["provider"], text: string) {
  try {
    const u = new URL(text);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (provider === "baidu"
        ? u.hostname === "baidu.com" || u.hostname.endsWith(".baidu.com")
        : u.hostname === "quark.cn" ||
          u.hostname.endsWith(".quark.cn") ||
          u.hostname === "uc.cn" ||
          u.hostname.endsWith(".uc.cn"))
    );
  } catch {
    return false;
  }
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
  await auth.loadURL(
    url ??
      (account.provider === "quark"
        ? "https://pan.quark.cn/"
        : "https://pan.baidu.com/disk/main"),
  );
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
const ports: AppPorts = {
  login: (a) => openAccountWindow(a),
  async closeAccountWindow(accountId) {
    clearingSessions.add(accountId);
    try {
      const win = loginWindows.get(accountId);
      if (win && !win.isDestroyed()) win.close();
    } finally {
      clearingSessions.delete(accountId);
    }
  },
  async clearSession(accountId) {
    clearingSessions.add(accountId);
    try {
      const win = loginWindows.get(accountId);
      if (win && !win.isDestroyed()) win.close();
      await partition(accountId).clearStorageData();
      await partition(accountId).clearCache();
    } finally {
      clearingSessions.delete(accountId);
    }
  },
  async chooseDirectory(kind) {
    const result = await dialog.showOpenDialog(window!, {
      title: {
        vault: "选择Obsidian Vault根目录",
        backup: "选择备份保存目录",
        restore: "选择盘序备份文件夹",
        content: "选择内容包保存目录",
      }[kind],
      properties: ["openDirectory", "createDirectory"],
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
  async copyText(text) {
    clipboard.writeText(text);
  },
  async saveFile(name, bytes) {
    const extension = name.endsWith(".csv") ? "csv" : "png";
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: name,
      filters: [
        {
          name: extension === "csv" ? "CSV表格" : "PNG图片",
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
    width: 1320,
    height: 900,
    minWidth: 840,
    minHeight: 650,
    title: "盘序 · 内容营销工作台",
    backgroundColor: "#f6f8fc",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      // Keep job state and frames in sync while the workbench is in the background.
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
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
    if (running.length) {
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
  const devUrl = process.env.PANXU_DEV_URL;
  if (devUrl) {
    const u = new URL(devUrl);
    if (u.origin !== "http://127.0.0.1:5173")
      throw new Error("开发服务地址不在允许范围。");
    void window.loadURL(devUrl);
  } else void window.loadFile(join(import.meta.dirname, "../dist/index.html"));
}
const locked = app.requestSingleInstanceLock();
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
      service = new AppService(
        app.getPath("userData"),
        codec,
        {
          quark: new QuarkProvider(transport),
          baidu: new BaiduProvider(transport),
        },
        ports,
        changed,
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
            return {
              ok: true,
              value: await service.invoke(request.method, args),
            };
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
  });
  app.on("window-all-closed", () => app.quit());
}
