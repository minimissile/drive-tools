import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JianshuSourceCollector } from "../core/jianshu/sources";
import {
  JianshuSourceNetwork,
  isPublicSourceAddress,
  sourceUrl,
  type SourceTransport,
} from "../core/jianshu/sources-network";
import {
  parseSourceFeed,
  parseSourceTelegram,
  parseSourceWeb,
} from "../core/jianshu/sources-parser";
import {
  jianshuCollectSchema,
  jianshuSourcePresets,
  parseJianshuSourceReference,
} from "../shared/jianshu-sources";

const at = "2026-11-23T02:00:00.000Z";
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>资料更新</title>
<item><title>英语 &amp; 口语</title><link>https://resource.example.org/a</link><dc:creator>原作者</dc:creator><pubDate>Mon, 23 Nov 2026 08:00:00 +0800</pubDate><content:encoded><![CDATA[<p>课程目录和适用人群，公开介绍中的可核对说明。</p><p><a href="https://pan.quark.cn/s/shareone12?pwd=ABCD">资料地址</a></p><img src="/cover.jpg" alt="资料封面"><script>恶意脚本</script>]]></content:encoded></item>
<item><title>第二篇</title><link>https://resource.example.org/b</link><description>这是第二份公开资料的介绍和适用范围。</description></item></channel></rss>`;

test("source schema exposes supported presets and a bounded one-page limit", () => {
  assert.equal(
    jianshuCollectSchema.parse({ url: "https://example.org/feed" }).limit,
    20,
  );
  assert.throws(() => jianshuCollectSchema.parse({ limit: 51 }));
  assert.ok(jianshuSourcePresets.some((p) => p.id === "sspai"));
  assert.ok(jianshuSourcePresets.some((p) => p.provider === "telegram"));
  assert.ok(!jianshuSourcePresets.some((p) => /tmdb|pansou/i.test(p.id)));
});

test("Tieba uses the canonical thread ID and treats pictures and shares as references", async () => {
  const tid = "9063569462";
  const url = `https://tieba.baidu.com/p/${tid}`;
  const share = "https://www.123pan.com/s/example12";
  const image = "https://tiebapic.baidu.com/forum/example.jpg";
  const collector = new JianshuSourceCollector({
    now: () => at,
    lookup: async () => assert.fail("no lookup for user-provided URLs"),
    transport: async () => assert.fail("no following external URLs"),
    async readTiebaThread(id) {
      assert.equal(id, tid);
      return {
        id,
        url,
        title: "打印机共享使用流程",
        forum: "windows11",
        author: "楼主",
        publishedAt: at,
        firstFloor: {
          text: `步骤一：在局域网内检查设备。\n\n步骤二：设置打印机。\n${share}`,
          hrefs: [
            `https://tieba.baidu.com/mo/q/checkurl?url=${encodeURIComponent(`${share}?pwd=ABCD`)}`,
            share,
          ],
          images: [image, image, "https://127.0.0.1/a.png"],
          truncated: true,
        },
      };
    },
  });
  const result = await collector.collect({
    provider: "tieba",
    url: `${url}?pn=2&pid=12#12`,
  });
  const [post] = result.items;
  assert.equal(post.url, url);
  assert.equal(
    post.id,
    (await collector.collect({ provider: "tieba", url })).items[0].id,
  );
  assert.equal(post.sourceName, "百度贴吧 · windows11吧");
  assert.equal(post.publishedAt, at);
  assert.match(post.body, /设备。\n\n步骤二/);
  assert.doesNotMatch(post.summary, /www\.123pan\.com/);
  assert.deepEqual(post.images, [{ url: image, alt: "" }]);
  assert.deepEqual(post.externalShares, [
    { url: `${share}?pwd=ABCD`, code: "ABCD" },
  ]);
  assert.match(post.warnings.join("\n"), /仅保留前段/);
});

