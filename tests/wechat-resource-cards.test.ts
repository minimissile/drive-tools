import test from "node:test";
import assert from "node:assert/strict";
import { providerIds, providerSpecs } from "../shared/providers";
import { isWechatResourceUrl, wechatHtml } from "../shared/wechat-markup";
import { parseShare } from "../core/links";

const prefixes = [
  "入口链接🔗：",
  "✨ 今日下载通道：",
  "**获取地址**：",
  "🗂 附件位置：",
  "",
  "资源 ",
];
for (const provider of providerIds) {
  test(`${providerSpecs[provider].name}：资源卡片覆盖所有入口写法、命名链接与提取码`, () => {
    const url = `https://${providerSpecs[provider].shareHost}/s/fixture_123?pwd=Ab12&from=article`;
    assert.equal(parseShare(url).provider, provider);
    assert(isWechatResourceUrl(new URL(url)));
    for (const prefix of prefixes) {
      for (const label of ["查看资源", "配套附件", url]) {
        const html = wechatHtml(`${prefix}[${label}](${url}) 提取码：Ab12`);
        assert.match(
          html,
          /border-radius:12px/,
          `${provider}: ${prefix} ${label}`,
        );
        assert.match(html, /提取码：Ab12/);
        assert.match(html, /点击文末“阅读原文”打开资源/);
        if (label === "查看资源" && (!prefix || prefix === "入口链接🔗："))
          assert(html.includes(`>${providerSpecs[provider].name}网盘资源</p>`));
        assert(html.includes(`href="${url.replace(/&/g, "&amp;")}"`));
      }
    }
  });
}

test("所有已接入别名域名与百度旧式入口均与项目分享解析一致", () => {
  for (const host of [
    "yun.baidu.com",
    "pan.uc.cn",
    "fast.uc.cn",
    "guangyapan.com",
  ]) {
    const url = `https://${host}/s/alias_123?pwd=Ab12`;
    assert.equal(
      parseShare(url).provider,
      host === "yun.baidu.com"
        ? "baidu"
        : host.includes("uc.cn")
          ? "uc"
          : "guangya",
    );
    assert.match(
      wechatHtml(`入口链接🔗：[查看资源](${url})`),
      /border-radius:12px/,
    );
  }
  for (const host of ["pan.baidu.com", "yun.baidu.com"]) {
    const url = `https://${host}/share/init?surl=old123&pwd=Ab12`;
    assert.equal(parseShare(url).provider, "baidu");
    assert.match(
      wechatHtml(`附件地址：[查看资源](${url})`),
      /border-radius:12px/,
    );
  }
});

test("一段多个网盘分别成卡，保留各自说明、地址与提取码", () => {
  const urls = [
    "https://pan.baidu.com/s/1first?pwd=AB12",
    "https://drive.uc.cn/s/second?pwd=CD34",
  ];
  const body = `下载地址：[查看资源](${urls[0]}) 提取码：AB12；备用附件：[备用资料](${urls[1]}) 密码：CD34`;
  const html = wechatHtml(body);
  assert.equal((html.match(/border-radius:12px/g) ?? []).length, 2);
  assert.match(html, /备用附件 · 备用资料/);
  assert.match(html, /提取码：AB12/);
  assert.match(html, /密码：CD34/);
  assert.equal((html.match(/点击文末/g) ?? []).length, 1);
  assert.equal((html.match(/复制链接到浏览器打开/g) ?? []).length, 1);
});

test("行文中的链接、代码、外部网站和伪装域名不会被误拆成资源卡", () => {
  const url = "https://pan.quark.cn/s/first";
  for (const body of [
    `正文中提到[更多资料](${url})，请先看完整说明。`,
    `入口链接：[查看资源](${url})，阅读说明后再打开。`,
    `\`入口链接：[查看资源](${url})\``,
    `\`\`\`\n入口链接：[查看资源](${url})\n\`\`\``,
    "入口链接：[外部网站](https://example.com/s/first)",
    "入口链接：[伪装域名](https://pan.quark.cn.attacker.test/s/first)",
    "入口链接：[凭据](https://user:pass@pan.baidu.com/s/1first)",
    "入口链接：[脚本](javascript:alert(1))",
    `入口链接：[含 \`代码\` 的资料](${url})`,
  ])
    assert.doesNotMatch(wechatHtml(body), /border-radius:12px/);
});

test("新前缀排版只在新版启用，旧稿缺少快照时仍使用原来的格式核对", () => {
  const body = "入口链接🔗：[查看资源](https://pan.quark.cn/s/entry)";
  assert.match(wechatHtml(body, 4), /border-radius:12px/);
  for (const version of [0, 1, 2, 3]) {
    assert.doesNotMatch(wechatHtml(body, version), /border-radius:12px/);
    assert.match(wechatHtml(body, version), /入口链接🔗/);
  }
});
