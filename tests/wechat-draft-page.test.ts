import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import type { readWechatIdentity } from "../desktop/wechat-page";
import { wechatHtml } from "../shared/wechat-markup";

// Use the same browser transformation as the desktop bundle; tsx function-name
// helpers must not become dependencies of the functions running inside the DOM.
const readerScript = buildSync({
  entryPoints: [
    fileURLToPath(new URL("../desktop/wechat-page.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "panxuWechatDraftPage",
  target: "chrome120",
}).outputFiles[0].text;

let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    executablePath:
      process.env.PANXU_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    // Routing below serves every fixture locally. A closed proxy additionally
    // prevents this independent browser from making background network requests.
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--proxy-server=http://127.0.0.1:9",
      "--proxy-bypass-list=<-loopback>",
    ],
  });
});
after(async () => {
  await browser?.close();
});

interface Fixture {
  url?: string;
  dom?: string;
  wx?: Record<string, unknown>;
  appmsgData?: Record<string, unknown>;
  title?: string;
  editorHtml?: string;
  editorReady?: boolean;
  iframe?: boolean;
  /** An explicit null disables the readback helper's independent cover proof. */
  coverProof?: string | null;
  sourceUrl?: string;
}

/** Isolated offline DOM only: never uses Electron, a workspace or real cookies. */
async function withFixture<T>(
  fixture: Fixture,
  action: (page: Page) => Promise<T>,
) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await context.route("**/*", async (route) => {
      if (
        route.request().isNavigationRequest() &&
        route.request().frame().parentFrame() === null
      )
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body></body></html>",
        });
      else await route.abort();
    });
    const page = await context.newPage();
    await page.goto(
      fixture.url ||
        "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=123456&token=987654",
    );
    await page.evaluate(`
      document.body.innerHTML = ${JSON.stringify(fixture.dom || "")};
      window.wx = ${JSON.stringify(fixture.wx ?? null)};
      window.appmsgData = ${JSON.stringify(fixture.appmsgData ?? null)};
      ${fixture.sourceUrl === undefined ? "" : `const sourceInput = document.createElement('input'); sourceInput.name = 'source_url'; sourceInput.value = ${JSON.stringify(fixture.sourceUrl)}; document.body.append(sourceInput);`}
      ${
        typeof fixture.coverProof !== "string"
          ? ""
          : `const cover = document.createElement('input');
             cover.type = 'hidden';
             cover.name = 'cdn_url';
             cover.value = ${JSON.stringify(fixture.coverProof)};
             document.body.append(cover);`
      }
      ${
        fixture.title === undefined
          ? ""
          : `const title = document.createElement('input');
             title.id = 'title';
             title.value = ${JSON.stringify(fixture.title)};
             document.body.append(title);`
      }
      ${
        fixture.editorHtml === undefined
          ? ""
          : fixture.iframe
            ? `const holder = document.createElement('div');
               holder.id = 'edui1_iframeholder';
               const frame = document.createElement('iframe');
               holder.append(frame);
               document.body.append(holder);
               frame.contentDocument.body.innerHTML = ${JSON.stringify(fixture.editorHtml)};`
            : `window.UE = {instances: {article: {
                 isReady: ${JSON.stringify(fixture.editorReady ?? true)},
                 getContent: () => ${JSON.stringify(fixture.editorHtml)}
               }}};`
      }
    `);
    return await action(page);
  } finally {
    await context.close();
  }
}

const identity = (fixture: Fixture) =>
  withFixture(fixture, (page) =>
    page.evaluate<ReturnType<typeof readWechatIdentity>>(
      `${readerScript}\npanxuWechatDraftPage.readWechatIdentity()`,
    ),
  );
const singleDraft = (fixture: Fixture) =>
  withFixture(fixture, (page) =>
    page.evaluate(
      `${readerScript}\npanxuWechatDraftPage.assertWechatSingleDraft()`,
    ),
  );
