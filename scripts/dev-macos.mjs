import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
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

function assertProductName(productName) {
  if (
    !productName ||
    /[\\/\x00-\x1f]/.test(productName) ||
    [".", ".."].includes(productName)
  )
    throw new Error("开发应用名称无效。");
}

async function existingFile(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Restore the canonical install location left by older development branding. */
export async function restoreMacElectronBundle({ root, productName }) {
  assertProductName(productName);
  const dist = join(root, "node_modules", "electron", "dist");
  const canonical = join(dist, "Electron.app");
  if (!(await existingFile(canonical))?.isSymbolicLink()) return;
  const legacy = join(dist, `${productName}.app`);
  if (resolve(dist, await readlink(canonical)) !== legacy)
    throw new Error("Electron.app 指向未知位置，请检查 Electron 安装目录。");
  const target = await existingFile(legacy);
  if (target && (!target.isDirectory() || target.isSymbolicLink()))
    throw new Error("旧开发应用目录异常，请检查 Electron 安装目录。");
  await unlink(canonical);
  if (target) await rename(legacy, canonical);
}

// app.setName() is internal to Electron; macOS reads the copied bundle's fields.
// Keep npm's Electron.app intact so reinstalling never traverses a branding alias.
export async function syncMacDevIdentity({
  root,
  executable,
  productName,
  appId,
  register = registerBundle,
}) {
  assertProductName(productName);
  const source = await realpath(resolve(dirname(executable), "../.."));
  const dependencies = await realpath(join(root, "node_modules"));
  const within = relative(dependencies, source);
  if (
    !within ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within) ||
    !["Electron.app", `${productName}.app`].includes(basename(source))
  )
    throw new Error(
      "开发名称只能同步到当前项目 node_modules 内的 Electron.app。",
    );

  const sourceExecutable = await stat(join(source, "Contents/MacOS/Electron"));
  const sourcePlist = await readFile(
    join(source, "Contents/Info.plist"),
    "utf8",
  );
  const fingerprint = JSON.stringify({
    source,
    size: sourceExecutable.size,
    modified: sourceExecutable.mtimeMs,
    plist: sourcePlist,
  });
  const cache = join(dependencies, ".cache", "panxu-dev-runtime");
  await mkdir(cache, { recursive: true });
  const bundle = join(cache, `${productName}.app`);
  const resolvedExecutable = join(bundle, "Contents/MacOS/Electron");
  const sourceRecord = join(cache, `${productName}.source.json`);
  const recorded = (await existingFile(sourceRecord))
    ? await readFile(sourceRecord, "utf8")
    : "";
  const copied =
    recorded !== fingerprint || !(await existingFile(resolvedExecutable));
  if (copied) {
    const staging = await mkdtemp(join(cache, ".prepare-"));
    try {
      const next = join(staging, `${productName}.app`);
      await cp(source, next, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
      await rm(bundle, { recursive: true, force: true });
      await rename(next, bundle);
      await writeFile(sourceRecord, fingerprint);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
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
  const iconPath = join(root, "build", "icon-dev.icns");
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
      changed: copied,
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
