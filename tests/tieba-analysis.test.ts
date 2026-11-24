import assert from "node:assert/strict";
import test from "node:test";
import { createTiebaAnalysisHandlers } from "../core/ipc/tieba-analysis";
import {
  queryTiebaAnalysis,
  queryTiebaAnalysisFollowedForums,
  queryTiebaAnalysisForumPosts,
  queryTiebaAnalysisWithContext,
  queryTiebaAnalysisThread,
  readTiebaOldResource,
  readTiebaThreadSource,
} from "../core/tieba/analysis";
import {
  encodeTiebaFields,
  tiebaFields,
} from "../core/tieba/analysis-protobuf";
import { forumPerformanceRows } from "../src/tieba/forum-performance";
import { tiebaPostExposure } from "../shared/tieba-analysis";

const uid = "9007199254740999";
const tid = "9007199254740997";
const encode = encodeTiebaFields;
const response = (data: Buffer) =>
  new Response(Uint8Array.from(encode([[2, data]])));
async function requestPayload(init?: RequestInit) {
  const file = (init?.body as FormData).get("data") as File;
  return tiebaFields(
    tiebaFields(Buffer.from(await file.arrayBuffer())).bytes(1)!,
  );
}

test("老帖扫描接受贴吧标记仍有下一页的空页", async () => {
  const send = async () => response(encode([
    [2, encode([[1, 3n], [2, Buffer.from("热门")]])],
    [4, encode([[3, 34n], [6, 1n]])],
  ]));
  const page = await queryTiebaAnalysisForumPosts({ name: "热门", page: 34 }, send, "old");
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.threads, []);
  await assert.rejects(queryTiebaAnalysisForumPosts({ name: "热门", page: 34 }, send));
});

test("贴吧资源扫描在近期和历史两种模式都识别列表摘要里的网盘线索", async () => {
  const send = async () => response(encode([
    [2, encode([[1, 3n], [2, Buffer.from("测试贴吧")]])],
    [7, encode([[1, BigInt(tid)], [3, Buffer.from("标题无资源词")],
      [142, encode([[2, Buffer.from("提取码 abcd")]])],
    ])],
  ]));
  const input = { name: "测试贴吧", page: 1 };
  for (const mode of [true, "old"] as const) {
    const page = await queryTiebaAnalysisForumPosts(input, send, mode);
    assert.deepEqual(page.threads[0]?.oldResource?.keywords, ["资源", "提取码"]);
  }
  const manual = await queryTiebaAnalysisForumPosts(input, send);
  assert.equal(manual.threads[0]?.oldResource, undefined);
});

test("老帖资源检查从正文、回复和楼中楼区分链接与关键词", async () => {
  const text = (value: string) => encode([[2, Buffer.from(value)]]);
  const link = (value: string) => encode([[3, Buffer.from(value)]]);
  const result = await readTiebaOldResource(tid, async (_, init) => {
    const request = await requestPayload(init);
    assert.equal(request.integer(13), 21n);
    assert.equal(request.integer(6), 1n);
    assert.equal(request.integer(8), 1n);
    return response(encode([
      [8, encode([[1, BigInt(tid)], [3, Buffer.from("求资源链接")]])],
      [6, encode([[3, 1n], [5, text("百度 网盘")], [5, link("https://pan.baidu.com/s/1demo")]])],
      [6, encode([
        [3, 2n],
        [4, 1n],
        [5, link("https://example.org/s/unrelated")],
        [15, encode([[2, encode([[2, text("夸克")], [2, link("https://pan.quark.cn/s/demo")], [3, 30n]])]])],
      ])],
      ...Array.from({ length: 19 }, (_, index) => [6, encode([
        [3, BigInt(index + 3)], [4, BigInt(index + 2)], [5, text("谢谢分享")],
      ])] as const),
      [6, encode([[3, 30n], [4, 1n], [5, text("提取码")]])],
      [37, 12n],
    ]));
  });
  assert.deepEqual(result, {
    linkSources: ["正文", "回复"],
    keywords: ["网盘", "资源", "链接", "百度", "夸克"],
  });
});

