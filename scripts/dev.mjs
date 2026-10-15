import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";
await import("./build-desktop.mjs");
const require = createRequire(import.meta.url);
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  stdio: "inherit",
});
let electron;
const quit = () => {
  electron?.kill();
  vite.kill();
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
for (let i = 0; i < 80; i++) {
  try {
    const response = await fetch("http://127.0.0.1:5173");
    if (response.ok) break;
  } catch {
    /* wait for Vite */
  }
  if (i === 79) throw new Error("前端开发服务启动超时。");
  await setTimeout(250);
}
const env = { ...process.env, PANXU_DEV_URL: "http://127.0.0.1:5173" };
delete env.ELECTRON_RUN_AS_NODE;
electron = spawn(require("electron"), ["."], { stdio: "inherit", env });
electron.on("exit", () => {
  vite.kill();
  process.exit();
});
