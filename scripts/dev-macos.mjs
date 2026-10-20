import { execFile } from "node:child_process";
import { copyFile, realpath, rename, rm, utimes } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const registerBundle = (bundle) =>
  run(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", bundle],
  );

// app.setName() is internal to Electron; macOS reads these bundle fields.
// Update only this project's npm runtime, never an installed/shared application.
export async function syncMacDevIdentity({
  root,
  executable,
  productName,
  appId,
  register = registerBundle,
}) {
  const bundle = await realpath(resolve(dirname(executable), "../.."));
  const dependencies = await realpath(join(root, "node_modules"));
  const within = relative(dependencies, bundle);
  if (
    !within ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within) ||
    basename(bundle) !== "Electron.app"
  )
    throw new Error(
      "开发名称只能同步到当前项目 node_modules 内的 Electron.app。",
    );

  const path = join(bundle, "Contents", "Info.plist");
  const { stdout } = await run("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    path,
  ]);
  const current = JSON.parse(stdout);
  const expected = {
    CFBundleName: productName,
    CFBundleDisplayName: productName,
    CFBundleIdentifier: `${appId}.dev`,
  };
  if (Object.entries(expected).every(([key, value]) => current[key] === value))
    return { changed: false, bundle, ...expected };

  const temporary = `${path}.panxu-${process.pid}`;
  try {
    await copyFile(path, temporary);
    for (const [key, value] of Object.entries(expected))
      await run("/usr/bin/plutil", [
        "-replace",
        key,
        "-string",
        value,
        temporary,
      ]);
    await rename(temporary, path);
    const now = new Date();
    await utimes(bundle, now, now);
  } finally {
    await rm(temporary, { force: true });
  }
  // Refresh this bundle's registration without restarting the user's Dock.
  await register(bundle);
  return { changed: true, bundle, ...expected };
}
