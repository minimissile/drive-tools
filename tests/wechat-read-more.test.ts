import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveWechatReadMore,
  type WechatReadMoreEntry,
} from "../shared/wechat-read-more";
import { wechatHtml, wechatReadMoreUrls } from "../shared/wechat-markup";

const entries: WechatReadMoreEntry[] = ["first", "second"].map((name) => ({
  linkId: name,
  title: name,
  driveUrl: `https://pan.quark.cn/s/${name}`,
  landingUrl: `https://panxu.site/r/${name}`,
  redirectUrl: `https://panxu.site/go/${name}`,
  landingIssue: null,
  redirectIssue: null,
}));
const body =
  "[资料一](https://pan.quark.cn/s/first?pwd=1234)\n\n[资料二](https://pan.quark.cn/s/second?pwd=5678)";

test("阅读原文默认按正文顺序选择，多资源可显式选择第二个并保留提取码", () => {
  assert.equal(
    resolveWechatReadMore(body, entries).url,
    "https://pan.quark.cn/s/first?pwd=1234",
  );
  const selected = resolveWechatReadMore(body, entries, {
    kind: "landing",
    linkId: "second",
  });
  assert.equal(selected.url, "https://panxu.site/r/second");
  assert.equal(selected.driveUrl, "https://pan.quark.cn/s/second?pwd=5678");
  const html = wechatHtml(body, undefined, selected.driveUrl);
  assert.equal((html.match(/点击文末“阅读原文”打开资源/g) ?? []).length, 1);
  assert.match(html, /first\?pwd=1234/);
  assert.match(html, /second\?pwd=5678/);
  assert.match(html, /复制链接到浏览器打开/);
  assert.equal(
    resolveWechatReadMore(body, entries, { kind: "redirect", linkId: "second" })
      .url,
    "https://panxu.site/go/second",
  );
});

test("代码块与图片地址不作为原文链接，未设置的新旧无资源稿保持兼容", () => {
  assert.deepEqual(
    wechatReadMoreUrls(
      "```\nhttps://pan.quark.cn/s/code\n```\n\n![图](https://pan.quark.cn/s/image)\n\n" +
        body,
    ),
    [
      "https://pan.quark.cn/s/first?pwd=1234",
      "https://pan.quark.cn/s/second?pwd=5678",
    ],
  );
  assert.equal(resolveWechatReadMore("普通正文", []).url, "");
  assert.equal(resolveWechatReadMore("普通正文", []).issue, null);
  assert.match(
    resolveWechatReadMore(body, entries, { kind: "drive", linkId: "removed" })
      .issue!,
    /重新选择/,
  );
  assert.match(
    resolveWechatReadMore(body, [], { kind: "landing" }).issue!,
    /入库/,
  );
  assert.equal(
    resolveWechatReadMore("无资源正文", entries, {
      kind: "drive",
      linkId: "first",
    }).missing,
    true,
  );
  assert.equal(
    resolveWechatReadMore("无资源正文", entries, { kind: "drive" }).issue,
    null,
  );
});
