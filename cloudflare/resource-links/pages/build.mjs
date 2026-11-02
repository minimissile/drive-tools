import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const output = join(directory, "dist");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(directory, "worker.ts")],
  outfile: join(output, "_worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
await writeFile(
  join(output, "_routes.json"),
  JSON.stringify({ version: 1, include: ["/*"], exclude: [] }),
);
