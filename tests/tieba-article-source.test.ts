import assert from "node:assert/strict";
import { test } from "node:test";
import { readPublicTiebaArticle } from "../desktop/tieba-article-source";
import { articleLinks } from "../core/smzdm/content";
import type { TiebaSourcePart } from "../core/tieba/analysis";
import { tiebaBaiduMiniAppShare } from "../shared/tieba-article-links";
import { wechatTiebaSourceSchema } from "../shared/wechat";

const id = "987654321";
const url = `https://tieba.baidu.com/p/${id}`;
const floor = {
  text: "主楼说明",
  hrefs: [] as string[],
  images: [] as string[],
  parts: [{ kind: "text", text: "主楼说明" }] as TiebaSourcePart[],
  truncated: false,
};
const thread = {
  id,
  url,
  title: "资料整理",
  forum: "资料",
  author: "原帖作者",
  publishedAt: "2024-06-23T09:00:45.000Z",
  firstFloor: floor,
};

test("贴吧公开数据只接受目标帖子，拒绝缺失、空白或已截断的主楼", async () => {
  assert.equal(
    await readPublicTiebaArticle(
      "https://example.org/p/987654321",
      async () => {
        assert.fail("外站地址不得触发帖子读取");
      },
    ),
    null,
  );
  for (const response of [
    { ...thread, id: "123" },
    { ...thread, url: "https://tieba.baidu.com/p/123" },
    { ...thread, firstFloor: null },
    { ...thread, firstFloor: { ...floor, parts: undefined } },
    {
      ...thread,
      firstFloor: {
        ...floor,
        parts: [{ kind: "text" as const, text: "  \n" }],
      },
    },
    { ...thread, firstFloor: { ...floor, truncated: true } },
  ])
    assert.equal(
      await readPublicTiebaArticle(url, async (requested) => {
        assert.equal(requested, id);
        return response;
      }),
      null,
    );
});

test("贴吧公开数据按原位置交错保留文字、链接、重复配图和提取码", async () => {
  const share = "https://pan.baidu.com/s/1SourceExample";
  const documentation = "https://example.org/help";
  const image = "https://tiebapic.baidu.com/forum/pic/item/first.jpg";
  const secondImage = "https://imgsrc.baidu.com/forum/pic/item/second.jpg";
  const result = wechatTiebaSourceSchema.parse(
    await readPublicTiebaArticle(
      url,
      async (_id, _transport, includeOrderedParts) => {
        assert.ok(includeOrderedParts);
        return {
          ...thread,
          firstFloor: {
            ...floor,
            parts: [
              { kind: "text", text: "正文保留版式。" },
              { kind: "image", url: `${image}#index` },
              {
                kind: "text",
                text: share,
                href: `https://tieba.baidu.com/mo/q/checkurl?url=${encodeURIComponent(share)}`,
              },
              { kind: "text", text: "\n提取码：demo" },
              { kind: "image", url: secondImage },
              {
                kind: "text",
                text: "帮助",
                href: `https://jump2.bdimg.com/safecheck/index?url=${encodeURIComponent(documentation)}`,
              },
              { kind: "image", url: image.replace("https:", "http:") },
              {
                kind: "image",
                url: "https://tiebapic.baidu.com.example.org/foreign.png",
              },
              {
                kind: "text",
                text: "文末文字",
                href: "https://user:password@example.org/",
              },
            ],
          },
        };
      },
    ),
  );
  assert.deepEqual(result, {
    kind: "tieba",
    url,
    title: thread.title,
    author: thread.author,
    publishedAt: thread.publishedAt,
    body: [
      "正文保留版式。",
      `![贴吧配图](${image})`,
      `${share}\n提取码：demo`,
      `![贴吧配图](${secondImage})`,
      `[帮助](${documentation})`,
      `![贴吧配图](${image})`,
      "文末文字",
    ].join("\n\n"),
    imageCount: 3,
    preservesImageOrder: true,
    warnings: ["1 张配图未导入，请对照原帖补充。"],
  });
});