test("用户查询用公开资料和吧内公开帖子补充吧龄、VIP、吧内等级及贴吧曝光潜力", async () => {
  const when = BigInt(Math.floor(Date.now() / 1000) - 3600);
  const name = Buffer.from("网盘资源");
  const fid = 201n;
  const result = await queryTiebaAnalysisWithContext(
    { target: `UID: ${uid}`, page: 1 },
    async (url) => {
      switch (new URL(String(url)).pathname) {
        case "/c/u/feed/userpost":
          return response(
            encode([
              [
                1,
                encode([
                  [1, fid],
                  [2, BigInt(tid)],
                  [5, when],
                  [6, name],
                  [18, BigInt(uid)],
                  [33, 100n],
                ]),
              ],
            ]),
          );
        case "/c/u/user/profile":
          return response(
            encode([
              [
                1,
                encode([
                  [2, BigInt(uid)],
                  [38, Buffer.from("2.8")],
                  [39, 1n],
                  [45, encode([[2, 3n]])],
                ]),
              ],
            ]),
          );
        case "/c/f/frs/page":
          return response(
            encode([
              [
                2,
                encode([
                  [1, fid],
                  [2, name],
                ]),
              ],
              ...[100, 5, 10, 15].map(
                (views, i) =>
                  [
                    7,
                    encode([
                      [1, BigInt(tid) + BigInt(i)],
                      [5, BigInt(views)],
                      [45, when],
                      [56, BigInt(uid)],
                    ]),
                  ] as const,
              ),
              [
                17,
                encode([
                  [2, BigInt(uid)],
                  [23, 7n],
                ]),
              ],
            ]),
          );
        default:
          assert.fail("用户隐藏关注列表时无需调用关注接口");
      }
    },
  );
  assert.equal(result.ageYears, 2.8);
  assert.equal(result.vip, true);
  assert.equal(result.threads[0].forumLevel, 7);
  assert.equal(result.forums?.[0].exposure?.sample, 4);
  assert(Math.abs((result.forums?.[0].exposure?.hourly ?? 0) - 12.5) < 0.01);
});

test("单帖曝光潜力可计算历史帖子，保留零值并识别缺失或异常时间", () => {
  const at = Date.parse("2026-11-12T03:00:00Z");
  assert.equal(tiebaPostExposure(720, "2026-10-13T03:00:00Z", at), 1);
  assert.equal(tiebaPostExposure(10, "2026-11-12T02:45:00Z", at), 20);
  assert.equal(tiebaPostExposure(0, "2026-10-13T03:00:00Z", at), 0);
  assert.equal(tiebaPostExposure(null, "2026-10-13T03:00:00Z", at), null);
  assert.equal(tiebaPostExposure(30, null, at), null);
  assert.equal(tiebaPostExposure(30, "2026-11-12T03:01:00Z", at), null);
});

test("公开主题链接解析楼主，保留长 ID 和浏览量字段是否存在", async () => {
  const calls: string[] = [];
  const result = await queryTiebaAnalysis(
    { target: `https://tieba.baidu.com/p/${tid}?fr=share`, page: 1 },
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      assert.equal(init?.credentials, "omit");
      assert.equal(new Headers(init?.headers).has("cookie"), false);
      const payload = await requestPayload(init);
      if (path === "/c/f/pb/page") {
        assert.equal(payload.integer(4), BigInt(tid));
        return response(
          encode([
            [
              8,
              encode([
                [1, BigInt(tid)],
                [56, BigInt(uid)],
              ]),
            ],
          ]),
        );
      }
      assert.equal(payload.integer(1), BigInt(uid));
      assert.equal(payload.integer(4), 1n);
      const post = (id: bigint, views?: bigint, shares?: bigint) =>
        encode([
          [2, id],
          [6, Buffer.from("资料")],
          [7, Buffer.from("公开帖子")],
          [18, BigInt(uid)],
          [35, Buffer.from("作者")],
          ...(views === undefined ? [] : [[33, views] as const]),
          ...(shares === undefined ? [] : [[39, shares] as const]),
        ]);
      return response(
        encode([
          [1, post(BigInt(tid), 0n, 1n)],
          [1, post(BigInt(tid) + 1n)],
        ]),
      );
    },
  );
  assert.deepEqual(calls, ["/c/f/pb/page", "/c/u/feed/userpost"]);
  assert.equal(result.uid, uid);
  assert.equal(result.author, "作者");
  assert.deepEqual(
    result.threads.map((thread) => thread.shares),
    [1, null],
  );
  assert.deepEqual(
    result.threads.map((thread) => [thread.id, thread.views]),
    [
      [tid, 0],
      [(BigInt(tid) + 1n).toString(), null],
    ],
  );
});

