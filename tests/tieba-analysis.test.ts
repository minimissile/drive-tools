import assert from "node:assert/strict";
import test from "node:test";
import { createTiebaAnalysisHandlers } from "../core/ipc/tieba-analysis";
import {
  queryTiebaAnalysis,
  queryTiebaAnalysisFollowedForums,
  queryTiebaAnalysisForumPosts,
} from "../core/tieba/analysis";
import {
  encodeTiebaFields,
  tiebaFields,
} from "../core/tieba/analysis-protobuf";
import { forumPerformanceRows } from "../src/tieba/forum-performance";

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
      { name: "网盘资源", page: 2 },
      async (url, init) => {
        assert.equal(new URL(String(url)).pathname, "/c/f/frs/page");
        const request = await requestPayload(init);
        assert.equal(request.string(1), "网盘资源");
        assert.equal(request.integer(15), 2n);
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
              ]),
            ],
            [
              4,
              encode([
                [3, current],
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
