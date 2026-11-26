import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  defaultWechatTemplate,
  getWechatTemplate,
  selectableWechatTemplateIds,
  wechatTemplateIds,
  wechatTemplateSchema,
} from "../shared/wechat-templates";
import { wechatHtml } from "../shared/wechat-markup";
import { wechatPreviewHtml } from "../src/wechat/image-preview";
import { providerIds, providerSpecs } from "../shared/providers";

const body =
  "## 阅读要点\n\n这是**已有条件**。\n\n- 第一项\n- 第二项\n\n> 保留原文提醒。\n\n![配图](https://example.com/image.png)\n\n入口链接🔗：[查看资源](https://pan.quark.cn/s/entry?pwd=AB12)\n\n[配套附件](https://pan.baidu.com/s/1other) 提取码：CD34";
const legacyHashes = [
  "160508163132ca2cfe70d7582f0b82fec5ce9520fb68bf8944e5e1cdb1b4624e",
  "f6da92ea50635c1138c81950e8fd33f75a787a0153b02ccb988a037bd2534448",
  "9b612122f045ed980a2dd9c86e1be71a29832be91d82a114f59467e3a7ce6582",
  "9b612122f045ed980a2dd9c86e1be71a29832be91d82a114f59467e3a7ce6582",
  "2908888d5842c4b4b3f01622f25e5f635553a5522c29d3bf6e71e25f4a5753d0",
];
test("旧模板0至4输出逐字兼容，历史未知保存不被新增样式影响", () => {
  for (let version = 0; version <= 4; version++) {
    for (const templateId of wechatTemplateIds) {
      const html = wechatHtml(body, version, undefined, templateId);
      assert.equal(
        createHash("sha256").update(html).digest("hex"),
        legacyHashes[version],
      );
    }
  }
  assert.equal(wechatHtml(body), wechatHtml(body, 4));
  assert.equal(defaultWechatTemplate, "classic");
});

test("已停用模板回到默认样式，版本5至7保留原有送稿逐字输出", () => {
  assert.deepEqual(selectableWechatTemplateIds, ["classic", "ice-blue"]);
  assert.equal(wechatTemplateSchema.parse("minimal"), "minimal");
  assert.equal(
    wechatHtml(body, undefined, undefined, "minimal"),
    wechatHtml(body),
  );
  for (const [version, id, hash] of [
    [
      5,
      "minimal",
      "5ee60d19aa691f35bfe1a94ae6d2b10a05b6335df64749276470c7cfbb8b5ac6",
    ],
    [
      5,
      "ice-blue",
      "9d9f46755719b65f36e7bdeecfd25276c90c3a6b35cd20afd22ddcb343980982",
    ],
    [
      6,
      "ice-blue",
      "214cedea5f7b4b640ad98755088393fce2128712e69f1e6af6ab049e271b368d",
    ],
    [
      7,
      "ice-blue",
      "b18104f59f73e728c4f73e119b1d5474b79f4649f20855163309be72047d4f0b",
    ],
  ] as const) {
    assert.equal(
      createHash("sha256")
        .update(wechatHtml(body, version, undefined, id))
        .digest("hex"),
      hash,
    );
  }
});

