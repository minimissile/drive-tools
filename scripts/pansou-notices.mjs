import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
export async function writePansouNotices(go, binary, modules, output) {
  const options = { env: { ...process.env, GOTELEMETRY: "off" } };
  const info = (await exec(go, ["version", "-m", binary], options)).stdout;
  const cache =
    modules ?? (await exec(go, ["env", "GOMODCACHE"], options)).stdout.trim();
  const goroot = (await exec(go, ["env", "GOROOT"], options)).stdout.trim();
  const sections = [
    "PanSou compatible helper — third-party notices",
    `Go runtime\n${await readFile(join(goroot, "LICENSE"), "utf8")}`,
  ];
  for (const line of info.split("\n")) {
    if (!line.startsWith("\tdep\t")) continue;
    const [, , name, version] = line.split("\t");
    const folder = join(
      cache,
      name.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase()) + "@" + version,
    );
    const files = (await readdir(folder, { withFileTypes: true })).filter(
      (f) => f.isFile() && /^(licen[cs]e|copying|notice)/i.test(f.name),
    );
    if (!files.length) throw new Error(`依赖许可证缺失：${name} ${version}`);
    for (const file of files)
      sections.push(
        `${name} ${version} — ${file.name}\n${await readFile(join(folder, file.name), "utf8")}`,
      );
  }
  await writeFile(
    output,
    sections.join("\n\n========================================\n\n") + "\n",
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2),
    arg = (key) => args[args.indexOf(key) + 1];
  await writePansouNotices(
    arg("--go"),
    arg("--binary"),
    arg("--modules"),
    arg("--output"),
  );
}
