// Development asset collection, never run by the application or during login.
// Add an official homepage to platform-icon-sites.json, then run this script.
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "src/assets/websites");
const sites = JSON.parse(
  await readFile(
    new URL("./platform-icon-sites.json", import.meta.url),
    "utf8",
  ),
);
await mkdir(output, { recursive: true });
const sourcesPath = path.join(output, "sources.json");
const sources = await readFile(sourcesPath, "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return {};
    throw error;
  });
const requested = process.argv.slice(2);
for (const id of requested)
  if (!sites[id]) throw new Error(`Unknown platform: ${id}`);
const queue = Object.entries(sites).filter(
  ([id]) => !requested.length || requested.includes(id),
);
const maxBytes = 1024 * 1024;
async function download(url, referer) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("HTTPS public assets only");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "text/html,image/*;q=0.9,*/*;q=0.8",
      ...(referer ? { referer } : {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Asset too large");
    chunks.push(chunk);
  }
  return { data: Buffer.concat(chunks), url: response.url };
}
function imageExtension(data) {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (data.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return "ico";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "jpg";
  if (
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  )
    return "webp";
  // Do not retain SVG/HTML: only passive, decoded image formats are bundled.
  return null;
}
function attribute(tag, name) {
  const value = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return value
    ? (value[1] ?? value[2] ?? value[3]).replaceAll("&amp;", "&")
    : "";
}
async function collect([id, site]) {
  const candidates = [];
  if (site.icon) candidates.push(site.icon);
  try {
    const page = await download(site.home);
    const html = page.data.toString("utf8");
    const base = new URL(
      attribute(html.match(/<base\b[^>]*>/i)?.[0] ?? "", "href") || page.url,
      page.url,
    );
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
      const rel = attribute(tag, "rel");
      const href = attribute(tag, "href");
      if (href && /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(rel))
        candidates.push(new URL(href, base).href);
    }
  } catch {
    /* Root favicon remains a valid discovery fallback. */
  }
  candidates.push(new URL("/favicon.ico", site.home).href);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const { data, url } = await download(candidate, site.home);
      const ext = imageExtension(data);
      if (!ext) continue;
      const file = `${id}.${ext}`;
      await writeFile(path.join(output, file), data);
      for (const old of await readdir(output))
        if (old.startsWith(`${id}.`) && old !== file)
          await unlink(path.join(output, old));
      sources[id] = {
        ...site,
        icon: url,
        file,
        fetchedAt: new Date().toISOString().slice(0, 10),
      };
      console.log(`${id}: ${file} (${data.length} bytes)`);
      return;
    } catch {
      /* Keep the existing asset and try the next official candidate. */
    }
  }
  console.warn(`${id}: unavailable; existing asset retained`);
}
// Limit public-site requests without relying on any user's authenticated session.
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) await collect(queue.shift());
  }),
);
const ordered = Object.fromEntries(
  Object.keys(sites)
    .filter((id) => sources[id])
    .map((id) => [id, sources[id]]),
);
await writeFile(sourcesPath, `${JSON.stringify(ordered, null, 2)}\n`);