const miniAppLink = (target: string, code = "a1b2") =>
  `tiebaclient://swan/${"A".repeat(32)}/pages/outsite-chain/share-code/index?${new URLSearchParams({ action: "preview_file", url: target, pwdcode: code })}`;

test("贴吧将百度网盘小程序链接还原在正确的标签处，并分开紧贴其他地址的提取码", async () => {
  const baidu = "https://pan.baidu.com/s/1BaiduExample";
  const other = "https://www.123pan.com/s/other-source";
  const result = wechatTiebaSourceSchema.parse(
    await readPublicTiebaArticle(url, async () => ({
      ...thread,
      firstFloor: {
        ...floor,
        parts: [
          { kind: "text", text: "下载地址\n\n" },
          {
            kind: "text",
            text: other,
            href: `https://tieba.baidu.com/mo/q/checkurl?url=${encodeURIComponent(other)}`,
          },
          { kind: "text", text: "提取码:demo\n\n" },
          { kind: "text", text: "百度网盘", href: miniAppLink(baidu) },
          { kind: "text", text: "\n\n提取码：a1b2" },
        ],
      },
    })),
  );
  assert.ok(result.body.includes(`${other} 提取码:demo`));
  assert.ok(
    result.body.includes(`[百度网盘](${baidu}?pwd=a1b2)\n\n提取码：a1b2`),
  );
  assert.doesNotMatch(result.body, /tiebaclient:/);
  const [[provider, address, code]] = articleLinks(result.body).map((link) => [
    link.provider,
    link.url,
    link.code,
  ]);
  assert.deepEqual([provider, address, code], ["baidu", baidu, "a1b2"]);
});

test("贴吧小程序分享转换仅接受规定路由、官方百度网盘地址和无歧义的提取码", () => {
  const valid = "https://pan.baidu.com/s/1BaiduExample";
  assert.equal(
    tiebaBaiduMiniAppShare(miniAppLink(valid))?.href,
    `${valid}?pwd=a1b2`,
  );
  assert.equal(
    tiebaBaiduMiniAppShare(
      miniAppLink("http://yun.baidu.com/s/1BaiduExample/", ""),
    )?.href,
    valid,
  );
  for (const value of [
    miniAppLink("https://pan.baidu.com.evil.invalid/s/1BaiduExample"),
    miniAppLink("http://pan.baidu.com.evil.invalid/s/1BaiduExample", ""),
    miniAppLink("https://pan.baidu.com/account"),
    miniAppLink("https://user:password@pan.baidu.com/s/1BaiduExample"),
    miniAppLink(`${valid}?pwd=zzzz`),
    miniAppLink(valid, "!bad"),
    miniAppLink(valid).replace("outsite-chain", "unrelated"),
    `${miniAppLink(valid)}&url=${encodeURIComponent(valid)}`,
  ])
    assert.equal(tiebaBaiduMiniAppShare(value), null);
});

test("贴吧小程序中的旧 HTTP 百度分享转换为 HTTPS，保留空提取码和配图位置", async () => {
  const legacyShare = "http://pan.baidu.com/s/1ClockExample";
  const canonicalShare = "https://pan.baidu.com/s/1ClockExample";
  const image = "https://tiebapic.baidu.com/forum/pic/item/clock.jpg";
  const article = wechatTiebaSourceSchema.parse(
    await readPublicTiebaArticle(url, async () => ({
      ...thread,
      firstFloor: {
        ...floor,
        parts: [
          { kind: "text", text: "分享桌面小工具。\n" },
          {
            kind: "text",
            text: "百度网盘",
            href: miniAppLink(legacyShare, ""),
          },
          { kind: "image", url: image },
        ],
      },
    })),
  );
  assert.equal(
    article.body,
    `分享桌面小工具。\n[百度网盘](${canonicalShare})\n\n![贴吧配图](${image})`,
  );
  assert.deepEqual(
    articleLinks(article.body).map(({ provider, url, code }) => ({
      provider,
      url,
      code,
    })),
    [{ provider: "baidu", url: canonicalShare, code: "" }],
  );
});
