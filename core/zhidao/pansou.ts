import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { fetchJson } from "../http";
import { AppError } from "../errors";
import { normalizedName } from "./parsers";

export function pansouUrl(raw: string) {
  const u = new URL(raw);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw new AppError(
      "INVALID_LOCAL_URL",
      "PanSou 地址需为本机 HTTP 服务根地址。",
    );
  return u.origin;
}
export class Pansou {
  private process: ChildProcess | null = null;
  private base = "";
  private starting: Promise<string> | null = null;
  constructor(
    private dataPath: string,
    private binary?: string,
    private request = fetchJson,
  ) {}
  get configured() {
    return !!this.binary && existsSync(this.binary);
  }
  async start(external = "") {
    if (external) return pansouUrl(external);
    if (this.base && this.process && this.process.exitCode == null)
      return this.base;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }
  private async launch() {
    if (!this.configured)
      throw new AppError(
        "PANSOU_MISSING",
        "本机缺少 PanSou 服务，请在采集设置中连接已有本地服务。",
      );
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
    const cache = join(this.dataPath, "pansou-cache");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const child = spawn(this.binary!, [], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        CACHE_PATH: cache,
        CHANNELS: "",
        ENABLED_PLUGINS:
          "xiaokupan,huban,leso,hjzhencai,wanou,melost,yunso,xiaoyu,diduan,ash,ikantv,muou,meitizy,nsgame,zxzj",
        ASYNC_PLUGIN_ENABLED: "true",
        ASYNC_RESPONSE_TIMEOUT: "5",
        PANXU_PARENT_PID: String(process.pid),
      },
      stdio: "ignore",
      windowsHide: true,
    });
    this.process = child;
    let failed = false;
    child.on("error", () => {
      failed = true;
    });
    child.once("exit", () => {
      if (this.process === child) this.base = "";
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      if (failed || child.exitCode != null) break;
      try {
        await this.request(base + "/api/health", {}, 1000);
        this.base = base;
        return base;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    this.stop();
    throw new AppError(
      "PANSOU_UNAVAILABLE",
      "PanSou 服务未就绪，已保留其他来源结果；可连接本地服务后重试。",
    );
  }
  async search(keyword: string, external: string, signal: AbortSignal) {
    const base = await this.start(external);
    const response = await this.request(
      base + "/api/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kw: keyword,
          src: "all",
          res: "merge",
          cloud_types: ["baidu"],
          conc: 10,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      },
      120000,
    );
    const rows = response.data?.merged_by_type?.baidu;
    if (!Array.isArray(rows))
      throw new AppError(
        "PANSOU_RESPONSE",
        "PanSou 未返回可识别的百度网盘结果。",
      );
    const candidates = rows
      .filter(
        (r) =>
          typeof r.url === "string" &&
          /^https:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?|$)/.test(r.url),
      )
      .map((r) => ({
        name: String(r.note ?? r.title ?? keyword).slice(0, 100),
        link: String(r.url),
        code: String(r.password ?? ""),
        score: normalizedName(String(r.note ?? r.title ?? "")).includes(
          normalizedName(keyword),
        )
          ? 1
          : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (!candidates.length) return [];
    const checked = await this.request(
      base + "/api/check/links",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: candidates.map((c) => ({
            disk_type: "baidu",
            url: c.link,
            password: c.code,
          })),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      },
      60000,
    );
    const states = checked.results ?? checked.data?.results;
    if (!Array.isArray(states))
      throw new AppError(
        "PANSOU_CHECK_RESPONSE",
        "链接验活未返回可识别结果，未标记可用。",
      );
    return candidates.filter((c) =>
      states.some((s) => s.url === c.link && s.state === "ok"),
    );
  }
  stop() {
    const child = this.process;
    this.process = null;
    this.base = "";
    if (child && child.exitCode == null) {
      child.kill();
      const timer = setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
      }, 3000);
      timer.unref();
    }
  }
}