test("Tieba rejects non-topic addresses before reading and surfaces missing first-floor content", async () => {
  const tid = "9063569462";
  const url = `https://tieba.baidu.com/p/${tid}`;
  let calls = 0;
  let failure = false;
  const collector = new JianshuSourceCollector({
    async readTiebaThread(id) {
      calls++;
      if (failure) throw new Error("upstream unavailable");
      return {
        id,
        url,
        title: "标题",
        forum: "windows11",
        author: "",
        publishedAt: null,
        firstFloor: null,
      };
    },
  });
  for (const invalid of [
    "",
    tid,
    `/p/${tid}`,
    `http://tieba.baidu.com/p/${tid}`,
    `https://tieba.baidu.com.example.com/p/${tid}`,
    "https://tieba.baidu.com/f?kw=windows11",
    "https://tieba.baidu.com/p/9223372036854775808",
  ]) {
    await assert.rejects(
      collector.collect({ provider: "tieba", url: invalid }),
      /请粘贴百度贴吧主题帖/,
    );
  }
  assert.equal(calls, 0);
  await assert.rejects(
    collector.collect({ provider: "tieba", url }),
    /未读到楼主首楼/,
  );
  failure = true;
  await assert.rejects(
    collector.collect({ provider: "tieba", url }),
    /暂时无法读取.*稍后重试/,
  );
});

test("source reference parser permits legacy attribution but rejects unsafe URL forms", () => {
  assert.equal(
    parseJianshuSourceReference("http://example.org:80/post#section"),
    "http://example.org/post",
  );
  assert.equal(
    parseJianshuSourceReference("https://example.org:443/post"),
    "https://example.org/post",
  );
  for (const raw of [
    "http://user:pass@example.org/post",
    "http://127.1/a",
    "http://2130706433/a",
    "http://[::1]/a",
    "http://host.local/a",
    "http://localhost/a",
    "http://example.org:443/a",
    "http://example.org:8080/a",
    "javascript:alert(1)",
  ]) {
    assert.equal(parseJianshuSourceReference(raw), null, raw);
  }
});

test("RSS preserves provenance and public share ownership without executing source markup", () => {
  const result = parseSourceFeed(rss, "https://resource.example.org/feed", at);
  assert.equal(result.items.length, 2);
  const item = result.items[0];
  assert.equal(item.title, "英语 & 口语");
  assert.equal(item.sourceName, "资料更新");
  assert.equal(item.author, "原作者");
  assert.equal(item.publishedAt, "2026-11-23T00:00:00.000Z");
  assert.equal(item.collectedAt, at);
  assert.match(item.id, /^jsource_[a-f0-9]{32}$/);
  assert.ok(!item.body.includes("恶意脚本"));
  assert.deepEqual(item.externalShares, [
    { url: "https://pan.quark.cn/s/shareone12", code: "ABCD" },
  ]);
  assert.deepEqual(item.images, [
    { url: "https://resource.example.org/cover.jpg", alt: "资料封面" },
  ]);
  assert.ok(item.warnings.length > 0);
  assert.ok(!("copyId" in item));
});

test("Atom supports namespace, alternate links, author and escaped HTML", () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>技术周刊</title><entry><title>工具更新</title><id>urn:entry:1</id><link rel="self" href="https://example.org/api/1"/><link rel="alternate" href="/p/1"/><author><name>作者甲</name></author><updated>2026-11-22T12:00:00Z</updated><content type="html">&lt;p&gt;公开的工具介绍。&lt;/p&gt;</content></entry></feed>`;
  const result = parseSourceFeed(atom, "https://example.org/feed", at);
  assert.equal(result.items[0].url, "https://example.org/p/1");
  assert.equal(result.items[0].body, "公开的工具介绍。");
  assert.equal(result.items[0].author, "作者甲");
  assert.equal(result.items[0].publishedAt, "2026-11-22T12:00:00.000Z");
});

test("legacy Atom permalinks retain HTTP attribution without enabling HTTP requests", () => {
  // Minimal shape of ruanyifeng.com/blog/atom.xml: HTTP alternate links,
  // default Atom namespace, xml:base and multiple adjacent CDATA sections.
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <title>阮一峰的网络日志</title>
    <link rel="alternate" type="text/html" href="http://www.ruanyifeng.com/blog/" />
    <entry><title>公开订阅示例</title>
      <link rel="alternate" type="text/html" href="http://www.ruanyifeng.com/blog/2026/11/example.html" />
      <published>2026-11-20T00:07:30Z</published>
      <author><name>阮一峰</name><uri>http://www.ruanyifeng.com</uri></author>
      <content type="html" xml:base="http://www.ruanyifeng.com/blog/">
        <![CDATA[<p>第一段公开内容。</p>]]><![CDATA[<p>第二段公开内容。</p>]]>
      </content>
    </entry></feed>`;
  const item = parseSourceFeed(
    atom,
    "https://www.ruanyifeng.com/blog/atom.xml",
    at,
  ).items[0];
  assert.equal(item.url, "http://www.ruanyifeng.com/blog/2026/11/example.html");
  assert.equal(item.author, "阮一峰");
  assert.equal(item.body, "第一段公开内容。\n\n第二段公开内容。");
  assert.equal(item.publishedAt, "2026-11-20T00:07:30.000Z");
  assert.throws(() => sourceUrl(item.url), /HTTPS/);
  for (const unsafe of [
    "http://user:secret@example.org/post",
    "http://127.0.0.1/post",
    "http://localhost/post",
    "http://example.org:8080/post",
  ]) {
    assert.throws(
      () =>
        parseSourceFeed(
          atom.replace(item.url, unsafe),
          "https://example.org/feed",
          at,
        ),
      /订阅条目/,
    );
  }
});

