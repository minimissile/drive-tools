import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { browserProcessMode } from "./browser-process-mode";

const execute = promisify(execFile);
/** Match the exact profile directory; never guess a browser by window order. */
export function existingBitBrowserDirectory(
  command: string,
  profileId: string,
) {
  if (
    !/^[a-f0-9]{32}$/i.test(profileId) ||
    !/BitBrowser\.app\/Contents\/MacOS\/BitBrowser(?:"|\s)/.test(command) ||
    /(?:^|\s)--type(?:=|\s)/.test(command)
  )
    return null;
  const directory = command
    .match(
      /(?:^|\s)--user-data-dir=(.*?)(?=\s(?:--[\w-]+(?:=|\s|$)|[a-zA-Z][\w+.-]*:)|$)/,
    )?.[1]
    ?.trim()
    .replace(/^"|"$/g, "");
  return directory &&
    isAbsolute(directory) &&
    basename(directory) === profileId &&
    basename(dirname(directory)) === "BrowserCache"
    ? directory
    : null;
}

/** Recover a live local profile after the client loses its process registry.
 * Called only after an authenticated Local API open reports a launch failure.
 * No process is launched, stopped, or changed; PID, lock and CDP file must agree. */
export async function existingBitBrowserEndpoint(
  profileId: string,
): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,command="], {
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const matches = stdout.split("\n").flatMap((line) => {
      const row = line.match(/^\s*(\d+)\s+(.+)$/);
      const directory = row && existingBitBrowserDirectory(row[2], profileId);
      return directory ? [{ pid: Number(row![1]), directory }] : [];
    });
    if (matches.length !== 1) return null;
    const { pid, directory } = matches[0];
    if (!(await readlink(join(directory, "SingletonLock"))).endsWith(`-${pid}`))
      return null;
    const [port, path] = (
      await readFile(join(directory, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    if (
      !/^\d{1,5}$/.test(port) ||
      Number(port) < 1 ||
      Number(port) > 65535 ||
      !/^\/devtools\/browser\/[a-f0-9-]+$/i.test(path)
    )
      return null;
    if (!(await browserProcessMode(pid, profileId, Number(port), path)))
      return null;
    return `ws://127.0.0.1:${port}${path}`;
  } catch {
    return null;
  }
}