test("冰蓝模板以首段和标题分区，保留全文顺序且不引入外部装饰素材", () => {
  const prose =
    "文章导语，保留**已有条件**。\n\n## 使用步骤\n\n1. 阅读说明\n2. 按原有顺序操作\n\n![步骤图](https://example.com/steps.png)\n\n## 资料入口\n\n配套资料见下方。";
  const markdown = `${prose}\n\n[查看资源](https://pan.quark.cn/s/entry?pwd=AB12)`;
  const html = wechatHtml(markdown, undefined, undefined, "ice-blue");
  assert.equal(
    wechatHtml(prose, undefined, undefined, "ice-blue"),
    wechatHtml(prose, 5, undefined, "ice-blue"),
    "正文排版与增强网盘链接之前一致",
  );
  assert.match(html, /background-color:#f6fcff/);
  assert.match(html, /border:1px solid #6ca1c3;border-radius:20px 0/);
  assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 12);
  assert.equal((html.match(/<h3\b/g) ?? []).length, 2);
  assert.equal(
    (html.match(/<img\b/g) ?? []).length,
    1,
    "标题装饰不用图片，不影响图数核验",
  );
  assert.equal(
    (html.match(/border:1px solid #6ca1c3/g) ?? []).length,
    3,
    "导语和两个内容分区保留原边框",
  );
  const text = (value: string) =>
    value.replace(/<[^>]*>/g, "").replace(/\s/g, "");
  assert.equal(
    text(html),
    text(wechatHtml(markdown)),
    "模板不添写标题、署名、口令或正文内容",
  );
  assert(!/<li[^>]*>\s*<\/li>/.test(html));
  assert(!/onclick|<script|<svg|<style/.test(html));
  assert.match(
    html,
    /border:1px solid #a9cde2;border-radius:10px;background-color:#eaf5ff/,
  );
  assert.doesNotMatch(html, /border-left:4px/);
});

test("冰蓝分区覆盖无导语、无标题、连续标题和代码，不产生空内容框或误读伪标题", () => {
  for (const markdown of [
    "## 开始\n\n正文",
    "没有标题的普通正文。",
    "## 一\n\n## 二\n\n最后的正文。",
    "",
  ]) {
    const html = wechatHtml(markdown, undefined, undefined, "ice-blue");
    assert(
      !/<section[^>]*>\s*<\/section>/.test(
        html.replace(/^<section[^>]*>/, "").replace(/<\/section>$/, ""),
      ),
    );
  }
  const html = wechatHtml(
    "引导文字。\n\n```html\n<h3>代码不是标题</h3>\n```\n\n> ## 引用不是标题\n\n## 真正的标题\n\n最后正文。",
    undefined,
    undefined,
    "ice-blue",
  );
  assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 6);
  assert.match(html, /&lt;h3&gt;代码不是标题&lt;\/h3&gt;/);
  assert.match(html, /<blockquote[^>]*>## 引用不是标题<\/blockquote>/);
  assert.match(html, /真正的标题/);
});
test("冰蓝资源卡突出标题、完整地址、提取码和阅读原文提示，预览与送稿一致", () => {
  const html = wechatHtml(body, undefined, undefined, "ice-blue");
  const preview = wechatPreviewHtml(body, undefined, "ice-blue");
  assert.match(
    html,
    /border-radius:6px;background-color:#2d699c;color:#fff[^>]+>夸克网盘资源<\/p>/,
  );
  assert.match(
    html,
    /color:#174d79;font-weight:600;text-decoration:underline[^>]+>https:\/\/pan.quark.cn\/s\/entry\?pwd=AB12<\/a>/,
  );
  assert.match(html, /background-color:#d7eafb[^>]+>提取码：CD34<\/p>/);
  assert.match(
    html,
    /font-weight:700;line-height:1.6;color:#174d79;">点击文末“阅读原文”打开资源<\/p>/,
  );
  assert.match(html, /复制链接到浏览器打开/);
  assert.equal(
    preview.replace(/panxu-media:\/\/wechat-image\/\?url=[^" ]+/g, "IMAGE"),
    html.replace(/https:\/\/example.com\/image.png/g, "IMAGE"),
  );
});
test("每个模板覆盖全部已接入网盘，模板注册不依赖文章或特定网盘", () => {
  for (const id of selectableWechatTemplateIds) {
    assert.equal(wechatTemplateSchema.parse(id), id);
    assert.equal(getWechatTemplate(id).id, id);
    for (const provider of providerIds) {
      const url = `https://${providerSpecs[provider].shareHost}/s/fixture123?pwd=AB12`;
      const html = wechatHtml(
        `入口链接：[查看资源](${url})`,
        undefined,
        undefined,
        id,
      );
      assert(html.includes(`href="${url}"`));
      assert.match(html, /点击文末“阅读原文”打开资源/);
      assert(html.includes(providerSpecs[provider].name + "网盘资源"));
    }
  }
  assert.throws(() => wechatTemplateSchema.parse("unknown-template"));
});