test("RSS deduplicates canonical URLs and reports truncation without fetching entries", () => {
  const result = parseSourceFeed(
    rss,
    "https://resource.example.org/feed",
    at,
    1,
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, true);
  const repeated = rss.replace(
    "</channel>",
    rss.match(/<item>[\s\S]*?<\/item>/)![0] + "</channel>",
  );
  assert.equal(
    parseSourceFeed(repeated, "https://resource.example.org/feed", at).items
      .length,
    2,
  );
});

test("valid empty feeds differ from unsupported, broken and entity-bearing responses", () => {
  assert.deepEqual(
    parseSourceFeed(
      "<rss><channel><title>暂无更新</title></channel></rss>",
      "https://example.org/feed",
      at,
    ).items,
    [],
  );
  for (const invalid of [
    "<html><body>安全验证</body></html>",
    "<rss><channel><item></channel></rss>",
    "<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><rss><channel/></rss>",
    "<rss><channel><item><title>缺字段</title></item></channel></rss>",
  ])
    assert.throws(() =>
      parseSourceFeed(invalid, "https://example.org/feed", at),
    );
});

test("source body length is bounded and the extraction limit remains explicit", () => {
  const long = rss.replace(
    "课程目录和适用人群，公开介绍中的可核对说明。",
    "资".repeat(35000),
  );
  const item = parseSourceFeed(long, "https://resource.example.org/feed", at)
    .items[0];
  assert.equal(item.body.length, 30000);
  assert.ok(item.warnings.some((v) => v.includes("30000")));
});

test("public page extraction isolates article text and records image URLs only", () => {
  const html = `<html><head><meta property="og:title" content="实用字体介绍"><meta property="og:site_name" content="原作者网站"><meta name="author" content="作者乙"><meta property="article:published_time" content="2026-11-20T09:00:00Z"></head><body><nav>这是菜单和广告</nav><article><h1>实用字体介绍</h1><p>这是第一段介绍，包含可核对的字体名称与版本信息，说明用途和使用范围。</p><p>第二段说明如何在文档中选择合适的字重。</p><img src="./font.png" alt="字体示例"><script>alert(1)</script></article><footer>页脚广告</footer></body></html>`;
  const item = parseSourceWeb(html, "https://example.org/font/intro", at)
    .items[0];
  assert.equal(item.sourceName, "原作者网站");
  assert.equal(item.author, "作者乙");
  assert.ok(!/菜单|广告|alert/.test(item.body));
  assert.deepEqual(item.images, [
    { url: "https://example.org/font/font.png", alt: "字体示例" },
  ]);
});

test("verification pages and missing dynamic bodies are explicit failures", () => {
  assert.throws(
    () =>
      parseSourceWeb(
        "<title>安全验证</title><body>请先验证</body>",
        "https://example.org/a",
        at,
      ),
    /验证/,
  );
  assert.throws(
    () =>
      parseSourceWeb(
        '<title>资源介绍</title><div id="root"></div>',
        "https://example.org/a",
        at,
      ),
    /正文/,
  );
});

