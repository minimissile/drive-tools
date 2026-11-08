import { access, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import type { LocalVideoRuntime } from "../../shared/video";

export interface LocalVideoRuntimeOptions {
  browserExecutable?: string;
  bundlePath?: string;
  binariesDirectory?: string;
}

/** spawn() cannot execute inside asar even when Electron's fs can read it. */
export function unpackedVideoBinaryPath(path: string) {
  return path.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

export function localVideoBinariesDirectory() {
  const musl =
    existsSync("/lib/ld-musl-x86_64.so.1") ||
    existsSync("/lib/ld-musl-aarch64.so.1");
  const packageName =
    process.platform === "darwin"
      ? `@remotion/compositor-darwin-${process.arch}`
      : process.platform === "win32"
        ? "@remotion/compositor-win32-x64-msvc"
        : `@remotion/compositor-linux-${process.arch}-${musl ? "musl" : "gnu"}`;
  const require = createRequire(import.meta.url);
  return unpackedVideoBinaryPath(
    dirname(require.resolve(`${packageName}/package.json`)),
  );
}

async function executable(path: string) {
  try {
    if (!isAbsolute(path) || !(await stat(path)).isFile()) return false;
    await access(
      path,
      process.platform === "win32" ? constants.R_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/** Discovery only: this must never call Remotion's automatic browser downloader. */
export async function getLocalVideoRuntime(
  options: LocalVideoRuntimeOptions = {},
): Promise<LocalVideoRuntime> {
  const configured =
    options.browserExecutable || process.env.PANXU_VIDEO_BROWSER_PATH;
  let browserExecutable: string | null = null;
  if (configured) {
    if (await executable(configured)) browserExecutable = configured;
  } else {
    const candidates =
      process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            join(
              homedir(),
              "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ),
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : process.platform === "win32"
          ? [
              join(
                process.env.PROGRAMFILES || "C:\\Program Files",
                "Google/Chrome/Application/chrome.exe",
              ),
              join(
                process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
                "Microsoft/Edge/Application/msedge.exe",
              ),
              join(
                process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"),
                "Google/Chrome/Application/chrome.exe",
              ),
            ]
          : [
              "/usr/bin/google-chrome",
              "/usr/bin/google-chrome-stable",
              "/usr/bin/chromium",
              "/usr/bin/chromium-browser",
              "/opt/google/chrome/chrome",
            ];
    // Reuse an existing Playwright installation; executablePath() does not install anything.
    try {
      const { chromium } = await import("playwright-core");
      candidates.push(chromium.executablePath());
    } catch {
      // A normal Chrome installation is enough; Playwright is not required by the renderer.
    }
    for (const candidate of candidates) {
      if (await executable(candidate)) {
        browserExecutable = candidate;
        break;
      }
    }
  }
  if (!browserExecutable)
    return {
      available: false,
      browserExecutable: null,
      message: configured
        ? "指定的本地浏览器无法运行，请检查 PANXU_VIDEO_BROWSER_PATH。"
        : "未找到本地 Chrome 或 Chromium。安装免费浏览器后即可制作视频。",
    };
  try {
    await import("@remotion/renderer");
    const binaries = options.binariesDirectory ?? localVideoBinariesDirectory();
    const suffix = process.platform === "win32" ? ".exe" : "";
    if (
      !(await executable(join(binaries, `remotion${suffix}`))) ||
      !(await executable(join(binaries, `ffmpeg${suffix}`)))
    )
      throw new Error("missing local compositor binaries");
  } catch {
    return {
      available: false,
      browserExecutable,
      message: "本地视频渲染组件未就绪，请重新安装项目依赖。",
    };
  }
  if (options.bundlePath) {
    try {
      if (
        !isAbsolute(options.bundlePath) ||
        !(await stat(join(options.bundlePath, "index.html"))).isFile()
      )
        throw new Error("missing bundle");
    } catch {
      return {
        available: false,
        browserExecutable,
        message: "视频模板构建未就绪，请重新构建视频模板。",
      };
    }
  }
  return {
    available: true,
    browserExecutable,
    message: "本地渲染已就绪，制作时无需云端接口。",
  };
}
