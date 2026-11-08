import test from "node:test";
import assert from "node:assert/strict";
import {
  wechatImagePreviewUrl,
  wechatPreviewHtml,
} from "../src/wechat/image-preview";
import { linkifyWechatMarkdown, wechatHtml } from "../shared/wechat-markup";

test("裸资源地址转换为 Markdown 超链接，保留提取码参数及多个链接", () => {
  const first = "https://pan.quark.cn/s/own123?pwd=abcd&from=article";
  const second = "https://pan.baidu.com/s/1another?pwd=efgh";
  const body = `链接：${first}。\n\n另外一份：${second}\n\nhttps://example.com/help`;
  const result = linkifyWechatMarkdown(body);
  assert.equal(
    result,
    `链接：[查看资源](${first})。\n\n另外一份：[查看资源](${second})\n\n[https://example.com/help](https://example.com/help)`,
  );
  assert.equal(linkifyWechatMarkdown(result), result, "反复整理不嵌套链接");
  assert.equal((wechatHtml(result).match(/<a /g) ?? []).length, 3);
});

test("整理超链接不改变既有链接、图片、代码或链接定义", () => {
  const body = [
    "[自定义说明](https://pan.quark.cn/s/own123)",
    "![照片](https://mmbiz.qpic.cn/photo.jpg?x=1#imgIndex=0)",
    "`https://pan.quark.cn/s/inline`",
    "```\nhttps://pan.quark.cn/s/example\n```",
    "~~~\nhttps://example.com/code\n~~~",
    "[资源]: https://pan.quark.cn/s/reference",
    "https://user:password@example.com/private",
  ].join("\n\n");
  assert.equal(linkifyWechatMarkdown(body), body);
});

test("remote preview uses the bounded media protocol and preserves the original URL as data", () => {
  const source =
    "https://mmbiz.qpic.cn/image.png?format=png&value=%22#imgIndex=1";
  const proxy = new URL(wechatImagePreviewUrl(source));
  assert.equal(proxy.protocol, "panxu-media:");
  assert.equal(proxy.hostname, "wechat-image");
  assert.equal(proxy.searchParams.get("url"), source);
});
test("local preview remains local and unsafe addresses are not requested", () => {
  const local = `panxu-media://wechat/${"a".repeat(64)}.png`;
  assert.equal(wechatImagePreviewUrl(local), local);
  for (const value of [
    "javascript:alert(1)",
    "http://example.com/p.png",
    "https://user:pass@example.com/p.png",
    "https://example.com:8443/p.png",
    `${local}?secret=1`,
    "panxu-media://asset/private.png",
    "not a URL",
  ])
    assert.equal(wechatImagePreviewUrl(value), "");
});
test("HTML preview proxies only image sources while publishing retains original sources and links", () => {
  const image = "https://mmbiz.qpic.cn/image.png?x=1&text=%22";
  const body = `正文\n\n![配图](${image})\n\n[资源](https://pan.quark.cn/s/own123)`;
  const preview = wechatPreviewHtml(body),
    published = wechatHtml(body);
  assert.match(preview, /src="panxu-media:\/\/wechat-image\//);
  assert.doesNotMatch(preview, /src="https:/);
  assert.match(preview, /href="https:\/\/pan.quark.cn\/s\/own123"/);
  const src = preview.match(/src="([^"]+)"/)![1];
  assert.equal(new URL(src).searchParams.get("url"), image);
  assert.match(
    published,
    /src="https:\/\/mmbiz.qpic.cn\/image.png\?x=1&amp;text=%22"/,
  );
  assert.doesNotMatch(published, /wechat-image/);
});

test("Markdown 层次、列表、引用和分隔线在预览与微信交付中一致保留", () => {
  const body = [
    "## 阅读要点",
    "",
    "这是**重要条件**。",
    "",
    "- 保留前提",
    "- 核对已有资料",
    "",
    "### 操作顺序",
    "",
    "1. 打开资料",
    "2. 阅读提醒",
    "",
    "> 仅作学习参考。",
    "",
    "---",
    "",
    "![配图](https://mmbiz.qpic.cn/fixture.png)",
    "",
    "[资料](https://pan.quark.cn/s/own123?pwd=abcd)",
  ].join("\n");
  for (const html of [wechatPreviewHtml(body), wechatHtml(body)]) {
    assert.match(html, /<h3>阅读要点<\/h3>/);
    assert.match(html, /<h4>操作顺序<\/h4>/);
    assert.match(html, /<strong>重要条件<\/strong>/);
    assert.match(
      html,
      /<ul><li>保留前提<\/li>\n<li>核对已有资料<\/li>\n\n<\/ul>/,
    );
    assert.match(html, /<ol><li>打开资料<\/li>\n<li>阅读提醒<\/li>\n\n<\/ol>/);
    assert.match(html, /<blockquote>仅作学习参考。<\/blockquote>/);
    assert.match(html, /<hr>/);
    assert.match(html, /href="https:\/\/pan.quark.cn\/s\/own123\?pwd=abcd"/);
    assert.equal((html.match(/<img /g) ?? []).length, 1);
    assert.doesNotMatch(html, /<p>[-#]|<p>1\./);
  }
});

test("Markdown 列表关闭、起始编号与代码隔离不引入HTML或链接", () => {
  const body =
    "3. **第三项**\n4. 第四项\n\n普通正文\n- 新列表\n\n```\n- 代码中的条目\n<script>x</script>\n```\n\n`https://example.com <script>`\n[含 `代码` 的链接](https://example.com)";
  const html = wechatHtml(body);
  assert.match(html, /<ol start="3"><li><strong>第三项<\/strong><\/li>/);
  assert.match(html, /<\/ol><p>普通正文<\/p>/);
  assert.match(html, /<\/ul><pre><code>/);
  assert.match(html, /- 代码中的条目\n&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /<code>https:\/\/example.com &lt;script&gt;<\/code>/);
  assert.match(html, /含 <code>代码<\/code> 的链接/);
  assert.doesNotMatch(html, /\u0000|<script>/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
});