test("Telegram messages retain exact permalink, update timestamp and unverified source claims", () => {
  const html = `<meta property="og:title" content="资源频道 – Telegram"><div class="tgme_widget_message" data-post="ResourceChannel/123"><div class="tgme_widget_message_text js-message_text">名称：英语学习资料<br>描述：来源发布的课程目录<br><a href="https://pan.baidu.com/s/1abcde?pwd=Q123">百度网盘</a></div><time datetime="2026-11-22T11:20:00+00:00">11:20</time></div>`;
  const item = parseSourceTelegram(html, "https://t.me/s/ResourceChannel", at)
    .items[0];
  assert.equal(item.url, "https://t.me/ResourceChannel/123");
  assert.equal(item.title, "英语学习资料");
  assert.equal(item.publishedAt, "2026-11-22T11:20:00.000Z");
  assert.deepEqual(item.externalShares, [
    { url: "https://pan.baidu.com/s/1abcde", code: "Q123" },
  ]);
  assert.ok(item.warnings.some((warning) => warning.includes("不是本人分享")));
  assert.throws(
    () =>
      parseSourceTelegram(
        "<title>Telegram</title>",
        "https://t.me/s/ResourceChannel",
        at,
      ),
    /消息正文/,
  );
});

test("collector sends one bounded RSS request and respects preset/provider identity", async () => {
  const calls: string[] = [];
  const collector = new JianshuSourceCollector({
    lookup,
    transport: async (url, options) => {
      calls.push(url.href);
      assert.equal(options.method, "GET");
      assert.equal(options.addresses[0].address, "93.184.216.34");
      return { status: 200, body: rss, contentType: "application/rss+xml" };
    },
    now: () => at,
  });
  const result = await collector.collect({ presetId: "sspai", limit: 1 });
  assert.deepEqual(calls, ["https://sspai.com/feed"]);
  assert.equal(result.collectedAt, at);
  assert.equal(result.items.length, 1);
  await assert.rejects(
    () => collector.collect({ presetId: "sspai", provider: "web" }),
    /不一致/,
  );
  await assert.rejects(
    () => collector.collect({ presetId: "missing" }),
    /不存在/,
  );
});

test("metadata collectors use fixed public APIs and never label them as resource downloads", async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const transport: SourceTransport = async (url, options) => {
    calls.push({ url: url.href, method: options.method, body: options.body });
    return {
      status: 200,
      contentType: "application/json",
      body:
        url.hostname === "api.tvmaze.com"
          ? JSON.stringify([
              {
                show: {
                  id: 1,
                  name: "Example",
                  url: "https://www.tvmaze.com/shows/1/example",
                  language: "English",
                  premiered: "2025-01-01",
                  summary: "<p>A known synopsis.</p>",
                  genres: ["Drama"],
                },
              },
            ])
          : JSON.stringify({
              total: 1,
              data: [
                {
                  id: 8,
                  name: "原名",
                  name_cn: "作品名",
                  date: "2025-01-02",
                  summary: "已提供的条目介绍",
                  images: {},
                  infobox: [{ key: "别名", value: "作品别称" }],
                },
              ],
            }),
    };
  };
  const collector = new JianshuSourceCollector({
    lookup,
    transport,
    now: () => at,
  });
  const tv = await collector.collect({ provider: "tvmaze", query: "example" });
  assert.equal(calls[0].url, "https://api.tvmaze.com/search/shows?q=example");
  assert.equal(tv.items[0].sourceName, "TVmaze");
  assert.equal(tv.items[0].externalShares.length, 0);
  const bgm = await collector.collect({
    provider: "bangumi",
    query: "作品名",
    limit: 5,
  });
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body!), {
    keyword: "作品名",
    sort: "match",
    filter: { type: [2] },
  });
  assert.equal(bgm.items[0].url, "https://bgm.tv/subject/8");
  assert.ok(bgm.items[0].body.includes("别名：作品别称"));
  assert.ok(bgm.items[0].warnings.some((v) => v.includes("CC BY-SA")));
});