const readback = (
  fixture: Fixture,
  expected: {
    title: string;
    html: string;
    coverUrl: string;
    sourceUrl?: string;
    allowImageMigration?: boolean;
  },
) =>
  withFixture({ coverProof: coverUrl, ...fixture }, (page) =>
    page.evaluate(
      `${readerScript}\npanxuWechatDraftPage.assertWechatDraftContent(${JSON.stringify(expected)})`,
    ),
  );

test("identity uses the unique original gh_ ID, never the nickname or login token", async () => {
  assert.deepEqual(
    await identity({
      wx: {
        data: { user_name: "gh_abc12345", nick_name: "  示例公众号  " },
        cgiData: { user_name: "gh_abc12345" },
      },
      dom: '<div class="account_setting_item">原始 ID：gh_abc12345</div>',
    }),
    { uid: "gh_abc12345", nickname: "示例公众号", token: "987654" },
  );
});

test("settings DOM can supply the original ID and nickname with a data token fallback", async () => {
  assert.deepEqual(
    await identity({
      url: "https://mp.weixin.qq.com/cgi-bin/settingpage",
      wx: { data: { token: "1234567" } },
      dom: '<div class="weui-desktop-form__control-group">原始ID gh_settings123</div><span class="account_nickname">设置页账号</span>',
    }),
    { uid: "gh_settings123", nickname: "设置页账号", token: "1234567" },
  );
});

test("identity rejects nickname/token-only sessions, malformed IDs and conflicting original IDs", async () => {
  for (const fixture of [
    { wx: { data: { nick_name: "gh_not_identity", token: "1234" } } },
    { wx: { data: { user_name: "nickname", token: "1234" } } },
    {
      wx: {
        data: { user_name: "gh_first123" },
        cgiData: { user_name: "gh_second123" },
      },
    },
    { dom: '<span class="account_nickname">gh_not_identity</span>' },
    {},
  ])
    assert.equal(await identity(fixture), null);
});

test("identity rejects missing/invalid tokens and an untrusted page origin", async () => {
  for (const url of [
    "https://mp.weixin.qq.com/cgi-bin/home",
    "https://mp.weixin.qq.com/cgi-bin/home?token=not-a-token",
    "https://example.com/cgi-bin/home?token=12345",
  ])
    assert.equal(
      await identity({ url, wx: { data: { user_name: "gh_valid123" } } }),
      null,
    );
});

test("identity bounds the nickname without changing the original ID", async () => {
  const result = await identity({
    wx: { data: { user_name: "gh_valid123", nick_name: "名".repeat(150) } },
  });
  assert.equal(result?.uid, "gh_valid123");
  assert.equal(result?.nickname.length, 100);
});

test("single-article confirmation supports every observed global-data layout", async () => {
  for (const fixture of [
    { appmsgData: { item: [{}] } },
    { appmsgData: { items: [{}] } },
    { wx: { cgiData: { appmsg_data: { item: [{}] } } } },
    { wx: { cgiData: { appmsg_info: { item: [{}] } } } },
    { appmsgData: { multi_item: [{}] } },
    { wx: { cgiData: { appmsg_data: { multi_item: [{}] } } } },
    { wx: { cgiData: { appmsg_info: { multi_item: [{}] } } } },
  ])
    await singleDraft(fixture);
});

test("single-article confirmation supports the editor DOM fallback", async () => {
  await singleDraft({
    dom: '<div class="appmsg_item_wrp"><div class="appmsg_item"></div></div>',
  });
});

test("editor title, author and body fields are not mistaken for article entries", async () => {
  const fields =
    '<div class="appmsg_edit_item title"></div><div class="appmsg_edit_item author"></div><div class="appmsg_edit_item content_edit"></div>';
  await singleDraft({
    wx: { cgiData: { appmsg_data: { multi_item: [{}] } } },
    dom: `<div class="appmsg_item_wrp"><div class="appmsg_item"></div></div>${fields}`,
  });
  await assert.rejects(
    singleDraft({ dom: fields }),
    /未能确认微信草稿仍为单篇文章/,
  );
  await assert.rejects(
    singleDraft({
      wx: { cgiData: { appmsg_data: { multi_item: [{}] } } },
      dom: '<div class="appmsg_item_wrp"><div class="appmsg_item"></div><div class="appmsg_item"></div></div>',
    }),
    /未能确认微信草稿仍为单篇文章/,
  );
});

