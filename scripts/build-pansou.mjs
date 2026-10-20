// Build a local, reviewed PanSou checkout. No downloads or global tool changes.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { writePansouNotices } from "./pansou-notices.mjs";
const args = process.argv.slice(2);
const option = (key) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
const source = option("--source");
if (!source) throw new Error("需要 --source 指向已审核的 PanSou Go 源码目录。");
const go = option("--go") ?? "go",
  modules = option("--modules"),
  target = option("--target") ?? `${process.platform}-${process.arch}`;
const variants = [
  {
    folder: "darwin-arm64",
    os: "darwin",
    arch: "arm64",
    name: "pansou-server",
  },
  { folder: "darwin-x64", os: "darwin", arch: "amd64", name: "pansou-server" },
  {
    folder: "win32-x64",
    os: "windows",
    arch: "amd64",
    name: "pansou-server.exe",
  },
].filter((v) => target === "all" || target === v.folder);
if (!variants.length) throw new Error("未知构建目标。");
const temporary = await mkdtemp(join(tmpdir(), "panxu-pansou-build-"));
const tree = join(temporary, "source");
const hash = (b) => createHash("sha256").update(b).digest("hex");
try {
  await cp(resolve(source), tree, {
    recursive: true,
    filter: (path) => !path.includes("/.git/") && !path.endsWith(".exe"),
  });
  const main = await readFile(join(tree, "main.go"), "utf8");
  const pattern = /(Addr:\s*)":"\s*\+\s*port/g;
  if ([...main.matchAll(pattern)].length !== 1)
    throw new Error("监听地址结构变化，需先人工审核适配。");
  const patched = main.replace(pattern, '$1"127.0.0.1:" + port');
  await writeFile(join(tree, "main.go"), patched);
  if (!main.includes('"pansou/plugin/ash"'))
    await writeFile(
      join(tree, "panxu_plugins.go"),
      'package main\nimport _ "pansou/plugin/ash"\n',
    );
  await writeFile(
    join(tree, "panxu_lifecycle.go"),
    `package main
import ("os"; "strconv"; "time")
func init() {
  parent, err := strconv.Atoi(os.Getenv("PANXU_PARENT_PID"))
  if err != nil || parent <= 1 { return }
  go func() { for { time.Sleep(time.Second); if os.Getppid() != parent { os.Exit(0) } } }()
}
`,
  );
  const output = resolve("build/pansou");
  await mkdir(output, { recursive: true });
  await cp(join(tree, "LICENSE"), join(output, "LICENSE.txt"));
  for (const variant of variants) {
    const folder = join(output, variant.folder);
    await mkdir(folder, { recursive: true });
    const file = join(folder, variant.name);
    await new Promise((resolve, reject) => {
      const child = spawn(
        go,
        ["build", "-trimpath", "-ldflags=-s -w", "-o", file, "."],
        {
          cwd: tree,
          env: {
            ...process.env,
            GOOS: variant.os,
            GOARCH: variant.arch,
            CGO_ENABLED: "0",
            GOCACHE: join(temporary, "cache"),
            ...(modules ? { GOMODCACHE: resolvePath(modules) } : {}),
            GOPROXY: "off",
            GOTELEMETRY: "off",
            GOTOOLCHAIN: "local",
          },
          stdio: "inherit",
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Go构建失败 ${code}`)),
      );
    });
    await writeFile(
      join(folder, "provenance.json"),
      JSON.stringify(
        {
          upstream: "https://github.com/fish2018/pansou",
          originalBinaryEquivalence: "unverified; compatible source build",
          target: variant.folder,
          patches: [
            "loopback-only HTTP listener",
            "register configured ash source",
            "exit after parent process ends",
          ],
          sourceMainSha256: hash(main),
          patchedMainSha256: hash(patched),
          goModSha256: hash(await readFile(join(tree, "go.mod"))),
          goSumSha256: hash(await readFile(join(tree, "go.sum"))),
          binarySha256: hash(await readFile(file)),
        },
        null,
        2,
      ) + "\n",
    );
    await writePansouNotices(
      go,
      file,
      modules,
      join(output, "THIRD_PARTY_NOTICES.txt"),
    );
    console.log(`已生成 ${file}`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
function resolvePath(path) {
  return resolve(path);
}
