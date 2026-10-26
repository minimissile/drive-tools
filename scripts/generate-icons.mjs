import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One vector master supplies the sidebar, favicon, Dock and installer artwork.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "build");
const development = process.argv.includes("--dev");
const iconName = development ? "icon-dev" : "icon";

if (!process.versions.electron) {
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require("electron"),
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      cwd: root,
      env,
      stdio: "inherit",
    },
  );
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  // Do not await app.whenReady() at ESM module scope: it delays Electron ready.
  void (async () => {
    const { app, BrowserWindow, nativeImage } = await import("electron");
    const profile = await mkdtemp(join(tmpdir(), "panxu-icon-render-"));
    app.setPath("userData", profile);
    app.disableHardwareAcceleration();
    let window;
    try {
      await app.whenReady();
      if (process.platform === "darwin") await app.dock?.hide();
      const master = await readFile(
        join(root, "src/assets/brand/panxu-mark.svg"),
        "utf8",
      );
      // Classic macOS ICNS: 1024 canvas, 824 tile, 100 transparent inset.
      const inset = master.replace(
        /<svg\b[^>]*>/,
        '<svg x="100" y="100" width="824" height="824" viewBox="0 0 64 64" fill="none">',
      );
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><filter id="shadow" x="0" y="0" width="1024" height="1024" filterUnits="userSpaceOnUse"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#17346e" flood-opacity=".18"/></filter></defs>
  <g filter="url(#shadow)">${inset}</g>
  ${
    development
      ? `<g aria-label="DEV" transform="translate(416 416) scale(.55)">
    <rect x="300" y="660" width="624" height="264" rx="56" fill="#17346e" stroke="#edf4ff" stroke-width="10"/>
    <g fill="#fff" fill-rule="evenodd">
      <path d="M376 708h62c54 0 86 32 86 84s-32 84-86 84h-62V708Zm40 36v96h22c28 0 44-17 44-48s-16-48-44-48h-22Z"/>
      <path d="M548 708h116v36h-76v29h68v34h-68v33h76v36H548V708Z"/>
      <path d="M688 708h42l41 116 41-116h42l-64 168h-38l-64-168Z"/>
    </g>
  </g>`
      : ""
  }
</svg>\n`;
      await writeFile(join(output, `${iconName}.svg`), svg);
      window = new BrowserWindow({
        width: 1024,
        height: 1024,
        useContentSize: true,
        show: false,
        frame: false,
        transparent: true,
        webPreferences: {
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden;background:transparent}svg{display:block}</style>${svg}`)}`,
      );
      const capture = await window.webContents.capturePage();
      const image = nativeImage.createFromBuffer(capture.toPNG()).resize({
        width: 1024,
        height: 1024,
        quality: "best",
      });
      const png = (size) =>
        image.resize({ width: size, height: size, quality: "best" }).toPNG();
      await writeFile(join(output, `${iconName}.png`), png(1024));

      // Modern ICNS stores PNG representations; no platform-only image tools needed.
      const chunks = [
        ["icp4", 16],
        ["icp5", 32],
        ["icp6", 64],
        ["ic07", 128],
        ["ic08", 256],
        ["ic09", 512],
        ["ic10", 1024],
        ["ic11", 32],
        ["ic12", 64],
        ["ic13", 256],
        ["ic14", 512],
      ].map(([type, size]) => {
        const bytes = png(size);
        const header = Buffer.alloc(8);
        header.write(type);
        header.writeUInt32BE(bytes.length + 8, 4);
        return Buffer.concat([header, bytes]);
      });
      const header = Buffer.alloc(8);
      header.write("icns");
      header.writeUInt32BE(8 + chunks.reduce((sum, c) => sum + c.length, 0), 4);
      await writeFile(
        join(output, `${iconName}.icns`),
        Buffer.concat([header, ...chunks]),
      );

      const sizes = [16, 24, 32, 48, 64, 128, 256];
      const entries = [],
        images = [];
      let offset = 6 + sizes.length * 16;
      for (const size of sizes) {
        const bytes = png(size);
        const entry = Buffer.alloc(16);
        entry[0] = entry[1] = size === 256 ? 0 : size;
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(bytes.length, 8);
        entry.writeUInt32LE(offset, 12);
        entries.push(entry);
        images.push(bytes);
        offset += bytes.length;
      }
      const icoHeader = Buffer.alloc(6);
      icoHeader.writeUInt16LE(1, 2);
      icoHeader.writeUInt16LE(sizes.length, 4);
      await writeFile(
        join(output, `${iconName}.ico`),
        Buffer.concat([icoHeader, ...entries, ...images]),
      );
      console.log(
        `已从 panxu-mark.svg 生成 ${iconName}.svg / PNG / ICNS / ICO。`,
      );
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      window?.destroy();
      await rm(profile, { recursive: true, force: true });
      app.exit(process.exitCode ?? 0);
    }
  })();
}
