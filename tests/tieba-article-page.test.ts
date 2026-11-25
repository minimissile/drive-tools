import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import type { TiebaArticleReading } from "../desktop/tieba-article-page";
import { tiebaBaiduMiniAppShare } from "../shared/tieba-article-links";
import {
  tiebaArticleImageHosts,
  wechatTiebaSourceSchema,
} from "../shared/wechat";

const url = "https://tieba.baidu.com/p/9063569462";
const readerBundle = buildSync({
  entryPoints: [
    fileURLToPath(new URL("../desktop/tieba-article-page.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "panxuTiebaReader",
  target: "chrome120",
}).outputFiles[0].text;
const readerScript = runInNewContext(
  `${readerBundle}\npanxuTiebaReader.readTiebaArticle`,
).toString();

let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    executablePath:
      process.env.PANXU_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
});
after(async () => await browser?.close());

async function extract(markup: string, currentUrl = url, status = 200) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      if (
        route.request().isNavigationRequest() &&
        route.request().url() === currentUrl
      )
        await route.fulfill({
          status,
          contentType: "text/html; charset=utf-8",
          body: markup,
        });
      else await route.abort();
    });
    await page.goto(currentUrl);
    return await page.evaluate<TiebaArticleReading>(
      `(${readerScript})(${JSON.stringify(url)},${JSON.stringify(tiebaArticleImageHosts)},(${tiebaBaiduMiniAppShare.toString()}))`,
    );
  } finally {
    await context.close();
  }
}

const floor = (metadata: string, content: string, footer = "") =>
  `<div class="l_post" data-field='${metadata}'>
    <a class="p_author_name">主帖作者</a>
    <div class="d_post_content">${content}</div>${footer}
  </div>`;
const thread = (...floors: string[]) =>
  `<!doctype html><title>官方主题_示例吧</title><h3 class="core_title_txt">官方主题</h3><div hidden><p class="captcha">验证界面样式模板</p></div><div id="j_p_postlist">${floors.join("")}</div>`;
const first =
  '{"content":{"post_no":1,"post_id":"101","date":"2024-06-20 08:25"}}';
const second = '{"content":{"post_no":2,"post_id":"102"}}';

test("Tieba import preserves main-post text, metadata, share links, and images in order", async () => {
  const result = await extract(
    thread(
      floor(second, "跟帖在页面上先出现也不采集"),
      floor(
        first,
        `<p>第一段<strong>重点</strong>。<br>第二行。</p>
      <p><a href="https://jump2.bdimg.com/safecheck/index?url=https%3A%2F%2Fpan.baidu.com%2Fs%2F1Fixture">网页链接</a> 提取码：test</p>
      <img class="BDE_Smiley" src="https://tiebapic.baidu.com/tb/editor/images/face.png">
      <a href="https://tieba.baidu.com/photo/p?kw=%E6%B5%8B%E8%AF%95"><img alt="说明图" data-src="//tiebapic.baidu.com/forum/pic/item/original.png" src="/placeholder.gif"></a>
      <img src="https://example.invalid/unknown.png">
      <div style="display:none">隐藏内容</div><template>模板文字</template>
      <div class="lzl_panel">楼中楼回复</div><div class="j_content_fold">展开提示</div><video></video>
      <p><a href="javascript:void(0)">按钮文字保留</a></p>`,
      ),
    ),
    `${url}?see_lz=1`,
  );
  if (result.status !== "read")
    assert.fail(`Unexpected reading: ${result.status}`);
  const source = wechatTiebaSourceSchema.parse(result.source);
  assert.equal(source.kind, "tieba");
  assert.equal(source.url, url);
  assert.equal(source.title, "官方主题");
  assert.equal(source.author, "主帖作者");
  assert.equal(source.publishedAt, "2024-06-20 08:25");
  assert.equal(source.imageCount, 1);
  assert.match(source.body, /第一段\*\*重点\*\*。\n第二行。/);
  assert.match(
    source.body,
    /\[网页链接\]\(https:\/\/pan\.baidu\.com\/s\/1Fixture\) 提取码：test/,
  );
  assert.match(
    source.body,
    /!\[说明图\]\(https:\/\/tiebapic\.baidu\.com\/forum\/pic\/item\/original\.png\)/,
  );
  assert.match(source.body, /按钮文字保留/);
  assert.doesNotMatch(
    source.body,
    /跟帖|隐藏内容|模板文字|楼中楼|展开提示|placeholder|未知|javascript:|safecheck|photo\/p/,
  );
  assert.equal(source.warnings.length, 3);
});

test("image-only floor can be identified by the first-floor footer when metadata is absent", async () => {
  const result = await extract(
    thread(
      floor(
        "{}",
        '<img alt="配图" src="http://imgsrc.baidu.com/forum/image.png">',
        '<div class="post-tail-wrap"><span class="tail-info">1楼</span><span class="tail-info">2024-07-01 08:00</span></div>',
      ),
    ),
  );
  if (result.status !== "read")
    assert.fail(`Unexpected reading: ${result.status}`);
  assert.equal(
    result.source.body,
    "![配图](https://imgsrc.baidu.com/forum/image.png)",
  );
  assert.equal(result.source.imageCount, 1);
  assert.equal(result.source.publishedAt, "2024-07-01 08:00");
});

const modernThread = (content: string) =>
  `<!doctype html><title>资料分享_百度贴吧</title><div class="pc-pb-box">
    <h1 class="pb-title">资料分享</h1>${content}</div>`;
