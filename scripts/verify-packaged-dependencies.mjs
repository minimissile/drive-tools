import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

// Resolve only inside the shipped archive. Host/workspace node_modules must
// never make an incomplete release look valid.
export function verifyPackagedDependencies(archivePath) {
  const archive = resolve(archivePath);
  const visited = new Set();
  const missing = [];
  const optionalMissing = [];
  let requiredDependenciesChecked = 0;

  function entry(path) {
    try {
      return asar.statFile(archive, path);
    } catch {
      return null;
    }
  }

  function isFile(path) {
    const info = entry(path);
    if (!info || "files" in info || "link" in info) return false;
    if (!info.unpacked) return true;
    try {
      const file = statSync(join(`${archive}.unpacked`, path));
      return file.isFile() && file.size === info.size;
    } catch {
      return false;
    }
  }

  function readPackage(directory) {
    const path = posix.join(directory, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(asar.extractFile(archive, path).toString("utf8"));
    } catch (error) {
      throw new Error(`无法读取归档依赖清单 ${path}: ${error.message}`);
    }
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
      throw new Error(`归档依赖清单不是对象：${path}`);
    return pkg;
  }

  function dependencyMap(pkg, key, directory) {
    const value = pkg[key] ?? {};
    if (typeof value !== "object" || Array.isArray(value))
      throw new Error(`归档 ${directory || "."}/package.json 的 ${key} 无效`);
    return value;
  }

  function resolveDependency(directory, name) {
    if (!/^(?:@[^/\\.][^/\\]*\/)?[^@/\\.][^/\\]*$/.test(name))
      throw new Error(`归档包含无效的依赖名称：${name}`);
    // Node walks upward from the requiring package, skipping a duplicated
    // node_modules/node_modules level. This also covers scoped/nested packages.
    let current = directory;
    while (true) {
      if (posix.basename(current) !== "node_modules") {
        const candidate = posix.join(current, "node_modules", name);
        const info = entry(candidate);
        if (info && "files" in info) return candidate;
      }
      if (!current) return null;
      const parent = posix.dirname(current);
      current = parent === "." ? "" : parent;
    }
  }

  function resolveMain(directory, main, seen = new Set()) {
    if (typeof main !== "string" || !main || posix.isAbsolute(main))
      return null;
    const target = posix.normalize(posix.join(directory, main));
    if (target === ".." || target.startsWith("../") || seen.has(target))
      return null;
    seen.add(target);
    for (const suffix of ["", ".js", ".json", ".node"])
      if (isFile(`${target}${suffix}`)) return `${target}${suffix}`;
    const targetInfo = entry(target);
    if (targetInfo && "files" in targetInfo) {
      if (isFile(posix.join(target, "package.json"))) {
        const nested = readPackage(target);
        if (nested.main) {
          const nestedEntry = resolveMain(target, nested.main, seen);
          if (nestedEntry) return nestedEntry;
        }
      }
      for (const suffix of [".js", ".json", ".node"]) {
        const index = posix.join(target, `index${suffix}`);
        if (isFile(index)) return index;
      }
    }
    return null;
  }

  function visit(directory, pkg) {
    if (visited.has(directory)) return;
    visited.add(directory);
    if (pkg.main !== undefined && !resolveMain(directory, pkg.main))
      missing.push(`${directory || "."}/package.json: main=${pkg.main} 不存在`);
    const dependencies = dependencyMap(pkg, "dependencies", directory);
    const optional = dependencyMap(pkg, "optionalDependencies", directory);
    for (const name of Object.keys({ ...dependencies, ...optional })) {
      // npm optionalDependencies override a duplicate dependencies declaration.
      const isOptional = Object.hasOwn(optional, name);
      if (!isOptional) requiredDependenciesChecked++;
      const dependency = resolveDependency(directory, name);
      if (!dependency) {
        const detail = { package: directory || ".", dependency: name };
        if (isOptional) optionalMissing.push(detail);
        else missing.push(`${directory || "."}/package.json -> ${name}`);
        continue;
      }
      // A present optional package must still ship its own required closure.
      visit(dependency, readPackage(dependency));
    }
  }

  const pkg = readPackage("");
  const mainEntry = resolveMain("", pkg.main ?? "index.js");
  if (!mainEntry)
    missing.push(`应用入口不存在：${pkg.main ?? "index.js"}`);
  visit("", pkg);
  if (missing.length)
    throw new Error(
      `生产归档依赖不完整：${archive}\n${missing.map((item) => `- ${item}`).join("\n")}`,
    );
  return {
    archive,
    mainEntry,
    packagesChecked: visited.size - 1,
    requiredDependenciesChecked,
    optionalDependenciesMissing: optionalMissing,
  };
}
