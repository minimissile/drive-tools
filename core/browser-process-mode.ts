import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";

const execute = promisify(execFile);
export interface BrowserProcessMode {
  headless: boolean;
  owned: boolean;
}

/** Read only the selected local browser process; command lines never leave this module. */
export async function browserProcessMode(
  pid: number,
  profileId: string,
  debugPort: number,
  debugPath: string,
): Promise<BrowserProcessMode | null> {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !profileId ||
    !Number.isSafeInteger(debugPort) ||
    debugPort <= 0
  )
    return null;
  try {
    let command: string;
    if (process.platform === "linux")
      command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(
        /\0/g,
        " ",
      );
    else if (process.platform === "darwin")
      command = (
        await execute("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
          timeout: 4000,
          maxBuffer: 512 * 1024,
        })
      ).stdout;
    else if (process.platform === "win32")
      command = (
        await execute(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { [Console]::Out.Write($p.CommandLine) }`,
          ],
          { windowsHide: true, timeout: 4000, maxBuffer: 512 * 1024 },
        )
      ).stdout;
    else return null;
    // Correlate the PID, selected profile and CDP endpoint before trusting its flags.
    // Reject renderer/utility children and mismatched or stale processes.
    if (
      !command.includes(profileId) ||
      !/(?:BitBrowser|[Cc]hrom(?:e|ium))/i.test(command) ||
      /(?:^|\s)--type(?:=|\s)/.test(command)
    )
      return null;
    const flags = new Map(
      [
        ...command.matchAll(
          /(?:^|\s)--([\w-]+)(?:=(?:"([^"]*)"|([^\s"]+)))?(?=\s|$)/g,
        ),
      ].map((m) => [m[1], m[2] ?? m[3] ?? ""]),
    );
    const port = Number(flags.get("remote-debugging-port"));
    if (port === 0) {
      // Chromium chooses a port at launch and writes the actual endpoint in its profile.
      const directory = command
        .match(
          /(?:^|\s)--user-data-dir=(.*?)(?=\s(?:--[\w-]+(?:=|\s|$)|[a-zA-Z][\w+.-]*:)|$)/,
        )?.[1]
        ?.trim()
        .replace(/^"|"$/g, "");
      if (
        !directory ||
        !isAbsolute(directory) ||
        !directory.includes(profileId)
      )
        return null;
      const endpoint = (
        await readFile(join(directory, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split(/\r?\n/);
      if (Number(endpoint[0]) !== debugPort || endpoint[1] !== debugPath)
        return null;
    } else if (port !== debugPort) return null;
    return {
      headless: flags.has("headless"),
      owned: flags.has("panxu-drive-headless"),
    };
  } catch {
    return null;
  }
}
