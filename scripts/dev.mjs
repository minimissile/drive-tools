import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";
import { createServer } from "vite";
import updateConfig from "./update-config.cjs";
import { syncMacDevIdentity } from "./dev-macos.mjs";
import { acquireDevLock, stopDevChild } from "./dev-lifecycle.mjs";
import { DevUpdates } from "./dev-updates.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devPort = Number(process.env.PANXU_DEV_PORT || 8070);
if (!Number.isInteger(devPort) || devPort < 1024 || devPort > 65535)
  throw new Error("开发端口需为1024–65535之间的整数。");
const devUrl = `http://127.0.0.1:${devPort}`;
const output = join(root, "dist-dev");
const descriptorPath = join(root, ".panxu-dev-session.json");
const sessionToken = randomBytes(32).toString("hex");
const sessionRequests = new Map();
let sessions = process.env.PANXU_DEV_SESSIONS
    ? JSON.parse(process.env.PANXU_DEV_SESSIONS)
    : [],
  desktopReady = false,
  cdpPort;
const require = createRequire(import.meta.url);
const builds = [];
let devExecutable = require("electron");
let child,
  server,
  releaseDevLock,
  starting,
  stopping = false,
  restartPending = false,
  revision = 0;
const log = (message) => console.log(`[盘序开发] ${message}`);
const updates = new DevUpdates(["main", "preload"], publishUpdates);
function publishUpdates() {
  if (desktopReady && child?.connected && !stopping)
    child.send({ type: "panxu:dev-updates", state: updates.state }, () => {});
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  // Let in-flight startup finish assigning resources before disposing them.
  // launch() checks stopping, so cancellation cannot open another desktop.
  await starting?.catch(() => {});
  await stopDevChild(child);
  for (const request of sessionRequests.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("开发后台已停止。"));
  }
  sessionRequests.clear();
  await Promise.allSettled([
    ...builds.map((b) => b.dispose()),
    server?.close(),
  ]);
  if (releaseDevLock) await rm(descriptorPath, { force: true });
  try {
    await releaseDevLock?.();
  } catch (error) {
    if (error.code !== "ERELEASED") throw error;
  }
  releaseDevLock = undefined;
  process.exitCode = code;
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
function launch() {
  if (stopping) return;
  const env = {
    ...process.env,
    PANXU_DEV_URL: devUrl,
    PANXU_DEV_ROOT: root,
    PANXU_DEV_REVISION: String(revision),
    PANXU_DEV_BUILT_AT: new Date().toISOString(),
    PANXU_DEV_SESSIONS: JSON.stringify(sessions),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [output];
  // Local development automation attaches to an existing window, never a second app.
  if (cdpPort) {
    args.push(
      `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
    );
  }
  let ready = false;
  desktopReady = false;
  const current = (child = spawn(devExecutable, args, {
    cwd: root,
    env,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  }));
  current.on("message", (message) => {
    if (child !== current) return;
    if (message?.type === "panxu:dev-sessions") sessions = message.sessions;
    if (message?.type === "panxu:session-result") {
      const request = sessionRequests.get(message.requestId);
      if (request) {
        clearTimeout(request.timer);
        sessionRequests.delete(message.requestId);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.value);
      }
    }
    if (message?.type === "panxu:dev-busy") {
      restartPending = false;
      updates.cancel(
        message.reason || "当前还有任务，请稍后再次点击应用更新。",
      );
      log(`本次未重启；完成当前操作后请再次点击应用更新。`);
    }
    if (message?.type === "panxu:dev-apply-updates") {
      void applyUpdates().catch((error) => log(error.message));
    }
    if (message?.type === "panxu:dev-ready") {
      ready = true;
      desktopReady = true;
      updates.ready();
      log(`开发窗口就绪 · 后端 #${message.revision} · PID ${current.pid}`);
    }
  });
  current.on("error", (error) => {
    console.error(error.message);
    void stop(1);
  });
  current.on("exit", (code) => {
    if (child !== current) return;
    child = undefined;
    desktopReady = false;
    for (const request of sessionRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("开发后台正在重启，请稍后重试。"));
    }
    sessionRequests.clear();
    if (restartPending && !stopping) {
      restartPending = false;
      void installAndLaunch();
    } else if (!stopping) {
      if (code || !ready)
        console.error(
          "开发窗口退出，请检查是否仍打开着安装版；请先退出安装版，再运行 npm run dev。",
        );
      void stop(code ?? 0);
    }
  });
}
function sessionRequest(action, args) {
  if (!desktopReady || !child?.connected || stopping)
    return Promise.reject(new Error("开发窗口尚未就绪，请稍后重试。"));
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      sessionRequests.delete(requestId);
      reject(new Error("会话窗口操作超时，请检查开发后台。"));
    }, 15000);
    sessionRequests.set(requestId, { resolve, reject, timer });
    child.send(
      { type: "panxu:session-request", requestId, action, args },
      (error) => {
        if (!error) return;
        clearTimeout(timer);
        sessionRequests.delete(requestId);
        reject(error);
      },
    );
  });
}
function sessionsMiddleware(request, response, next) {
  if (request.url !== "/__panxu_dev/sessions") return next();
  const provided = Buffer.from(String(request.headers.authorization ?? ""));
  const expected = Buffer.from(`Bearer ${sessionToken}`);
  if (
    request.method !== "POST" ||
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    response.writeHead(403).end();
    return;
  }
  let raw = "",
    tooLarge = false;
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 8192) {
      tooLarge = true;
      raw = "";
      response.writeHead(413).end();
      request.destroy();
    }
  });
  request.on("end", async () => {
    if (tooLarge) return;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    try {
      const input = JSON.parse(raw);
      if (
        ![
          "dev.sessions",
          "dev.session.open",
          "dev.session.update",
          "dev.session.close",
          "dev.session.focus",
          "dev.updates",
          "dev.applyUpdates",
        ].includes(input.action)
      )
        throw new Error("未知的会话操作。");
      const value =
        input.action === "dev.updates"
          ? updates.state
          : input.action === "dev.applyUpdates"
            ? await applyUpdates()
            : await sessionRequest(input.action, input.args);
      response.end(JSON.stringify({ value }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
}
async function debuggingPort() {
  const requested = Number(process.env.PANXU_DEV_CDP_PORT || 0);
  if (
    !Number.isInteger(requested) ||
    requested < 0 ||
    requested > 65535 ||
    (requested > 0 && requested < 1024)
  )
    throw new Error("调试端口需为0或1024–65535之间的整数。");
  const socket = createNetServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(requested, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function installAndLaunch() {
  try {
    revision = await updates.install();
    launch();
  } catch (error) {
    updates.cancel(`后端更新写入失败：${error.message}`);
    console.error(error.message);
    await stop(1);
  }
}
async function applyUpdates() {
  if (stopping) throw new Error("开发服务正在停止。");
  if (updates.state.applying) return updates.state;
  // No retry timer: one user action authorizes exactly one restart attempt.
  try {
    updates.begin();
    if (!child) {
      await installAndLaunch();
    } else if (desktopReady && child.connected) {
      restartPending = true;
      child.send({ type: "panxu:dev-restart" }, (error) => {
        if (!error) return;
        restartPending = false;
        updates.cancel("重启请求发送失败，请检查开发服务后重试。");
      });
    } else {
      throw new Error("开发窗口尚未就绪，请稍后重试。");
    }
  } catch (error) {
    updates.cancel(error.message);
  }
  return updates.state;
}
function watchPlugin(name) {
  return {
    name: `panxu-dev-${name}`,
    setup(build) {
      build.onStart(() => {
        updates.start(name);
      });
      build.onEnd((result) => {
        const previousRevision = updates.state.revision;
        updates.finish(name, result);
        if (result.errors.length) {
          log(`${name}编译失败，当前窗口继续使用上一次可用后端。`);
          return;
        }
        if (updates.state.revision !== previousRevision && child)
          log(`后端 #${updates.state.revision} 编译完成，等待手动应用。`);
        // Only first startup is automatic; all later generations stay pending.
        if (
          !child &&
          !updates.state.compiling &&
          !updates.state.buildError &&
          !stopping
        )
          void applyUpdates();
      });
    },
  };
}
async function start() {
  releaseDevLock = await acquireDevLock(root, (error) => {
    console.error(`开发启动锁失效：${error.message}`);
    void stop(1);
  });
  cdpPort = await debuggingPort();
  await mkdir(output, { recursive: true });
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const productName = pkg.productName ?? pkg.build.productName;
  if (process.platform === "darwin") {
    const identity = await syncMacDevIdentity({
      root,
      executable: require("electron"),
      productName,
      appId: pkg.build.appId,
    });
    devExecutable = identity.executable;
    if (identity.changed) log(`macOS 程序坞名称已同步为“${productName}”。`);
  }
  await writeFile(
    join(output, "package.json"),
    JSON.stringify({
      name: pkg.name,
      productName,
      version: pkg.version,
      type: "module",
      main: "main.js",
    }),
  );
  await writeFile(
    join(output, "update-config.json"),
    JSON.stringify(updateConfig.getUpdateConfig()),
  );
  server = await createServer({
    root,
    server: {
      host: "127.0.0.1",
      port: devPort,
      strictPort: true,
      fs: {
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem}",
          "**/.git/**",
          "**/.panxu-dev-session.json",
          "**/.panxu-dev-session.json.*.tmp",
        ],
      },
    },
    configFile: join(root, "vite.config.ts"),
    plugins: [
      {
        name: "panxu-dev-identity",
        configureServer(vite) {
          vite.middlewares.use(sessionsMiddleware);
          vite.middlewares.use((request, response, next) => {
            if (request.url !== "/__panxu_dev") return next();
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            response.end(
              JSON.stringify({
                root,
                mode: "development",
                revision,
                updatePolicy: "manual",
              }),
            );
          });
        },
      },
    ],
  });
  await server.listen();
  const descriptorTemporary = `${descriptorPath}.${process.pid}.tmp`;
  await writeFile(
    descriptorTemporary,
    JSON.stringify({
      root,
      url: devUrl,
      token: sessionToken,
      cdpPort,
      pid: process.pid,
    }),
    { mode: 0o600 },
  );
  await rename(descriptorTemporary, descriptorPath);
  const common = {
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    target: "node24",
    sourcemap: true,
    write: false,
    logLevel: "info",
  };
  for (const [name, options] of [
    [
      "main",
      {
        entryPoints: ["desktop/main.ts"],
        outfile: join(output, "main.js"),
        format: "esm",
        packages: "external",
      },
    ],
    [
      "preload",
      {
        entryPoints: ["desktop/preload.ts"],
        outfile: join(output, "preload.cjs"),
        format: "cjs",
        external: ["electron"],
      },
    ],
  ]) {
    builds.push(
      await context({ ...common, ...options, plugins: [watchPlugin(name)] }),
    );
  }
  log(`源码：${root}`);
  log(
    `前端 ${devUrl} · React/CSS热更新 · 后端修改自动编译，点击“应用更新并重启”后统一加载。`,
  );
  log(
    "开发输出使用 dist-dev，生产 build 不会覆盖当前调试后端。Ctrl+C停止开发服务。",
  );
  await Promise.all(builds.map((b) => b.watch()));
}
starting = start();
void starting.catch((error) => {
  console.error(`开发环境启动失败：${error.message}`);
  void stop(1);
});