test("metadata unknown response is a failure, while a real empty result is empty", async () => {
  const empty = new JianshuSourceCollector({
    lookup,
    transport: async () => ({
      status: 200,
      contentType: "application/json",
      body: "[]",
    }),
  });
  assert.deepEqual(
    (await empty.collect({ provider: "tvmaze", query: "missing" })).items,
    [],
  );
  const broken = new JianshuSourceCollector({
    lookup,
    transport: async () => ({ status: 200, body: '{"items":[]}' }),
  });
  await assert.rejects(
    () => broken.collect({ provider: "tvmaze", query: "missing" }),
    /格式/,
  );
});

test("source URLs reject credentialed, numeric, private, non-HTTPS and nonstandard-port inputs", () => {
  for (const url of [
    "http://example.org/a",
    "https://user:password@example.org/a",
    "https://127.0.0.1/a",
    "https://2130706433/a",
    "https://[::1]/a",
    "https://localhost/a",
    "https://private.internal/a",
    "https://site.local/a",
    "https://example.org:444/a",
  ])
    assert.throws(() => sourceUrl(url), url);
  assert.equal(
    sourceUrl("https://example.org/a#section").href,
    "https://example.org/a",
  );
});

test("public address classification excludes mapped IPv4, expanded local and special ranges", () => {
  for (const address of [
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.20.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2001:0db8:0:0:0:0:0:1",
    "fc00::1",
    "fe80::1",
    "2002:7f00:1::",
  ])
    assert.equal(isPublicSourceAddress(address), false, address);
  for (const address of [
    "93.184.216.34",
    "8.8.8.8",
    "192.0.78.24",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    assert.equal(isPublicSourceAddress(address), true, address);
});

test("DNS, every redirect and final transport metadata are guarded before another request", async () => {
  let requests = 0;
  const blocked = new JianshuSourceNetwork({
    lookup: async () => [{ address: "10.0.0.2", family: 4 }],
    transport: async () => {
      requests++;
      return { status: 200, body: rss };
    },
  });
  await assert.rejects(() => blocked.read("https://example.org/feed"), /内网/);
  assert.equal(requests, 0);
  const redirect = new JianshuSourceNetwork({
    lookup: async (host) =>
      host === "bad.example.org"
        ? [{ address: "127.0.0.1", family: 4 }]
        : await lookup(),
    transport: async () => {
      requests++;
      return {
        status: 302,
        location: "https://bad.example.org/private",
        body: "redirect",
      };
    },
  });
  await assert.rejects(() => redirect.read("https://example.org/feed"), /内网/);
  assert.equal(requests, 1);
  const credential = new JianshuSourceNetwork({
    lookup,
    transport: async () => ({
      status: 302,
      location: "https://secret@other.example.org/a",
      body: "",
    }),
  });
  await assert.rejects(
    () => credential.read("https://example.org/feed"),
    /凭据/,
  );
});

test("redirect count, empty bodies, attachment formats, oversize and HTTP errors are explicit", async () => {
  for (const response of [
    { status: 302, body: "", location: "/again" },
    { status: 200, body: " " },
    { status: 200, body: "binary", contentType: "application/pdf" },
    { status: 200, body: "a".repeat(3_000_001) },
    { status: 429, body: "too many requests" },
  ]) {
    const network = new JianshuSourceNetwork({
      lookup,
      transport: async () => response,
    });
    await assert.rejects(() => network.read("https://example.org/source"));
  }
});

test("DNS and mock transport stalls obey the configured overall timeout", async () => {
  for (const phase of ["lookup", "transport"]) {
    const network = new JianshuSourceNetwork({
      timeoutMs: 15,
      lookup: phase === "lookup" ? async () => new Promise(() => {}) : lookup,
      transport: async () => new Promise(() => {}),
    });
    await Promise.all([
      assert.rejects(() => network.read("https://example.org/source"), /网络/),
      delay(30),
    ]);
  }
});

test("Telegram collector rejects arbitrary domains, individual messages and missing public path", async () => {
  let requests = 0;
  const collector = new JianshuSourceCollector({
    lookup,
    transport: async () => {
      requests++;
      return { status: 200, body: "" };
    },
  });
  for (const url of [
    "https://example.org/s/Channel",
    "https://t.me/Channel",
    "https://t.me/s/Channel/123",
  ])
    await assert.rejects(
      () => collector.collect({ provider: "telegram", url }),
      /频道地址/,
    );
  assert.equal(requests, 0);
});
