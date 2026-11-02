// Dedicated public-web visual QA. CUA/IAB screenshots were scaled/cropped despite
// matching DOM viewport values; an isolated system Chrome produces exact PNGs.
// This never launches Electron, attaches to private tabs or touches the workspace DB.
import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const directory = ".impeccable/review",
  origin = "https://panxu.site",
  article = origin + "/r/fVOZw5ZbE_Z5";
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const records = [];
const only1366 = process.argv.includes("--article1366-only");
try {
  const context = await browser.newContext({
    viewport: only1366
      ? { width: 1366, height: 768 }
      : { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const capture = async (name, width, height, fullPage = false) => {
    const path = `${directory}/${name}.png`;
    await page.screenshot({ path, fullPage, animations: "disabled" });
    const png = await readFile(path),
      actual = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    assert.equal(actual.width, width);
    if (!fullPage) assert.equal(actual.height, height);
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      contentWidth: document.documentElement.scrollWidth,
    }));
    assert(layout.contentWidth <= layout.width, `${name} horizontal overflow`);
    records.push({ path, actual, layout, url: page.url() });
  };
  await page.goto(article, { waitUntil: "networkidle" });
  if (only1366) {
    await capture("article-1366", 1366, 768);
  } else {
    await capture("article-1440", 1440, 900);
    await capture("article-full", 1440, 900, true);
    await page.setViewportSize({ width: 1366, height: 768 });
    // A new document avoids a compositor tile left by a full-page capture resize.
    await page.goto(article, { waitUntil: "networkidle" });
    await capture("article-1366", 1366, 768);
    const citation = page.locator(".section-note a").first();
    await citation.click();
    assert.equal(await page.locator(".sources").getAttribute("open"), "");
    await capture("article-sources-1366", 1366, 768);
    assert(
      (await page.locator(".source-entry:target").count()) === 1,
      "citation opens its exact source",
    );
    const faq = page.locator(".faq details").first();
    if (await faq.count()) {
      await faq.locator("summary").click();
      await capture("article-details-1366", 1366, 768);
    } else {
      assert.equal(
        await page.locator('.toc a[href="#faq"]').count(),
        0,
        "no empty FAQ navigation",
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin, { waitUntil: "networkidle" });
    await capture("catalog-1440", 1440, 900);
    await page
      .getByRole("searchbox", { name: "搜索资源" })
      .fill("不存在的资源20261102");
    await page.getByRole("button", { name: "搜索资源" }).click();
    await page.waitForURL(/q=/);
    assert((await page.locator("main").innerText()).includes("没有找到"));
    await page.goto(origin + "/about", { waitUntil: "networkidle" });
    await capture("about-desktop", 1440, 900);
    await capture("about-full", 1440, 900, true);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `${directory}/${only1366 ? "article-1366-capture" : "capture-metadata"}.json`,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        method: "isolated system Chrome / Playwright / deviceScaleFactor 1",
        records,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      captures: records.length,
      exactViewportPNGs: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
