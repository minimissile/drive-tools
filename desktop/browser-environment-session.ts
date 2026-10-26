import { app, BrowserWindow, session } from "electron";
import type {
  BrowserEnvironment,
  BrowserEnvironmentRuntime,
  EnvironmentAccountRef,
} from "../shared/browser-environments";
import { AppError } from "../core/errors";
import { isIP } from "node:net";
import {
  browserSessionFetch,
  setSessionProxyCredentials,
} from "./browser-session-fetch";
import { readLimited } from "../core/http";

/** One persistent Chromium storage partition per environment, shared by all its platforms. */
export function createEnvironmentSessions(
  resolve: (ref: EnvironmentAccountRef) => BrowserEnvironment,
) {
  const configured = new Map<string, number>();
  const credentials = new Map<Electron.Session, BrowserEnvironmentRuntime>();
  app.on("web-contents-created", (_event, contents) => {
    const env = credentials.get(contents.session);
    if (env?.proxy && env.proxy.mode !== "direct")
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  });
  const profile = (ref: EnvironmentAccountRef) => {
    const env = resolve(ref);
    if (env.engine !== "electron")
      throw new AppError(
        "ENVIRONMENT_ENGINE_MISMATCH",
        "此账号属于指纹环境，已阻止回退到内置浏览器。",
      );
    return session.fromPartition(env.profileId);
  };
  app.on("login", (event, contents, _details, auth, callback) => {
    if (!auth.isProxy || !contents) return;
    const env = credentials.get(contents.session);
    if (!env?.credentials || env.proxy?.mode === "direct" || !env.proxy) return;
    if (auth.host !== env.proxy.host || auth.port !== env.proxy.port) return;
    event.preventDefault();
    callback(env.credentials.username, env.credentials.password);
  });
  return {
    profile,
    async prepare(env: BrowserEnvironmentRuntime) {
      if (env.engine !== "electron") return;
      const current = session.fromPartition(env.profileId);
      if (configured.get(env.profileId) === env.revision) return;
      const proxy = env.proxy;
      if (proxy && proxy.mode !== "direct") {
        await current.setProxy({
          mode: "fixed_servers",
          proxyRules: `${proxy.mode === "socks5" ? "socks5" : "http"}://${proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host}:${proxy.port}`,
          proxyBypassRules: "<-loopback>",
        });
      } else await current.setProxy({ mode: "direct" });
      await current.closeAllConnections();
      await current.clearAuthCache();
      setSessionProxyCredentials(
        current,
        env.credentials && proxy && proxy.mode !== "direct"
          ? { ...env.credentials, host: proxy.host, port: proxy.port }
          : undefined,
      );
      credentials.set(current, env);
      configured.set(env.profileId, env.revision);
    },
    async assertIdle(env: BrowserEnvironment) {
      if (env.engine !== "electron") return;
      const current = session.fromPartition(env.profileId);
      if (
        BrowserWindow.getAllWindows().some(
          (win) => !win.isDestroyed() && win.webContents.session === current,
        )
      )
        throw new AppError(
          "ENVIRONMENT_WINDOW_OPEN",
          "请先关闭此环境的账号网页窗口，再修改环境或迁移账号；已登录状态会保留。",
        );
    },
    async checkNetwork(env: BrowserEnvironmentRuntime) {
      const current = session.fromPartition(env.profileId);
      const route = await current.resolveProxy("https://api.ipify.org/");
      if (env.requireProxy && /(^|;)\s*DIRECT\b/i.test(route))
        throw new AppError(
          "ENVIRONMENT_PROXY_REQUIRED",
          "此环境没有使用代理，已阻止联网操作。",
        );
      const response = await browserSessionFetch(
        current,
        "https://api.ipify.org?format=json",
        {
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
      const body = await readLimited(response, 512);
      if (!response.ok || body.length > 200)
        throw new AppError(
          "ENVIRONMENT_NETWORK_UNKNOWN",
          "代理出口检查失败，请检查环境网络后重试。",
        );
      const ip = JSON.parse(body).ip;
      if (typeof ip !== "string" || !isIP(ip))
        throw new AppError(
          "ENVIRONMENT_NETWORK_UNKNOWN",
          "未取得有效出口 IP，已保留账号状态。",
        );
      return ip;
    },
  };
}