test("unknown, empty and multi-article drafts are rejected before any overwrite", async () => {
  for (const fixture of [
    {},
    { appmsgData: { item: [] } },
    { appmsgData: { items: [{}, {}] } },
    { wx: { cgiData: { appmsg_data: { item: [{}, {}] } } } },
    { wx: { cgiData: { appmsg_data: { multi_item: [] } } } },
    { wx: { cgiData: { appmsg_data: { multi_item: [{}, {}] } } } },
    {
      dom: '<div class="appmsg_edit_item"></div><div class="appmsg_edit_item"></div>',
    },
  ])
    await assert.rejects(singleDraft(fixture), /未能确认微信草稿仍为单篇文章/);
});

test("conflicting single/multi-article signals fail closed", async () => {
  await assert.rejects(
    singleDraft({
      appmsgData: { item: [{}] },
      wx: { cgiData: { appmsg_info: { item: [{}, {}] } } },
    }),
    /未能确认微信草稿仍为单篇文章/,
  );
});

const title = "离线草稿核对";
const resourceUrl = "https://pan.baidu.com/s/1offline?pwd=A1b2&from=fixture";
const encodedResourceUrl = resourceUrl.replace(/&/g, "&amp;");
const imageOne = "https://mmbiz.qpic.cn/first.png?wx_fmt=png";
const imageTwo = "https://mmbiz.qpic.cn/second.png?wx_fmt=png";
const coverUrl =
  "https://mmbiz.qpic.cn/dedicated-cover.png?wx_fmt=png&from=fixture";
const encodedCoverUrl = coverUrl.replace(/&/g, "&amp;");
const articleHtml = `<p>原文中的条件与步骤。</p><p><a href="${encodedResourceUrl}">下载资料（${encodedResourceUrl}）</a></p><img src="${imageOne}"><img src="${imageTwo}">`;
const expected = { title, html: articleHtml, coverUrl };

test("current editor verifies persisted multi_item without a global UE editor", async () => {
  for (const parent of ["appmsgData", "appmsg_data", "appmsg_info"])
    for (const app_id of [123456, "123456"]) {
      const metadata = {
        app_id,
        multi_item: [{ title, content: articleHtml, cdn_url: coverUrl }],
      };
      await readback(
        {
          coverProof: null,
          ...(parent === "appmsgData"
            ? { appmsgData: metadata }
            : { wx: { cgiData: { [parent]: metadata } } }),
        },
        expected,
      );
    }
});

test("current editor rejects stale IDs, missing content and multiple articles", async () => {
  const item = { title, content: articleHtml, cdn_url: coverUrl };
  for (const metadata of [
    { app_id: 999999, multi_item: [item] },
    { multi_item: [item] },
    { app_id: 123456, multi_item: [] },
    { app_id: 123456, multi_item: [item, item] },
    { app_id: 123456, multi_item: [{ ...item, content: "" }] },
    { app_id: 123456, multi_item: [{ ...item, title: "另一篇草稿" }] },
  ])
    await assert.rejects(
      readback(
        { wx: { cgiData: { appmsg_data: metadata } }, coverProof: null },
        expected,
      ),
      /尚未读取到与本地标题一致/,
    );
});

