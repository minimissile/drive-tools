import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "../core/database";
import { WechatDiscovery } from "../core/wechat/discovery";

const first = "https://mp.weixin.qq.com/s/article-first";
const second = "https://mp.weixin.qq.com/s/article-second";
const third = "https://mp.weixin.qq.com/s/article-third";

function fixture(
  request: (url: string, init: RequestInit) => Promise<Response>,
) {
  const db = new Database(":memory:");
  const discovery = new WechatDiscovery({
    db,
    secrets: { has: () => true, get: async () => "fixture-key" },
    request,
  });
  return { db, discovery };
}

test("公众号发现保留安全文章链接与服务端翻页游标", async () => {
  const raw =
    "http://mp.weixin.qq.com/s?__biz=publisher&amp;mid=123&amp;idx=1&amp;sn=signature&amp;scene=7#rd";
  const cursor = "opaque-cursor+encoded==";
  const { db, discovery } = fixture(async (url, init) => {
    assert.equal(
      url,
      "https://api.tikhub.io/api/v1/wechat_search/v2/fetch_search",
    );
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(String(init.body)), {
      keyword: "示例",
      business_type: "article",
      sort: "latest",
      publish_time: "week",
      cursor,
      raw: false,
    });
    return Response.json({
      code: 200,
      data: {
        items: [
          {
            title: "示例<em>文章</em>",
            doc_url: raw,
            source: { title: "示例公众号" },
            desc: "图文 &amp; 资料",
            timestamp: 1720000000,
          },
          { title: "重复文章", doc_url: raw },
          { title: "其他文章", jumpInfo: { jumpUrl: second } },
          {
            title: "仿冒域名",
            doc_url: "https://mp.weixin.qq.com.invalid/s/bad",
          },
        ],
        continue_flag: 1,
        cursor: "next-page-cursor",
        total: 60,
      },
    });
  });
  try {
    const result = await discovery.discover({
      keyword: "示例",
      sort: "latest",
      publishTime: "week",
      cursor,
    });
    assert.deepEqual(result, {
      total: 60,
      nextCursor: "next-page-cursor",
      items: [
        {
          url: "https://mp.weixin.qq.com/s?__biz=publisher&mid=123&idx=1&sn=signature",
          title: "示例文章",
          accountName: "示例公众号",
          summary: "图文 & 资料",
          publishedAt: "2024-07-03T09:46:40.000Z",
        },
        {
          url: second,
          title: "其他文章",
          accountName: "",
          summary: "",
          publishedAt: null,
        },
      ],
    });
    const calls = db.all<{
      phase: string;
      status: string;
      estimated_micros: number;
    }>(
      "SELECT phase,status,estimated_micros FROM api_calls WHERE endpoint='tikhub:wechat'",
    );
    assert.deepEqual(
      calls.map((row) => ({ ...row })),
      [{ phase: "search", status: "success", estimated_micros: 10000 }],
    );
  } finally {
    discovery.close();
    db.close();
  }
});

test("公众号阅读数查询保留真实零值，遇到限流不消耗剩余文章的请求", async () => {
  const requested: string[] = [];
  const { db, discovery } = fixture(async (url, init) => {
    assert.equal(
      url,
      "https://api.tikhub.io/api/v1/wechat_mp/v2/fetch_article_stats",
    );
    const body = JSON.parse(String(init.body));
    assert.equal(body.raw, true);
    requested.push(body.url);
    return body.url === first
      ? Response.json({
          code: 200,
          data: {
            read_num: 0,
            show_read: 1,
            like_count: 1,
            show_like: 0,
            share_count: "2",
          },
        })
      : new Response("limit", { status: 429 });
  });
  try {
    const { items, failures } = await discovery.stats({
      urls: [first, first, second, third],
    });
    assert.deepEqual(requested, [first, second]);
    assert.equal(items.length, 1);
    assert.equal(items[0].readCount, 0);
    assert.equal(items[0].likeCount, null);
    assert.equal(items[0].commentCount, null);
    assert.equal(items[0].shareCount, 2);
    assert.deepEqual(
      failures.map(({ url }) => url),
      [second, third],
    );
    assert.match(failures[0].message, /频繁/);
    assert.match(failures[1].message, /暂停/);
    const statuses = db.all<{ status: string }>(
      "SELECT status FROM api_calls ORDER BY rowid",
    );
    assert.deepEqual(
      statuses.map(({ status }) => status),
      ["success", "error"],
    );
  } finally {
    discovery.close();
    db.close();
  }
});
