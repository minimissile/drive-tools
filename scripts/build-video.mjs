import { bundle } from "@remotion/bundler";
import { resolve } from "node:path";

// Static templates only. No video render, browser download, AI or cloud calls.
await bundle({
  entryPoint: resolve("video-templates/index.tsx"),
  outDir: resolve("build/video-remotion"),
});