test("按贴吧查询使用实际页号，保留明确的零值和未返回的指标", async () => {
  const query = (name: string, current: bigint) =>
    queryTiebaAnalysisForumPosts(
      { name: "网盘资源", page: 2, list: "replied", pageSize: 10 },
      async (url, init) => {
        assert.equal(new URL(String(url)).pathname, "/c/f/frs/page");
        const request = await requestPayload(init);
        assert.equal(request.string(1), "网盘资源");
        assert.equal(request.integer(15), 2n);
        assert.equal(request.integer(2), 10n);
        assert.equal(request.integer(47), 6n);
        const post = (id: bigint, metrics: boolean) =>
          encode([
            [1, id],
            [3, Buffer.from("公开主题帖")],
            [56, BigInt(uid)],
            ...(metrics ? [[5, 0n] as const, [135, 0n] as const] : []),
          ]);
        return response(
          encode([
            [
              2,
              encode([
                [1, 1114324n],
                [2, Buffer.from(name)],
                [9, 70870n],
                [11, 2128159n],
              ]),
            ],
            [
              4,
              encode([
                [3, current],
                [5, 500n],
                [6, 1n],
              ]),
            ],
            [7, post(BigInt(tid), true)],
            [7, post(BigInt(tid) + 1n, false)],
            [
              17,
              encode([
                [2, BigInt(uid)],
                [4, Buffer.from("作者")],
              ]),
            ],
          ]),
        );
      },
    );
  const page = await query("网盘资源", 2n);
  assert.equal(page.hasMore, true);
  assert.equal(page.page, 2);
  assert.equal(page.totalPages, 500);
  assert.equal(page.followers, 70870);
  assert.equal(page.posts, 2128159);
  assert.equal(page.threads[0]?.author, "作者");
  assert.deepEqual(
    page.threads.map(({ views, shares }) => [views, shares]),
    [
      [0, 0],
      [null, null],
    ],
  );
  await assert.rejects(query("另一个吧", 2n), { code: "TIEBA_ANALYSIS_FORUM" });
  await assert.rejects(query("网盘资源", 1n), {
    code: "TIEBA_ANALYSIS_RESPONSE",
  });
});

test("按 UID 请求下一页，空页和其他用户的响应有不同结果", async () => {
  const query = (data: Buffer) =>
    queryTiebaAnalysis(
      { target: `UID: ${uid}`, page: 2 },
      async (url, init) => {
        assert.equal(new URL(String(url)).pathname, "/c/u/feed/userpost");
        const request = await requestPayload(init);
        assert.equal(request.integer(1), BigInt(uid));
        assert.equal(request.integer(26), 2n);
        return response(data);
      },
    );
  assert.deepEqual((await query(Buffer.alloc(0))).threads, []);
  await assert.rejects(
    query(
      encode([
        [
          1,
          encode([
            [2, BigInt(tid)],
            [18, 111n],
            [33, 420n],
          ]),
        ],
      ]),
    ),
    { code: "TIEBA_ANALYSIS_RESPONSE" },
  );
});

test("主页 ID 转为帖主 UID 后查询，避免两个 ID 空间撞号", async () => {
  const profileId = "5836921749";
  const userId = 6592268748n;
  const result = await queryTiebaAnalysis(
    { target: profileId, page: 1 },
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      const request = await requestPayload(init);
      if (path === "/c/u/user/getUserByTiebaUid") {
        assert.equal(request.string(2), profileId);
        return response(
          encode([
            [
              1,
              encode([
                [2, userId],
                [4, Buffer.from("公开作者")],
                [120, Buffer.from(profileId)],
              ]),
            ],
          ]),
        );
      }
      assert.equal(path, "/c/u/feed/userpost");
      assert.equal(request.integer(1), userId);
      return response(
        encode([
          [
            1,
            encode([
              [2, 10833776449n],
              [18, userId],
              [33, 4194n],
            ]),
          ],
        ]),
      );
    },
  );
  assert.equal(result.uid, userId.toString());
  assert.equal(result.profileId, profileId);
  assert.equal(result.author, "公开作者");
  assert.equal(result.threads[0]?.views, 4194);
});