test("current editor still checks body, images, links and the independent saved cover", async () => {
  for (const item of [
    {
      title,
      content: articleHtml.replace("条件与步骤", "另一份内容"),
      cdn_url: coverUrl,
    },
    {
      title,
      content: articleHtml.replace(`<img src="${imageOne}">`, ""),
      cdn_url: coverUrl,
    },
    {
      title,
      content: articleHtml.replace(
        encodedResourceUrl,
        "https://example.com/wrong",
      ),
      cdn_url: coverUrl,
    },
    {
      title,
      content: articleHtml,
      cdn_url: "https://mmbiz.qpic.cn/wrong-cover.png",
    },
  ])
    await assert.rejects(
      readback(
        {
          wx: {
            cgiData: { appmsg_data: { app_id: 123456, multi_item: [item] } },
          },
          coverProof: null,
        },
        expected,
      ),
      /与本地稿件不一致|未能核实微信草稿封面/,
    );
});

test("readback confirms the title, body, ordered image URLs and resource link", async () => {
  await readback({ title, editorHtml: articleHtml }, expected);
});

test("CDN迁移返回逐图像素核验清单，不把不同地址直接当成相同图片", async () => {
  const migratedCover = "https://mmbiz.qlogo.cn/migrated-cover.png";
  const migratedImage = "https://mmbiz.qlogo.cn/migrated-body.png";
  const actual = articleHtml.replace(imageOne, migratedImage);
  await assert.rejects(
    readback(
      { title, editorHtml: actual, coverProof: migratedCover },
      expected,
    ),
  );
  const proof = await readback(
    { title, editorHtml: actual, coverProof: migratedCover },
    { ...expected, allowImageMigration: true },
  );
  assert.deepEqual(proof, {
    coverUrl: migratedCover,
    coverUrls: [migratedCover],
    images: [
      { actual: migratedImage, expected: imageOne },
      { actual: imageTwo, expected: imageTwo },
    ],
  });
  for (const html of [
    actual.replace("条件与步骤", "不同内容"),
    actual + `<img src="${migratedImage}">`,
    actual.replace(migratedImage, "https://example.com/untrusted.png"),
  ])
    await assert.rejects(
      readback(
        { title, editorHtml: html, coverProof: migratedCover },
        { ...expected, allowImageMigration: true },
      ),
    );
  await assert.rejects(
    readback(
      {
        title,
        editorHtml: actual,
        coverProof: "https://example.com/untrusted-cover.png",
      },
      { ...expected, allowImageMigration: true },
    ),
  );
});

test("readback accepts formatting whitespace and WeChat data-src images", async () => {
  const actual = articleHtml
    .replace("原文中的条件与步骤。", " 原文中的\n条件与步骤。\u200b")
    .replaceAll('src="https:', 'data-src="http:');
  await readback({ title, editorHtml: actual }, expected);
});

test("readback supports the same-origin editor iframe fallback", async () => {
  await readback({ title, editorHtml: articleHtml, iframe: true }, expected);
});

test("a stripped external anchor remains usable when its full resource URL is visible", async () => {
  const actual = articleHtml
    .replace(/<a href="[^"]+">/g, "<span>")
    .replaceAll("</a>", "</span>");
  await readback({ title, editorHtml: actual }, expected);
});

test("readback rejects a stripped name-only resource link that loses its URL", async () => {
  await assert.rejects(
    readback(
      { title, editorHtml: "<p>下载资料</p>" },
      {
        title,
        html: `<p><a href="${encodedResourceUrl}">下载资料</a></p>`,
        coverUrl,
      },
    ),
    /与本地稿件不一致/,
  );
});

test("readback rejects a wrong retained resource href even if the original URL is printed", async () => {
  await assert.rejects(
    readback(
      {
        title,
        editorHtml: articleHtml.replace(
          `href="${encodedResourceUrl}"`,
          'href="https://example.com/wrong-resource"',
        ),
      },
      expected,
    ),
    /与本地稿件不一致/,
  );
});

test("title differences and changed/missing body content are rejected", async () => {
  await assert.rejects(
    readback({ title: "另一篇草稿", editorHtml: articleHtml }, expected),
    /尚未读取到与本地标题一致/,
  );
  for (const actual of [
    articleHtml.replace("原文中的条件与步骤。", "含义已被改动。"),
    articleHtml.replace("原文中的条件与步骤。", ""),
  ])
    await assert.rejects(
      readback({ title, editorHtml: actual }, expected),
      /与本地稿件不一致/,
    );
});

