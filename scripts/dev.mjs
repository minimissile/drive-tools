import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";
import { createServer } from "vite";
import updateConfig from "./update-config.cjs";
import { syncMacDevIdentity } from "./dev-macos.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devPort = Number(process.env.PANXU_DEV_PORT || 5173);
if (!Number.isInteger(devPort) || devPort < 1024 || devPort > 65535)
  throw new Error("开发端口需为1024–65535之间的整数。");
const devUrl = `http://127.0.0.1:${devPort}`;
const output = join(root, "dist-dev");
const require = createRequire(import.meta.url);
const states = new Map(),
  builds = [];
let devExecutable = require("electron");
let child,
  server,
  debounce,
  retry,
  stopping = false,
  restartPending = false,
  revision = 0;
let lastBusy = "";
const log = (message) => console.log(`[盘序开发] ${message}`);
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(debounce);
  clearTimeout(retry);
  if (child && child.exitCode == null) child.kill("SIGTERM");
  await Promise.allSettled([
    ...builds.map((b) => b.dispose()),
    server?.close(),
  ]);
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
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [output];
  // Optional test/debug endpoint; ordinary development opens no debugging port.
  if (env.PANXU_DEV_CDP_PORT) {
    if (!/^\d+$/.test(env.PANXU_DEV_CDP_PORT))
      throw new Error("调试端口必须是数字。");
    args.push(
      `--remote-debugging-port=${env.PANXU_DEV_CDP_PORT}`,
      "--remote-debugging-address=127.0.0.1",
    );
  }
  let ready = false;
  const current = (child = spawn(devExecutable, args, {
    cwd: root,
    env,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  }));
  current.on("message", (message) => {
    if (message?.type === "panxu:dev-busy") {
      if (message.reason !== lastBusy)
        log(`后端已更新，等待安全重启：${message.reason}`);
      lastBusy = message.reason;
      clearTimeout(retry);
      retry = setTimeout(requestRestart, 1500);
    }
    if (message?.type === "panxu:dev-ready") {
      ready = true;
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
    if (restartPending && !stopping) {
      restartPending = false;
      lastBusy = "";
      launch();
    } else if (!stopping) {
      if (code || !ready)
        console.error(
          "开发窗口退出，请检查是否仍打开着安装版；请先退出安装版，再运行 npm run dev。",
        );
      void stop(code ?? 0);
    }
  });
}
function requestRestart() {
  if (stopping || [...states.values()].some((v) => !v)) return;
  if (!child) {
    launch();
    return;
  }
  restartPending = true;
  if (child.connected) child.send({ type: "panxu:dev-restart" }, () => {});
}
function watchPlugin(name) {
  return {
    name: `panxu-dev-${name}`,
    setup(build) {
      build.onStart(() => {
        states.set(name, false);
      });
      build.onEnd((result) => {
        states.set(name, result.errors.length === 0);
        if (result.errors.length) {
          log(
            `${name}编译失败，当前窗口继续使用上一次可用后端；修复后自动重试。`,
          );
          return;
        }
        revision++;
        clearTimeout(debounce);
        debounce = setTimeout(requestRestart, 250);
      });
    },
  };
}
try {
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
    server: { port: devPort },
    configFile: join(root, "vite.config.ts"),
    plugins: [
      {
        name: "panxu-dev-identity",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== "/__panxu_dev") return next();
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            response.end(
              JSON.stringify({ root, mode: "development", revision }),
            );
          });
        },
      },
    ],
  });
  await server.listen();
  const common = {
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    target: "node24",
    sourcemap: true,
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
    states.set(name, false);
    builds.push(
      await context({ ...common, ...options, plugins: [watchPlugin(name)] }),
    );
  }
  log(`源码：${root}`);
  log(
    `前端 ${devUrl} · React/CSS热更新 · core/shared/desktop修改后自动编译，空闲时重启后端。`,
  );
  log(
    "开发输出使用 dist-dev，生产 build 不会覆盖当前调试后端。Ctrl+C停止开发服务。",
  );
  await Promise.all(builds.map((b) => b.watch()));
} catch (error) {
  console.error(`开发环境启动失败：${error.message}`);
  await stop(1);
}
