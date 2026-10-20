import { execFile } from "node:child_process";
import {
  copyFile,
  realpath,
  rename,
  rm,
  utimes,
  symlink,
} from "node:fs/promises";
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
  if (
    !productName ||
    /[\\/\x00-\x1f]/.test(productName) ||
    [".", ".."].includes(productName)
  )
    throw new Error("开发应用名称无效。");
  let bundle = await realpath(resolve(dirname(executable), "../.."));
  const originalBundle = bundle;
  const dependencies = await realpath(join(root, "node_modules"));
  const within = relative(dependencies, bundle);
  if (
    !within ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within) ||
    !["Electron.app", `${productName}.app`].includes(basename(bundle))
  )
    throw new Error(
      "开发名称只能同步到当前项目 node_modules 内的 Electron.app。",
    );

  // Dock can retain the Electron bundle filename even when the plist name is set.
  // Keep the npm executable path valid with a relative alias; launch the real bundle.
  let renamed = false;
  if (basename(bundle) === "Electron.app") {
    const destination = join(dirname(bundle), `${productName}.app`);
    await rename(bundle, destination);
    try {
      await symlink(basename(destination), originalBundle);
    } catch (error) {
      await rename(destination, originalBundle);
      throw error;
    }
    bundle = destination;
    renamed = true;
  }
  const resolvedExecutable = join(bundle, "Contents", "MacOS", "Electron");
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
    CFBundleIconFile: "panxu-dev.icns",
  };
  const iconPath = join(root, "build", "icon.icns");
  await copyFile(
    iconPath,
    join(bundle, "Contents", "Resources", expected.CFBundleIconFile),
  );
  const fieldsChanged = !Object.entries(expected).every(
    ([key, value]) => current[key] === value,
  );
  if (!fieldsChanged) {
    const now = new Date();
    await utimes(bundle, now, now);
    await register(bundle);
    return {
      changed: renamed,
      bundle,
      executable: resolvedExecutable,
      ...expected,
    };
  }

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
  return { changed: true, bundle, executable: resolvedExecutable, ...expected };
}