test("missing, replaced, additional and reordered illustrations are rejected", async () => {
  for (const actual of [
    articleHtml.replace(`<img src="${imageOne}">`, ""),
    articleHtml.replace(imageOne, "https://mmbiz.qpic.cn/wrong.png"),
    articleHtml + '<img src="https://mmbiz.qpic.cn/unexpected.png">',
    articleHtml
      .replace(imageOne, "TEMP_IMAGE")
      .replace(imageTwo, imageOne)
      .replace("TEMP_IMAGE", imageTwo),
  ])
    await assert.rejects(
      readback({ title, editorHtml: actual }, expected),
      /与本地稿件不一致/,
    );
});

test("readback rejects missing/not-ready editors and absent title fields", async () => {
  for (const fixture of [
    { title },
    { title, editorHtml: articleHtml, editorReady: false },
    { editorHtml: articleHtml },
  ])
    await assert.rejects(
      readback(fixture, expected),
      /尚未读取到与本地标题一致/,
    );
});

test("readback rejects non-official origins and pages without a saved draft ID", async () => {
  for (const url of [
    "https://example.com/cgi-bin/appmsg?appmsgid=123456&token=987654",
    "https://mp.weixin.qq.com/cgi-bin/appmsg?token=987654",
  ])
    await assert.rejects(
      readback({ url, title, editorHtml: articleHtml }, expected),
      /未打开保存后的微信草稿/,
    );
});

test("cover readback supports flat and single-item metadata fields from each editor layout", async () => {
  for (const parent of ["appmsgData", "appmsg_data", "appmsg_info"])
    for (const field of ["cdn_url", "cover_url", "thumb_url"])
      for (const layout of ["flat", "item", "items"]) {
        const cover = { [field]: coverUrl };
        const metadata = layout === "flat" ? cover : { [layout]: [cover] };
        const fixture =
          parent === "appmsgData"
            ? { appmsgData: metadata }
            : { wx: { cgiData: { [parent]: metadata } } };
        await readback(
          { title, editorHtml: articleHtml, coverProof: null, ...fixture },
          expected,
        );
      }
});

test("cover readback supports dedicated hidden cover inputs", async () => {
  for (const attributes of [
    'id="cdn_url"',
    'name="cdn_url"',
    'name="cdn_url0"',
  ])
    await readback(
      {
        title,
        editorHtml: articleHtml,
        coverProof: null,
        dom: `<input type="hidden" ${attributes} value="${encodedCoverUrl}">`,
      },
      expected,
    );
});

test("cover readback supports dedicated cover preview images without using body images", async () => {
  for (const source of ["src", "data-src"])
    for (const dom of [
      `<div class="js_cover_preview"><img ${source}="${encodedCoverUrl}"></div>`,
      `<div id="js_cover"><img ${source}="${encodedCoverUrl}"></div>`,
      `<img class="js_cover" ${source}="${encodedCoverUrl}">`,
    ])
      await readback(
        { title, editorHtml: articleHtml, coverProof: null, dom },
        expected,
      );
});

test("cover readback supports dedicated cover preview backgrounds", async () => {
  for (const selector of [
    'id="js_cover"',
    'class="js_cover"',
    'class="js_cover_preview"',
  ])
    await readback(
      {
        title,
        editorHtml: articleHtml,
        coverProof: null,
        dom: `<div ${selector} style="background-image:url('${encodedCoverUrl}')"></div>`,
      },
      expected,
    );
});

test("agreeing cover sources allow HTTP and fragment normalization without weakening identity", async () => {
  await readback(
    {
      title,
      editorHtml: articleHtml,
      appmsgData: { item: [{ cdn_url: coverUrl }] },
      wx: {
        cgiData: {
          appmsg_info: {
            cover_url: coverUrl.replace("https:", "http:") + "#imgIndex=0",
          },
        },
      },
      dom: `<div class="js_cover_preview"><img src="${encodedCoverUrl}"></div>`,
    },
    expected,
  );
});