const mainPost = (body: string) =>
  `<section class="image-text"><header class="head-line">
    <span class="head-name">资料作者</span><span class="post-num">2024-06-20 08:25</span>
    </header><div class="pb-content-wrap">${body}</div>
  </section>`;
const modernReply = `<div class="virtual-list-item"><div class="pb-comment-item">
  <span class="head-name">回复者</span><span class="post-num">2024-06-21 09:40</span>
  <span class="floor-info">第2楼</span><div class="pb-rich-text"><div class="pb-content-wrap">回复里的文字和图片</div></div>
</div></div>`;

test("modern desktop Tieba reads the original body and ignores replies, including embedded replies", async () => {
  const result = await extract(
    modernThread(
      modernReply +
        mainPost(`<div class="pb-rich-text">
        <div class="pb-text-wrapper text"><span>第一行。<br>第二行。</span></div>
        <p><a href="https://pan.baidu.com/s/1Fixture?pwd=xyzw">资料入口</a></p>
        <div class="image-list-item"><img alt="资料图片" bpic="//tiebapic.baidu.com/forum/pic/item/resource.jpg" src="/placeholder.svg"></div>
        <div class="pb-lzl-item"><div class="pb-content-wrap">引用回复</div></div>
      </div>`),
    ),
  );
  if (result.status !== "read")
    assert.fail(`Unexpected reading: ${result.status}`);
  assert.equal(result.source.title, "资料分享");
  assert.equal(result.source.author, "资料作者");
  assert.equal(result.source.publishedAt, "2024-06-20 08:25");
  assert.equal(result.source.imageCount, 1);
  assert.match(result.source.body, /第一行。\n第二行。/);
  assert.match(
    result.source.body,
    /\[资料入口\]\(https:\/\/pan\.baidu\.com\/s\/1Fixture\?pwd=xyzw\)/,
  );
  assert.match(
    result.source.body,
    /!\[资料图片\]\(https:\/\/tiebapic\.baidu\.com\/forum\/pic\/item\/resource\.jpg\)/,
  );
  assert.doesNotMatch(result.source.body, /回复里|引用回复|placeholder/);
});

test("Tieba page fallback unwraps only validated Baidu mini-program anchors", async () => {
  const route = `tiebaclient://swan/${"a".repeat(32)}/pages/outsite-chain/share-code/index`;
  const anchor = (url: string, title: string, extra = "", code = "Test") =>
    `<p><a href="${route}?url=${encodeURIComponent(url)}&amp;pwdcode=${code}${extra}">${title}</a></p>`;
  const share = "https://pan.baidu.com/s/1FixtureBaidu";
  const oldShare = "https://pan.baidu.com/s/1FixtureLegacy";
  const result = await extract(
    modernThread(
      mainPost(
        anchor(share, "百度网盘") +
          "<p>提取码：Test</p>" +
          anchor(oldShare.replace("https:", "http:"), "旧版分享", "", "") +
          anchor("https://example.org/s/1FixtureBaidu", "外站标签") +
          anchor("javascript:alert(1)", "脚本标签") +
          anchor(
            share,
            "重复参数标签",
            `&amp;url=${encodeURIComponent(share)}`,
          ),
      ),
    ),
  );
  if (result.status !== "read")
    assert.fail(`Unexpected reading: ${result.status}`);
  assert.equal(
    result.source.body,
    `[百度网盘](${share}?pwd=Test)\n\n提取码：Test\n\n[旧版分享](${oldShare})\n\n外站标签\n\n脚本标签\n\n重复参数标签`,
  );
});

test("modern replies, outside content, and ambiguous main-post containers do not create a source", async () => {
  assert.deepEqual(await extract(modernThread(modernReply)), {
    status: "not-ready",
  });
  assert.deepEqual(
    await extract(modernThread(mainPost("主题甲") + mainPost("主题乙"))),
    {
      status: "not-ready",
    },
  );
  assert.deepEqual(
    await extract(`${modernThread("")}${mainPost("正文容器在主题区外")}`),
    {
      status: "not-ready",
    },
  );
});

test("missing main floor or ambiguous candidates never fall back to replies", async () => {
  assert.deepEqual(await extract(thread(floor(second, "这是跟帖"))), {
    status: "not-ready",
  });
  assert.deepEqual(
    await extract(thread(floor(first, "一楼"), floor(first, "重复一楼"))),
    { status: "not-ready" },
  );
  assert.deepEqual(await extract(thread(floor(first, "主帖")), `${url}?pn=2`), {
    status: "wrong-page",
  });
  assert.deepEqual(
    await extract(
      thread(floor(first, "另一篇")),
      "https://tieba.baidu.com/p/123",
    ),
    { status: "wrong-page" },
  );
});

test("verification, removed, and empty pages return explicit failure states", async () => {
  assert.deepEqual(await extract("<title>百度安全验证</title>", url, 403), {
    status: "challenge",
  });
  assert.deepEqual(
    await extract("<title>登录</title>", "https://passport.baidu.com/v2/"),
    { status: "challenge" },
  );
  assert.deepEqual(
    await extract(
      '<title>百度贴吧</title><p class="error_notice">您访问的页面不存在</p>',
    ),
    { status: "missing" },
  );
  assert.deepEqual(
    await extract(
      thread(floor(first, '<img src="blob:https://tieba.baidu.com/image">')),
    ),
    { status: "empty" },
  );
});
