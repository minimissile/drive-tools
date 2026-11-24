import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { wechatHtml } from "../shared/wechat-markup";
import type { wechatModuleMarkdownFromHtml } from "../src/wechat/module-paste";

const converterScript = buildSync({
  entryPoints: [
    fileURLToPath(new URL("../src/wechat/module-paste.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "panxuModulePaste",
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

async function convert(html: string) {
  const page = await browser.newPage();
  try {
    const requests: string[] = [];
    await page.route("**/*", async (route) => {
      requests.push(route.request().url());
      await route.abort();
    });
    await page.addScriptTag({ content: converterScript });
    const result = await page.evaluate((fragment) => {
      const testWindow = window as typeof window & {
        panxuModulePaste: {
          wechatModuleMarkdownFromHtml: typeof wechatModuleMarkdownFromHtml;
        };
        clipboardFixtureExecuted?: boolean;
      };
      const converted =
        testWindow.panxuModulePaste.wechatModuleMarkdownFromHtml(fragment);
      return {
        converted,
        mountedClipboardNodes: document.body.children.length,
        executed: testWindow.clipboardFixtureExecuted ?? false,
      };
    }, html);
    assert.deepEqual(requests, []);
    assert.equal(result.mountedClipboardNodes, 0);
    assert.equal(result.executed, false);
    return result.converted;
  } finally {
    await page.close();
  }
}

test("粘贴模块富文本保留标题、粗体、编号、引用和代码", async () => {
  const result = await convert(`
    <h2>归档说明</h2>
    <p>请<strong>核对</strong>并<span style="font-weight: 700">保留备份</span>。</p>
    <ol start="3"><li>选取资料</li><li>确认版本</li></ol>
    <ul><li>使用副本</li><li>保留原始文件</li></ul>
    <blockquote><p>只整理现有资料。</p><p>以实际文件为准。</p></blockquote>
    <pre>  npm run check
    npm run dev</pre>
  `);
  assert.equal(result.skippedImages, 0);
  assert.match(result.body, /^## 归档说明\n\n/);
  assert.match(result.body, /请\*\*核对\*\*并\*\*保留备份\*\*。/);
  assert.match(result.body, /3\. 选取资料\n4\. 确认版本/);
  assert.match(result.body, /- 使用副本\n- 保留原始文件/);
  assert.match(result.body, /> 只整理现有资料。\n> 以实际文件为准。/);
  assert.ok(result.body.includes("```\n  npm run check\n    npm run dev\n```"));
  const rendered = wechatHtml(result.body).replace(/\sstyle="[^"]*"/g, "");
  assert.match(rendered, /<h3>归档说明<\/h3>/);
  assert.match(rendered, /<strong>保留备份<\/strong>/);
  assert.match(
    rendered,
    /<ol start="3"><li>选取资料<\/li><li>确认版本<\/li><\/ol>/,
  );
});

test("粘贴模块富文本保留安全链接和可复用图片，计数无法读取的图片", async () => {
  const result = await convert(`
    <p><a href="http://example.org/guide">阅读说明</a></p>
    <p><a href="https://example.org/a(b)?step=1&amp;from=note">进阶步骤</a></p>
    <img alt="说明图" data-src="https://example.org/original.png" src="https://example.org/placeholder.png">
    <img alt="备用图" data-src="blob:https://example.org/ignored" src="https://example.org/fallback.png">
    <img src="http://example.org/insecure.png">
    <img src="data:image/png;base64,AAAA">
    <img src="file:///tmp/fixture.png">
    <img src="https://user:secret@example.org/private.png">
    <img src="/relative.png">
  `);
  assert.equal(result.skippedImages, 5);
  assert.ok(result.body.includes("[阅读说明](http://example.org/guide)"));
  assert.ok(
    result.body.includes(
      "[进阶步骤](https://example.org/a%28b%29?step=1&from=note)",
    ),
  );
  assert.ok(
    result.body.includes("![说明图](https://example.org/original.png)"),
  );
  assert.ok(
    result.body.includes("![备用图](https://example.org/fallback.png)"),
  );
  assert.doesNotMatch(
    result.body,
    /placeholder\.png|insecure\.png|data:|file:|user:secret|relative\.png/,
  );
});

test("粘贴模块富文本忽略活动节点和不安全地址，保留可读文字", async () => {
  const result = await convert(`
    <base href="https://example.org/">
    <link rel="stylesheet" href="https://example.org/style.css">
    <style>隐藏样式</style>
    <script>window.clipboardFixtureExecuted = true</script>
    <iframe src="https://example.org/embedded">嵌入文字</iframe>
    <form>表单内容<input value="表单字段"></form>
    <svg><text>矢量内容</text></svg>
    <p hidden>隐藏文字</p>
    <p style="display:none">隐藏样式段落</p>
    <p>可读内容 &lt;说明&gt;</p>
    <p><a href="javascript:void(0)">保留链接文字</a>，<a href="https://example.org:8443/story">自定义端口</a></p>
    <p><a href="https://user:secret@example.org/story">带凭据链接</a>，<a href="/story">相对地址</a></p>
    <p><img src="https://example.org/photo.png" alt="照片" onload="window.clipboardFixtureExecuted = true"></p>
  `);
  assert.equal(result.skippedImages, 0);
  assert.match(result.body, /可读内容 <说明>/);
  assert.match(result.body, /保留链接文字，自定义端口/);
  assert.match(result.body, /带凭据链接，相对地址/);
  assert.doesNotMatch(
    result.body,
    /隐藏|clipboardFixtureExecuted|嵌入文字|表单|矢量内容|javascript:|onload|8443|user:secret|\/story/,
  );
  assert.match(wechatHtml(result.body), /可读内容 &lt;说明&gt;/);
});