test("missing, blank and incorrect cover proof is rejected even when the body matches", async () => {
  for (const fixture of [
    { coverProof: null },
    { coverProof: "" },
    { coverProof: null, appmsgData: { item: [{ cdn_url: "" }] } },
    { coverProof: "https://mmbiz.qpic.cn/a-different-cover.png" },
    { coverProof: coverUrl + "&different=1" },
  ])
    await assert.rejects(
      readback({ title, editorHtml: articleHtml, ...fixture }, expected),
      /未能核实微信草稿封面/,
    );
});

test("body illustrations cannot impersonate an independently saved cover", async () => {
  const bodyWithCover = articleHtml + `<img src="${encodedCoverUrl}">`;
  await assert.rejects(
    readback(
      {
        title,
        editorHtml: bodyWithCover,
        coverProof: null,
        dom: `<article><img src="${encodedCoverUrl}"></article>`,
      },
      { ...expected, html: bodyWithCover },
    ),
    /未能核实微信草稿封面/,
  );
});

test("conflicting cover metadata or dedicated DOM proof is rejected", async () => {
  const other = "https://mmbiz.qpic.cn/stale-cover.png";
  for (const fixture of [
    {
      coverProof: null,
      appmsgData: { item: [{ cdn_url: coverUrl, cover_url: other }] },
    },
    {
      coverProof: null,
      appmsgData: { item: [{ cdn_url: coverUrl }] },
      wx: { cgiData: { appmsg_data: { item: [{ thumb_url: other }] } } },
    },
    { dom: `<img class="js_cover" src="${other}">` },
  ])
    await assert.rejects(
      readback({ title, editorHtml: articleHtml, ...fixture }, expected),
      /未能核实微信草稿封面/,
    );
});

test("empty or multi-article cover metadata cannot confirm a single saved cover", async () => {
  for (const appmsgData of [
    { cdn_url: coverUrl, item: [] },
    { item: [{ cdn_url: coverUrl }, { cdn_url: coverUrl }] },
    { item: [{ cdn_url: coverUrl }], items: [] },
  ])
    await assert.rejects(
      readback(
        { title, editorHtml: articleHtml, coverProof: null, appmsgData },
        expected,
      ),
      /未能核实微信草稿封面/,
    );
});

test("untrusted cover URLs are rejected despite another correct cover source", async () => {
  for (const invalid of [
    "https://example.com/cover.png",
    "https://mmbiz.qpic.cn.example.com/cover.png",
    "https://username@mmbiz.qpic.cn/cover.png",
    "https://mmbiz.qpic.cn:444/cover.png",
    "data:image/png;base64,Y292ZXI=",
    "/relative-cover.png",
  ])
    await assert.rejects(
      readback(
        {
          title,
          editorHtml: articleHtml,
          appmsgData: { item: [{ cover_url: invalid }] },
        },
        expected,
      ),
      /未能核实微信草稿封面/,
    );
});

test("微信资源区块在外链被移除后仍保留完整地址与提取码，可通过保存核验", async () => {
  const html = wechatHtml(
    "## 阅读要点\n\n保留**适用条件**。\n\n链接：[查看资源](https://pan.quark.cn/s/own123?pwd=abcd) 提取码：abcd",
  );
  const expected = {
    title: "阅读说明",
    html,
    coverUrl: "https://mmbiz.qpic.cn/cover.png",
  };
  await readback(
    {
      title: expected.title,
      editorHtml: html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, "$1"),
      coverProof: expected.coverUrl,
    },
    expected,
  );
});

