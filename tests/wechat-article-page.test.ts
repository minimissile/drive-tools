import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import type { readWechatArticle } from "../desktop/wechat-article-page";

// Match the desktop bundle's transformation rather than serializing tsx's
// development function-name helper into the isolated browser page.
const readerScript = buildSync({
  entryPoints: [
    fileURLToPath(
      new URL("../desktop/wechat-article-page.ts", import.meta.url),
    ),
  ],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "panxuArticleReader",
  target: "chrome120",
}).outputFiles[0].text;

let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    executablePath:
      process.env.PANXU_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
});
after(async () => {
  await browser?.close();
});

/** Offline HTML fixtures only: no Electron, workspace, login or remote request. */
async function extract(content: string) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      if (route.request().isNavigationRequest())
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><h1 id="activity-name">示例文章</h1><span id="js_name">示例公众号</span><span id="publish_time">2026-11-05</span>${content}</body></html>`,
        });
      else await route.abort();
    });
    await page.goto("https://mp.weixin.qq.com/s/offline-fixture");
    return await page.evaluate<ReturnType<typeof readWechatArticle>>(
      `${readerScript}\npanxuArticleReader.readWechatArticle()`,
    );
  } finally {
    await context.close();
  }
}

test("ordinary article preserves text, headings, metadata and allowed image", async () => {
  const source = await extract(
    `<div id="js_content"><h2>资源说明</h2><p>正文<strong>重点</strong>。</p><p><a href="https://pan.quark.cn/s/example">下载资料</a></p><img alt="说明图" data-src="https://mmbiz.qpic.cn/example.png"><script>不应导入</script></div>`,
  );
  assert.equal(source.title, "示例文章");
  assert.equal(source.author, "示例公众号");
  assert.equal(source.publishedAt, "2026-11-05");
  assert.match(source.body, /## 资源说明/);
  assert.match(source.body, /正文\*\*重点\*\*。/);
  assert.match(
    source.body,
    /\[下载资料\]\(https:\/\/pan\.quark\.cn\/s\/example\)/,
  );
  assert.match(
    source.body,
    /!\[说明图\]\(https:\/\/mmbiz\.qpic\.cn\/example\.png\)/,
  );
  assert.equal(source.imageCount, 1);
  assert.doesNotMatch(source.body, /不应导入/);
});

test("linked image remains valid image Markdown and retains the link target", async () => {
  const source = await extract(
    `<div id="js_content"><a href="https://pan.quark.cn/s/banner"><img alt="下载横幅" data-src="https://mmbiz.qpic.cn/banner.png"></a></div>`,
  );
  assert.equal(
    source.body,
    "![下载横幅](https://mmbiz.qpic.cn/banner.png)\n\nhttps://pan.quark.cn/s/banner",
  );
  assert.equal(source.imageCount, 1);
});

test("image-only article imports supported images without inventing text", async () => {
  const source = await extract(
    `<div id="js_content"><img src="https://mmbiz.qlogo.cn/image-only.png"></div>`,
  );
  assert.equal(
    source.body,
    "![文章配图](https://mmbiz.qlogo.cn/image-only.png)",
  );
  assert.equal(source.imageCount, 1);
});

test("unsupported-only or non-content markup is still rejected as an empty article", async () => {
  await assert.rejects(
    extract(
      `<div id="js_content"><img src="https://example.com/untrusted.png"><script>假正文</script></div>`,
    ),
    /未读取到公众号正文/,
  );
  await assert.rejects(
    extract(
      `<div id="js_content"><video src="https://example.com/movie.mp4"></video></div>`,
    ),
    /未读取到公众号正文/,
  );
});
