import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import updateConfig from "./update-config.cjs";
await build({
  entryPoints: ["desktop/main.ts"],
  outfile: "dist-desktop/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  sourcemap: true,
});
await writeFile(
  "dist-desktop/update-config.json",
  JSON.stringify(updateConfig.getUpdateConfig()) + "\n",
);
await build({
  entryPoints: ["desktop/preload.ts"],
  outfile: "dist-desktop/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: true,
});