test("没有主页映射时兼容原 UID，主页核对失败时不读取其他账号", async () => {
  const query = (profile: () => Response) =>
    queryTiebaAnalysis({ target: uid, page: 1 }, async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/c/u/user/getUserByTiebaUid") return profile();
      assert.equal(path, "/c/u/feed/userpost");
      assert.equal((await requestPayload(init)).integer(1), BigInt(uid));
      return response(Buffer.alloc(0));
    });
  assert.equal((await query(() => response(Buffer.alloc(0)))).uid, uid);
  await assert.rejects(
    query(() =>
      response(
        encode([
          [
            1,
            encode([
              [2, 6592268748n],
              [120, Buffer.from("5836921749")],
            ]),
          ],
        ]),
      ),
    ),
    { code: "TIEBA_ANALYSIS_RESPONSE" },
  );
});

test("IPC 拒绝无效页码和外站帖子链接，不访问网络", async () => {
  const handlers = createTiebaAnalysisHandlers((input) =>
    queryTiebaAnalysis(input, async () => {
      assert.fail("invalid input must not trigger network I/O");
    }),
  );
  assert.throws(() =>
    handlers["tieba.analysis.query"]({ target: uid, page: 0 }),
  );
  await assert.rejects(
    handlers["tieba.analysis.query"]({
      target: `https://example.com/p/${tid}`,
      page: 1,
    }),
    { code: "TIEBA_ANALYSIS_TARGET" },
  );
});

test("单帖查询接受长数字 ID 和帖子链接，读取楼主正文和互动数据", async () => {
  const published = 1794124800n;
  let requests = 0;
  const handlers = createTiebaAnalysisHandlers(undefined, (input) => queryTiebaAnalysisThread(input, async (url, init) => {
    requests++;
    assert.equal(new URL(String(url)).pathname, "/c/f/pb/page");
    assert.equal((await requestPayload(init)).integer(4), BigInt(tid));
    return response(encode([
      [2, encode([[2, Buffer.from("网盘资源")]])],
      [8, encode([
        [1, BigInt(tid)], [3, Buffer.from("单帖查询样本")], [4, 0n],
        [18, encode([[2, BigInt(uid)], [4, Buffer.from("楼主")]])],
        [126, encode([[1, 12n]])],
      ])],
      [6, encode([[3, 1n], [4, published], [5, encode([[2, Buffer.from("首楼正文")]])]])],
      [6, encode([[3, 2n], [5, encode([[2, Buffer.from("第二楼回复")]])]])],
      [37, 321n],
    ]));
  }));
  for (const target of [tid, `https://tieba.baidu.com/p/${tid}?pid=42#42`]) {
    const { observedAt, ...post } = await handlers["tieba.analysis.thread"]({ target });
    assert.ok(Number.isFinite(observedAt));
    assert.deepEqual(post, {
      id: tid, url: `https://tieba.baidu.com/p/${tid}`, title: "单帖查询样本",
      author: "楼主", authorId: uid, forum: "网盘资源", bodyText: "首楼正文",
      publishedAt: new Date(Number(published) * 1000).toISOString(),
      views: 321, replies: 0, likes: 12, shares: null,
    });
  }
  for (const target of ["9223372036854775808", `https://example.org/p/${tid}`, "https://tieba.baidu.com/f?kw=foo"]) {
    await assert.rejects(handlers["tieba.analysis.thread"]({ target }), { code: "TIEBA_ANALYSIS_THREAD_TARGET" });
  }
  assert.equal(requests, 2);
});

