import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  defaultWechatTemplate,
  getWechatTemplate,
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
    const html = wechatHtml(body, version, undefined, "minimal");
    assert.equal(
      createHash("sha256").update(html).digest("hex"),
      legacyHashes[version],
    );
  }
  assert.equal(wechatHtml(body), wechatHtml(body, 4));
  assert.equal(defaultWechatTemplate, "classic");
});
test("切换模板只改变展示样式，段落、列表、图片、资源及提取码全部保留", () => {
  const classic = wechatHtml(body, undefined, undefined, "classic");
  const minimal = wechatHtml(body, undefined, undefined, "minimal");
  assert.notEqual(classic, minimal);
  const withoutStyle = (html: string) => html.replace(/\sstyle="[^"]*"/g, "");
  assert.equal(withoutStyle(classic), withoutStyle(minimal));
  assert.match(minimal, /font-size:17px;line-height:1.95/);
  assert.match(minimal, /border-top:1px solid #dfe3e9/);
  assert.match(classic, /border-radius:12px/);
  const preview = wechatPreviewHtml(body, undefined, "minimal");
  assert.equal(
    preview.replace(/panxu-media:\/\/wechat-image\/\?url=[^" ]+/g, "IMAGE"),
    minimal.replace(/https:\/\/example.com\/image.png/g, "IMAGE"),
  );
});
test("每个模板覆盖全部已接入网盘，模板注册不依赖文章或特定网盘", () => {
  for (const id of wechatTemplateIds) {
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
