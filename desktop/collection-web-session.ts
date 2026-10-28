import { BrowserWindow, session, type Session } from "electron";
import { createHash } from "node:crypto";
import { AppError } from "../core/errors";
import type { AppPorts } from "../core/ports";
import {
  collectionWebSpecs,
  type CollectionWebSource,
} from "../shared/resource-collection";

type Context = { profile: Session; view?: BrowserWindow; busy: boolean };
type SearchInput = {
  source: CollectionWebSource;
  keyword: string;
  page: number;
};

/** Runs only the site's search client in its own origin. Its visitor checks and cookies stay in Chromium. */
async function browserSearch(input: SearchInput) {
  const origin = location.origin;
  const readScript = async (url: string) => {
    const target = new URL(url, origin);
    if (target.origin !== origin || !target.pathname.endsWith(".js"))
      throw new Error("SCRIPT_ORIGIN");
    const response = await fetch(target.href, { credentials: "same-origin" });
    if (
      !response.ok ||
      Number(response.headers.get("content-length") || 0) > 2_000_000
    )
      throw new Error("SCRIPT_RESPONSE");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SCRIPT_BODY");
    const decoder = new TextDecoder();
    let content = "",
      size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2_000_000) throw new Error("SCRIPT_SIZE");
        content += decoder.decode(chunk.value, { stream: true });
      }
      return content + decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
  if (input.source === "haisou") {
    const urls = [
      ...document.querySelectorAll<HTMLLinkElement>(
        'link[rel="modulepreload"]',
      ),
    ].map((node) => node.href);
    for (const node of document.querySelectorAll('script[type="importmap"]')) {
      try {
        const entry = JSON.parse(node.textContent || "{}").imports?.["#entry"];
        if (typeof entry === "string")
          urls.unshift(new URL(entry, origin).href);
      } catch {}
    }
    const visited = new Set<string>();
    for (let index = 0; index < urls.length && visited.size < 18; index++) {
      const url = new URL(urls[index], origin);
      if (url.origin !== origin || visited.has(url.href)) continue;
      visited.add(url.href);
      const text = await readScript(url.href);
      if (text.includes("/api/v2/shares/search")) {
        const imported = await import(/* @vite-ignore */ url.href);
        const client = Object.values(imported).find(
          (value: any) =>
            value &&
            typeof value.request === "function" &&
            typeof value.addRequestInterceptor === "function",
        ) as
          { request(path: string, options: unknown): Promise<any> } | undefined;
        if (!client) throw new Error("WEB_CLIENT_CHANGED");
        const result = await client.request("/api/v2/shares/search", {
          method: "POST",
          showError: false,
          retry: 0,
          timeout: 30000,
          body: {
            query: input.keyword,
            filters: {
              scope: "title",
              platforms: [
                "ali",
                "baidu",
                "quark",
                "xunlei",
                "tianyi",
                "yidong",
                "115",
                "123",
                "uc",
                "guangya",
              ],
              include_filtered: false,
            },
            pagination: { page: input.page, page_size: 20 },
          },
        });
        return {
          status: result.statusCode || 200,
          body: JSON.stringify(
            result.rawData ?? {
              success: false,
              error: { code: result.getErrorCode?.() || "WEB_REQUEST_FAILED" },
            },
          ),
        };
      }
      // Entry imports identify current asset hashes; do not pin a deployment's filenames.
      for (const match of text.matchAll(/from\s*["'`]([^"'`]+\.js)["'`]/g)) {
        const dependency = new URL(match[1], url);
        if (dependency.origin === origin && !visited.has(dependency.href))
          urls.push(dependency.href);
      }
    }
    throw new Error("WEB_CLIENT_CHANGED");
  }
  const scripts = [...document.scripts]
    .map((node) => node.src)
    .filter((url) => url && new URL(url).origin === origin);
  // The page exports the same search function used by its UI, including the site's visitor-ticket flow.
  scripts.sort(
    (a, b) => Number(b.includes("commons-")) - Number(a.includes("commons-")),
  );
  for (const url of scripts.slice(0, 14)) {
    const text = await readScript(url);
    const marker = text.indexOf("/api/search?keyword=");
    if (marker < 0) continue;
    let moduleId = "";
    for (const match of text
      .slice(0, marker)
      .matchAll(/(?:^|[,{])(\d+):(?:\([^)]*\)|\w+)=>\{/g))
      moduleId = match[1];
    if (!moduleId) throw new Error("WEB_CLIENT_CHANGED");
    const chunks = (window as unknown as { webpackChunk_N_E?: unknown[] })
      .webpackChunk_N_E;
    if (!chunks) throw new Error("WEB_CLIENT_CHANGED");
    let runtime: any;
    chunks.push([
      [`panxu-readonly-search-${crypto.randomUUID()}`],
      {},
      (value: unknown) => {
        runtime = value;
      },
    ]);
    if (typeof runtime !== "function") throw new Error("WEB_CLIENT_CHANGED");
    const exported = runtime(Number(moduleId));
    const search = Object.values(exported).find(
      (value) =>
        typeof value === "function" &&
        Function.prototype.toString
          .call(value)
          .includes("/api/search?keyword="),
    ) as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (!search) throw new Error("WEB_CLIENT_CHANGED");
    return {
      status: 200,
      body: JSON.stringify(
        await search(input.keyword, "0", input.page, 20, false, "all", "all"),
      ),
    };
  }
  throw new Error("WEB_CLIENT_CHANGED");
}

export function createCollectionWebSession(
  workspace: () => string,
): NonNullable<AppPorts["collectionWebSession"]> {
  const contexts = new Map<string, Context>();
  const context = (source: CollectionWebSource) => {
    const key = createHash("sha256")
      .update(`${workspace()}\0${source}`)
      .digest("hex")
      .slice(0, 24);
    let value = contexts.get(key);
    if (!value) {
      const profile = session.fromPartition(`persist:panxu-collection-${key}`);
      profile.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      profile.on("will-download", (event) => event.preventDefault());
      value = { profile, busy: false };
      contexts.set(key, value);
    }
    return value;
  };
  const create = (source: CollectionWebSource, visible: boolean) => {
    const ctx = context(source),
      spec = collectionWebSpecs[source];
    const win = new BrowserWindow({
      show: visible,
      width: 1200,
      height: 820,
      title: `${spec.name} · 网页采集`,
      webPreferences: {
        session: ctx.profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const allowed = (raw: string) => {
      try {
        const url = new URL(raw);
        return url.origin === spec.origin && !url.username && !url.password;
      } catch {
        return false;
      }
    };
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (visible && allowed(url)) void win.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event, url, _inPlace, mainFrame) => {
      if (mainFrame && !allowed(url)) event.preventDefault();
    });
    return win;
  };
  return {
    isOpen: () =>
      [...contexts.values()].some((ctx) => ctx.view && !ctx.view.isDestroyed()),
    async open(source) {
      const ctx = context(source);
      if (ctx.view && !ctx.view.isDestroyed()) {
        ctx.view.show();
        ctx.view.focus();
        return;
      }
      const win = create(source, true);
      ctx.view = win;
      win.on("closed", () => {
        if (ctx.view === win) ctx.view = undefined;
      });
      try {
        await win.loadURL(collectionWebSpecs[source].origin + "/");
      } catch {
        if (!win.isDestroyed()) win.destroy();
        throw new AppError(
          "COLLECTION_WEB_OPEN_FAILED",
          "采集来源网页未能打开，请检查网络后重试。",
        );
      }
    },
    async search(source, keyword, page, signal) {
      signal.throwIfAborted();
      const ctx = context(source);
      if (ctx.busy)
        throw new AppError(
          "COLLECTION_WEB_BUSY",
          "此网页渠道正在搜索，请等待当前请求完成。",
        );
      const win = create(source, false);
      ctx.busy = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const close = () => {
        if (!win.isDestroyed()) win.destroy();
      };
      const abort = () => close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await Promise.race([
          (async () => {
            await win.loadURL(collectionWebSpecs[source].origin + "/");
            signal.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 500));
            signal.throwIfAborted();
            return (await win.webContents.executeJavaScript(
              `(${browserSearch.toString()})(${JSON.stringify({ source, keyword, page })})`,
              false,
            )) as { status: number; body: string };
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              close();
              reject(
                new AppError(
                  "COLLECTION_WEB_TIMEOUT",
                  "网页搜索超时，请打开原站检查后继续任务。",
                ),
              );
            }, 60000);
          }),
        ]);
        signal.throwIfAborted();
        if (
          !result ||
          typeof result.body !== "string" ||
          Buffer.byteLength(result.body) > 2_000_000
        )
          throw new AppError(
            "COLLECTION_WEB_RESPONSE",
            "网页返回异常或过大的结果，已停止读取。",
          );
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AppError) throw error;
        throw new AppError(
          "COLLECTION_WEB_FAILED",
          `${collectionWebSpecs[source].name}网页请求失败或页面结构已变化，请打开原站检查后继续。`,
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        close();
        ctx.busy = false;
      }
    },
  };
}