test("贴吧采集保留楼主正文段落、原帖外链和图片引用，排除回复", async () => {
  const share = "https://www.123pan.com/s/sample-example";
  const firstImage = "https://tiebapic.baidu.com/forum/pic/item/one.jpg";
  const secondImage = "https://tiebapic.baidu.com/forum/pic/item/two.jpg";
  const postedAt = 1719133245n;
  const result = await readTiebaThreadSource(tid, async (url, init) => {
    assert.equal(new URL(String(url)).origin, "https://tiebac.baidu.com");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal((await requestPayload(init)).integer(4), BigInt(tid));
    return response(encode([
      [2, encode([[2, Buffer.from("系统教程")]])],
      [8, encode([
        [1, BigInt(tid)],
        [3, Buffer.from("打印机设置")],
        [18, encode([[4, Buffer.from("教程作者")]])],
      ])],
      [6, encode([[3, 2n], [5, encode([[2, Buffer.from("回复不能进入素材")]])]])],
      [6, encode([
        [3, 1n],
        [4, postedAt],
        [5, encode([[2, Buffer.from("先打开设置。\n\n资料见 ")]])],
        [5, encode([[1, 1n], [2, Buffer.from("下载说明")], [3, Buffer.from(share)]])],
        [5, encode([[2, Buffer.from("，然后选择打印机。\n\n")]])],
        [5, encode([[1, 3n], [2, Buffer.from("图片字段不是正文")], [25, Buffer.from(firstImage)]])],
        [5, encode([[1, 3n], [9, Buffer.from(secondImage)], [25, Buffer.from("invalid URL")]])],
        [5, encode([[1, 3n], [25, Buffer.from(firstImage)]])],
        [5, encode([[2, Buffer.from("最后确认设置。")]])],
      ])],
    ]));
  });
  assert.deepEqual(result, {
    id: tid,
    url: `https://tieba.baidu.com/p/${tid}`,
    title: "打印机设置",
    forum: "系统教程",
    author: "教程作者",
    publishedAt: new Date(Number(postedAt) * 1000).toISOString(),
    firstFloor: {
      text: "先打开设置。\n\n资料见 下载说明，然后选择打印机。\n\n最后确认设置。",
      hrefs: [share],
      images: [firstImage, secondImage],
      truncated: false,
    },
  });
});

test("贴吧采集区分楼主首楼缺失和可识别正文截断", async () => {
  const thread = encode([[1, BigInt(tid)]]);
  const read = async (floor: bigint, body: string) =>
    readTiebaThreadSource(tid, async () => response(encode([
      [8, thread],
      [6, encode([[3, floor], [5, encode([[2, Buffer.from(body)]])]])],
    ])));
  assert.equal((await read(2n, "此处只有回复")).firstFloor, null);
  const { firstFloor } = await read(1n, "字".repeat(30_001));
  assert.equal(firstFloor?.text.length, 30_000);
  assert.equal(firstFloor?.truncated, true);
});

test("切换有序采集时保留段内外链、图片位置和重复引用", async () => {
  const share = "https://pan.baidu.com/s/example";
  const image = "https://tiebapic.baidu.com/forum/pic/item/example.jpg";
  const send: typeof fetch = async () =>
    response(
      encode([
        [8, encode([[1, BigInt(tid)]])],
        [
          6,
          encode([
            [3, 1n],
            [5, encode([[2, Buffer.from("  段落开头。\n\n")]])],
            [
              5,
              encode([
                [1, 3n],
                [25, Buffer.from("invalid")],
                [9, Buffer.from(image)],
                [8, Buffer.from("https://tiebapic.baidu.com/preview.jpg")],
              ]),
            ],
            [5, encode([[2, Buffer.from("见 ")]])],
            [
              5,
              encode([
                [1, 1n],
                [2, Buffer.from(" 文件 ")],
                [3, Buffer.from(share)],
              ]),
            ],
            [5, encode([[2, Buffer.from(" 说明。\n")]])],
            [5, encode([[1, 3n], [25, Buffer.from(image)]])],
            [5, encode([[1, 3n], [25, Buffer.from("blob:unavailable")]])],
            [5, encode([[1, 2n], [2, Buffer.from("其他类型忽略")]])],
            [5, encode([[2, Buffer.from("结尾。  ")]])],
          ]),
        ],
      ]),
    );

  const plain = await readTiebaThreadSource(tid, send);
  assert.deepEqual(plain.firstFloor, {
    text: "段落开头。\n\n见  文件  说明。\n结尾。",
    hrefs: [share],
    images: [image],
    truncated: false,
  });
  const ordered = await readTiebaThreadSource(tid, send, true);
  assert.deepEqual(ordered.firstFloor, {
    ...plain.firstFloor,
    parts: [
      { kind: "text", text: "  段落开头。\n\n" },
      { kind: "image", url: image },
      { kind: "text", text: "见 " },
      { kind: "text", text: " 文件 ", href: share },
      { kind: "text", text: " 说明。\n" },
      { kind: "image", url: image },
      { kind: "image", url: "" },
      { kind: "text", text: "结尾。  " },
    ],
  });
});