test("微信排版在窄正文区域保持左对齐、段间距及长链接换行", async () => {
  const url = `https://pan.quark.cn/s/${"a".repeat(80)}?pwd=abcd`;
  const html = wechatHtml(
    `## 阅读要点\n\n第一段正文说明。\n\n第二段正文说明。\n\n链接：[查看资源](${url}) 提取码：abcd`,
  );
  await withFixture({}, async (page) => {
    const result = await page.evaluate(
      ({ html }) => {
        const inherited = document.createElement("style");
        inherited.textContent =
          "p { margin:0; text-align:justify; letter-spacing:5px; }";
        document.head.append(inherited);
        const container = document.createElement("article");
        container.style.width = "350px";
        container.innerHTML = html;
        document.body.append(container);
        const paragraph = [...container.querySelectorAll("p")].find(
          (p) => p.textContent === "第一段正文说明。",
        )!;
        const link = container.querySelector("a")!;
        return {
          margin: getComputedStyle(paragraph).marginBottom,
          size: getComputedStyle(paragraph).fontSize,
          align: getComputedStyle(link.parentElement!).textAlign,
          spacing: getComputedStyle(link.parentElement!).letterSpacing,
          text: link.textContent,
          width: container.clientWidth,
          scrollWidth: container.scrollWidth,
          height: link.parentElement!.getBoundingClientRect().height,
        };
      },
      { html },
    );
    assert.equal(result.margin, "18px");
    assert.equal(result.size, "16px");
    assert.equal(result.align, "left");
    assert.equal(result.spacing, "normal");
    assert.equal(result.text, url);
    assert(result.scrollWidth <= result.width);
    assert(result.height > 30);
  });
});

test("正文外链被移除时，阅读原文入口仍需独立核实", async () => {
  const html = wechatHtml(
    `- 第一项\n\n- 第二项\n\n链接：[查看资源](${resourceUrl})`,
  );
  const stripped = html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, "$1");
  const proof = { title, html, coverUrl, sourceUrl: resourceUrl };
  await readback(
    { title, editorHtml: stripped, sourceUrl: resourceUrl },
    proof,
  );
  for (const sourceUrl of [
    "",
    "https://pan.quark.cn/s/wrong",
    "javascript:alert(1)",
  ])
    await assert.rejects(
      readback({ title, editorHtml: stripped, sourceUrl }, proof),
      /阅读原文/,
    );
  await assert.rejects(
    readback({ title, editorHtml: stripped }, proof),
    /阅读原文/,
  );
  await readback(
    { title, editorHtml: stripped },
    { ...proof, sourceUrl: undefined },
  );
});

test("阅读原文以当前已保存元数据为准，不以未保存输入或其他草稿冒充", async () => {
  const proof = { ...expected, sourceUrl: resourceUrl };
  const metadata = (sourceUrl: string, appId = 123456) => ({
    app_id: appId,
    multi_item: [
      { title, content: articleHtml, cdn_url: coverUrl, source_url: sourceUrl },
    ],
  });
  await readback({ appmsgData: metadata(resourceUrl) }, proof);
  await assert.rejects(
    readback({ appmsgData: metadata(""), sourceUrl: resourceUrl }, proof),
    /阅读原文/,
  );
  await assert.rejects(
    readback(
      {
        title,
        editorHtml: articleHtml,
        appmsgData: metadata(resourceUrl, 999999),
      },
      proof,
    ),
    /阅读原文/,
  );
});

test("交付列表只包含实际条目，没有会被微信转换为空圆点的换行节点", async () => {
  const html = wechatHtml(
    "- 你在亲密关系中的真实表现\n\n- 分手后你会进入什么样的状态\n\n-    \n\n普通正文。",
  );
  await withFixture({}, async (page) => {
    const result = await page.evaluate(
      ({ html }) => {
        const doc = new DOMParser().parseFromString(html, "text/html"),
          list = doc.querySelector("ul")!;
        return {
          childNodes: [...list.childNodes].map((node) => node.nodeName),
          items: [...list.children].map((node) => node.textContent),
        };
      },
      { html },
    );
    assert.deepEqual(result.childNodes, ["LI", "LI"]);
    assert.deepEqual(result.items, [
      "你在亲密关系中的真实表现",
      "分手后你会进入什么样的状态",
    ]);
  });
});
