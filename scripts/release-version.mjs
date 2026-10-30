import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inc, valid } from "semver";

function requireStableVersion(version) {
  if (
    typeof version !== "string" ||
    valid(version) !== version ||
    !/^\d+\.\d+\.\d+$/.test(version)
  )
    throw new Error(`必须使用规范的稳定 x.y.z 版本号：${version}`);
}

export function nextReleaseVersion(version, mode) {
  requireStableVersion(version);
  if (!["full", "differential"].includes(mode))
    throw new Error("升级模式仅支持 full 或 differential。");
  const next = inc(version, mode === "full" ? "minor" : "patch");
  requireStableVersion(next);
  return next;
}

export async function readVersionFiles(root) {
  const [packageText, lockText] = await Promise.all([
    readFile(join(root, "package.json"), "utf8"),
    readFile(join(root, "package-lock.json"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);
  const lockJson = JSON.parse(lockText);
  if (
    !packageJson ||
    typeof packageJson !== "object" ||
    Array.isArray(packageJson) ||
    !lockJson ||
    typeof lockJson !== "object" ||
    Array.isArray(lockJson)
  )
    throw new Error("package.json 和 package-lock.json 必须是 JSON 对象。");
  return {
    version: packageJson.version,
    packageJson,
    lockJson,
    packageText,
    lockText,
  };
}

function changedFile(path) {
  const error = new Error(`文件已被外部修改，未覆盖：${path}`);
  error.code = "RELEASE_FILE_CHANGED";
  return error;
}

async function checkExpectedText(path, expectedText) {
  if (expectedText === undefined) return;
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (expectedText === null) return;
    throw changedFile(path);
  }
  if (expectedText === null || actual !== expectedText) throw changedFile(path);
}

export async function writeReleaseFileAtomic(
  path,
  text,
  { mode, expectedText } = {},
) {
  if (typeof text !== "string") throw new TypeError("写入内容必须是字符串。");
  if (
    expectedText !== undefined &&
    expectedText !== null &&
    typeof expectedText !== "string"
  )
    throw new TypeError("expectedText 必须是字符串、null 或 undefined。");
  if (
    mode !== undefined &&
    (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)
  )
    throw new TypeError("mode 必须是有效的文件权限。");
  await checkExpectedText(path, expectedText);
  let fileMode = mode;
  if (fileMode === undefined) {
    try {
      fileMode = (await stat(path)).mode & 0o7777;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fileMode = 0o644;
    }
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.panxu-release-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;
  let failure;
  try {
    handle = await open(temporary, "wx", fileMode);
    await handle.chmod(fileMode);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (expectedText === null) {
      // link() fails with EEXIST if a user created the target after our check.
      await link(temporary, path);
    } else {
      await checkExpectedText(path, expectedText);
      await rename(temporary, path);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    try {
      await unlink(temporary);
    } catch (error) {
      if (error.code !== "ENOENT" && !failure) throw error;
    }
  }
}

// Locate only the requested JSON string values. Re-serializing the entire lock
// file would unnecessarily rewrite unrelated formatting and user edits.
function replaceVersionTokens(text, paths, target) {
  const wanted = new Set(paths.map((path) => JSON.stringify(path)));
  const matches = new Map();
  let cursor = 0;
  const space = () => {
    while (/\s/.test(text[cursor] ?? "")) cursor++;
  };
  function string() {
    const start = cursor++;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === "\\") cursor++;
      else if (character === '"')
        return {
          start,
          end: cursor,
          value: JSON.parse(text.slice(start, cursor)),
        };
    }
    throw new Error("JSON 字符串未结束。");
  }
  function value(path) {
    space();
    if (text[cursor] === "{") {
      cursor++;
      space();
      if (text[cursor] !== "}") {
        while (true) {
          space();
          const key = string().value;
          space();
          cursor++; // colon; JSON.parse already validated the document.
          value([...path, key]);
          space();
          if (text[cursor] !== ",") break;
          cursor++;
        }
      }
      cursor++;
    } else if (text[cursor] === "[") {
      cursor++;
      space();
      let index = 0;
      if (text[cursor] !== "]") {
        while (true) {
          value([...path, index++]);
          space();
          if (text[cursor] !== ",") break;
          cursor++;
        }
      }
      cursor++;
    } else if (text[cursor] === '"') {
      const token = string();
      const key = JSON.stringify(path);
      if (wanted.has(key)) {
        if (matches.has(key)) throw new Error("版本字段重复，未修改版本文件。");
        matches.set(key, token);
      }
    } else {
      while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
    }
  }
  value([]);
  if (matches.size !== wanted.size)
    throw new Error("缺少可修改的版本字段，未修改版本文件。");
  let result = text;
  for (const token of [...matches.values()].sort((a, b) => b.start - a.start))
    result =
      result.slice(0, token.start) +
      JSON.stringify(target) +
      result.slice(token.end);
  return result;
}

export async function applyReleaseVersion(root, base, target) {
  requireStableVersion(base);
  requireStableVersion(target);
  const current = await readVersionFiles(root);
  const versions = [
    ["package.json version", current.packageJson.version],
    ["package-lock.json version", current.lockJson.version],
    [
      "package-lock.json packages[''].version",
      current.lockJson.packages?.[""]?.version,
    ],
  ];
  for (const [field, version] of versions)
    if (version !== base && version !== target)
      throw new Error(
        `${field} 不属于本次升级的 ${base} 或 ${target}，未覆盖文件。`,
      );
  const packageText = replaceVersionTokens(
    current.packageText,
    [["version"]],
    target,
  );
  const lockText = replaceVersionTokens(
    current.lockText,
    [["version"], ["packages", "", "version"]],
    target,
  );
  if (packageText !== current.packageText)
    await writeReleaseFileAtomic(join(root, "package.json"), packageText, {
      expectedText: current.packageText,
    });
  if (lockText !== current.lockText)
    await writeReleaseFileAtomic(join(root, "package-lock.json"), lockText, {
      expectedText: current.lockText,
    });
  const updated = await readVersionFiles(root);
  if (
    updated.packageJson.version !== target ||
    updated.lockJson.version !== target ||
    updated.lockJson.packages?.[""]?.version !== target
  )
    throw changedFile(root);
  return updated;
}
