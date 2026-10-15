import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
const root = resolve(process.env.PANXU_RELEASE_DIR ?? "release");
const candidates =
  process.platform === "win32"
    ? [join(root, "win-unpacked", "盘序.exe")]
    : process.platform === "darwin"
      ? [
          join(
            root,
            process.arch === "arm64" ? "mac-arm64" : "mac",
            "盘序.app",
            "Contents",
            "MacOS",
            "盘序",
          ),
        ]
      : [];
const executable = candidates.find(existsSync);
if (!executable)
  throw new Error(`没有找到本机架构的打包应用：${candidates.join(", ")}`);
const child = spawn(process.execPath, ["scripts/e2e.mjs"], {
  stdio: "inherit",
  env: { ...process.env, PANXU_ELECTRON_PATH: executable },
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
