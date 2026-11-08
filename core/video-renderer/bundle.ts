import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

async function templateFingerprint(entryPoint: string) {
  const files: string[] = [];
  const collect = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await collect(dirname(entryPoint));
  // Shared render input is bundled into the templates alongside their TSX.
  const contract = join(dirname(entryPoint), "..", "shared", "video.ts");
  if (await stat(contract).catch(() => null)) files.push(contract);
  return (
    await Promise.all(
      files.sort().map(async (path) => {
        const info = await stat(path);
        return `${path}:${info.size}:${info.mtimeMs}`;
      }),
    )
  ).join("\n");
}

/** Cache one version per entry, so source edits work without restarting the app. */
export function createVideoTemplateBundler(
  build: (entryPoint: string) => Promise<string> = async (entryPoint) => {
    const { bundle } = await import("@remotion/bundler");
    return bundle({ entryPoint });
  },
) {
  const cache = new Map<
    string,
    { fingerprint: string; pending: Promise<string> }
  >();
  return async (entryPoint: string) => {
    const fingerprint = await templateFingerprint(entryPoint);
    const cached = cache.get(entryPoint);
    if (cached?.fingerprint === fingerprint) return cached.pending;
    const pending = build(entryPoint);
    const record = { fingerprint, pending };
    cache.set(entryPoint, record);
    pending.catch(() => {
      if (cache.get(entryPoint) === record) cache.delete(entryPoint);
    });
    return pending;
  };
}