test("关注贴吧仅在公开时分页读取，并生成官方跳转链接", async () => {
  const calls: string[] = [];
  const load = (privacy: bigint) =>
    queryTiebaAnalysisFollowedForums({ uid, page: 2 }, async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      assert.equal(init?.credentials, "omit");
      if (url.pathname === "/c/u/user/profile")
        return response(
          encode([
            [
              1,
              encode([
                [2, BigInt(uid)],
                [5, Buffer.from("tb.1.ab123456.abcdefghijklmnopqrstuv?t=123")],
                [45, encode([[2, privacy]])],
              ]),
            ],
          ]),
        );
      assert.equal(url.origin, "https://tieba.baidu.com");
      assert.equal(url.searchParams.get("pn"), "2");
      assert.equal(
        url.searchParams.get("portrait"),
        "tb.1.ab123456.abcdefghijklmnopqrstuv",
      );
      return Response.json({
        error_code: 0,
        data: {
          like: [{ forum_id: 10, forum_name: "资料&盘", level_id: 3 }],
          has_more: 0,
        },
      });
    });
  assert.deepEqual(await load(3n), { visibility: "restricted" });
  assert.deepEqual(calls, ["/c/u/user/profile"]);
  const result = await load(1n);
  assert.equal(result.visibility, "public");
  assert.equal(result.hasMore, false);
  assert.equal(result.forums[0]?.level, 3);
  const destination = new URL(result.forums[0]!.url);
  assert.equal(
    destination.origin + destination.pathname,
    "https://tieba.baidu.com/f",
  );
  assert.equal(destination.searchParams.get("kw"), "资料&盘");
});

test("个人主页链接解析同一头像标识后，按用户 UID 读取公开帖子", async () => {
  const portrait = "tb.1.ab123456.abcdefghijklmnopqrstuv";
  const input = {
    target: `https://tieba.baidu.com/home/main?id=${portrait}%3Ft%3D123&fr=frs`,
    page: 1,
  };
  const query = (returnedPortrait: string) =>
    queryTiebaAnalysis(input, async (url, init) => {
      const request = await requestPayload(init);
      if (new URL(String(url)).pathname === "/c/u/user/profile") {
        assert.equal(request.string(16), portrait);
        return response(
          encode([
            [
              1,
              encode([
                [2, BigInt(uid)],
                [4, Buffer.from("主页作者")],
                [5, Buffer.from(returnedPortrait)],
              ]),
            ],
          ]),
        );
      }
      assert.equal(request.integer(1), BigInt(uid));
      return response(
        encode([
          [
            1,
            encode([
              [1, 123n],
              [2, BigInt(tid)],
              [6, Buffer.from("资料")],
              [18, BigInt(uid)],
              [33, 12n],
            ]),
          ],
        ]),
      );
    });
  const result = await query(portrait + "?t=456");
  assert.equal(result.author, "主页作者");
  assert.equal(result.uid, uid);
  assert.equal(result.threads[0]?.forumId, "123");
  await assert.rejects(query("tb.1.ab123456.zyxwvutsrqponmlkjihgfe"), {
    code: "TIEBA_ANALYSIS_AUTHOR",
  });
  await assert.rejects(
    queryTiebaAnalysis(
      { ...input, target: input.target + "&id=" + portrait },
      async () => {
        assert.fail("ambiguous profile URL must not access the network");
      },
    ),
    { code: "TIEBA_ANALYSIS_TARGET" },
  );
});

test("按吧汇总发帖数和已知浏览量，篇均包含真实零值，未知始终排在最后", () => {
  const threads = [
    { forumId: "12", forum: "资料&盘", views: 10 },
    { forumId: "12", forum: "资料&盘", views: 0 },
    { forumId: "12", forum: "资料&盘", views: null },
    { forumId: "13", forum: "摄影", views: 8 },
    { forumId: "14", forum: "旅行", views: null },
  ];
  const rows = forumPerformanceRows(threads, {
    metric: "views",
    direction: "desc",
  });
  assert.deepEqual(
    rows.map(({ posts, measured, views, average }) => [
      posts,
      measured,
      views,
      average,
    ]),
    [
      [3, 2, 10, 5],
      [1, 1, 8, 8],
      [1, 0, null, null],
    ],
  );
  assert.equal(new URL(rows[0].url!).searchParams.get("kw"), "资料&盘");
  assert.deepEqual(
    forumPerformanceRows(threads, { metric: "average", direction: "asc" }).map(
      (row) => row.key,
    ),
    ["id:12", "id:13", "id:14"],
  );
});
