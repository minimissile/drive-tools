import test from "node:test";
import assert from "node:assert/strict";
import {
  TikHubPipixDiscovery,
  parsePipixDiscovery,
} from "../core/pipix/discovery";
import { pipixDiscoverInput, pipixDiscoveryKeyInput } from "../shared/pipix";
import { PipixSources } from "../core/pipix/service";
import { fixture } from "./helpers";
import { pipixItemId } from "./pipix-fixture";
import { PipixClient } from "../core/pipix/client";
import { pipixImage } from "./pipix-fixture";
import { join } from "node:path";
import { Database } from "../core/database";
import { inspectBackup, stageRestore } from "../core/backups";
import { PipixKnowledge } from "../core/pipix/knowledge";

// Synthetic service envelope around the observed public Pipix item shape.
// TikHub's public example has data=null; actual service data awaits key-based integration.
const data = (extra: Record<string, unknown> = {}) => ({
  code: 200,
  data: {
    cell_list: [
      {
        item: {
          item_id_str: pipixItemId,
          item_id: Number(pipixItemId),
          content: "模拟列表：生活趣事",
          note: { multi_image: [{}] },
          author: { name: "模拟作者" },
        },
      },
    ],
    offset: "20",
    loadmore_cursor: "30",
    has_more: true,
    ...extra,
  },
});
const signal = () => AbortSignal.timeout(5000);

test("单页容量探测实际发送20和1000参数，响应归档后重复测试不再请求", async () => {
  const f = await fixture();
  const requests: URL[] = [];
  const service = serviceFor(
    f,
    new TikHubPipixDiscovery((async (address: string) => {
      const url = new URL(address);
      requests.push(url);
      return Response.json({
        ...data(),
        params: Object.fromEntries(url.searchParams),
      });
    }) as typeof fetch),
  );
  try {
    await service.saveDiscoveryKey({ value: "qa-token" });
    const report = await service.probeCapacity("容量测试");
    assert.equal(report.results.length, 3);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].searchParams.get("count"), "20");
    assert.equal(requests[1].searchParams.get("count"), "1000");
    assert.equal(requests[2].searchParams.get("page_size"), "1000");
    assert.equal(report.maxObserved, 1);
    assert.equal(
      report.results.every((r) => r.reflected && !r.cached),
      true,
    );
    assert.equal(service.knowledge({ mode: "local" }).responses, 3);
    const repeated = await service.probeCapacity("容量测试");
    assert.equal(requests.length, 3);
    assert.equal(
      repeated.results.every((r) => r.cached),
      true,
    );
  } finally {
    service.close();
    await f.cleanup();
  }
});

test("内容知识库和完整响应随备份恢复，Key 不随备份，离线仍可检索并恢复分页", async () => {
  const f = await fixture();
  const service = serviceFor(
    f,
    new TikHubPipixDiscovery((async () =>
      Response.json(data())) as typeof fetch),
  );
  let restored: Database | undefined;
  try {
    await service.saveDiscoveryKey({ value: "qa-backup-secret" });
    await service.discover({ mode: "search", keyword: "生活" });
    f.ports.chooseDirectory = async () => f.dir;
    const backup = (await f.app.backup())!;
    const preview = await inspectBackup(backup);
    const staged = await stageRestore(backup, f.dir, preview.databaseSha256);
    restored = new Database(join(staged.dataPath, "panxu.db"));
    assert.equal(
      restored.get<{ n: number }>("SELECT COUNT(*) n FROM secrets")!.n,
      0,
    );
    assert.equal(
      restored.get<{ n: number }>(
        "SELECT COUNT(*) n FROM content_source_responses WHERE response IS NOT NULL",
      )!.n,
      1,
    );
    const local = new PipixKnowledge(restored).read({
      mode: "search",
      keyword: "生活",
    });
    assert.equal(local.total, 1);
    assert.deepEqual(local.next, { cursor: "20", page: 1 });
  } finally {
    restored?.close();
    service.close();
    await f.cleanup();
  }
});
function serviceFor(
  f: Awaited<ReturnType<typeof fixture>>,
  api: TikHubPipixDiscovery,
  client?: PipixClient,
) {
  return new PipixSources(
    {
      db: f.app.db,
      dataPath: f.dir,
      ports: f.ports,
      secrets: f.app.secrets,
      changed() {},
      destinations: {
        zhihu: (material) => f.app.zhihu.saveSource(material),
        weibo: (material, accountId) =>
          f.app.weiboPosts.saveSource(material, accountId),
      },
    },
    client,
    api,
  );
}

test("Key 支持服务商完整字符及 Bearer 前缀，统一设置保存不发远端请求", async () => {
  const value = "key+with/slash=and~colon:accepted";
  assert.equal(
    pipixDiscoveryKeyInput.parse({ value: "  Bearer " + value + "  " }).value,
    value,
  );
  assert.equal(
    pipixDiscoveryKeyInput.parse({ value: "Authorization: Bearer " + value })
      .value,
    value,
  );
  assert.throws(
    () => pipixDiscoveryKeyInput.parse({ value: "key\r\nheader" }),
    /换行/,
  );
  const f = await fixture();
  try {
    await f.app.invoke("secret.save", {
      kind: "pipix:tikhub",
      value: "Bearer " + value,
    });
    assert.equal(await f.app.secrets.get("pipix:tikhub"), value);
    assert.equal(f.app.pipix.discoveryConfig().configured, true);
    assert.equal(
      f.app.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM content_source_responses",
      )!.n,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("单页250条全部归档与入库，正文不裁至500字，界面分页不限制入库；无Key也可复用缓存和重启进度", async () => {
  const f = await fixture();
  let calls = 0;
  const body = "正文".repeat(1000),
    token = "qa-whole-page-key";
  const api = new TikHubPipixDiscovery((async (url: string) => {
    calls++;
    const more = new URL(url).searchParams.get("offset") === "20";
    return Response.json({
      code: 200,
      api_key: token,
      data: {
        data: {
          data: Array.from({ length: more ? 2 : 250 }, (_, n) => ({
            item: {
              item_id_str: String(7595847114874165000n + BigInt(n)),
              content: body,
              note: { multi_image: [] },
              author: { name: "模拟作者" },
            },
          })),
          has_more: !more,
          offset: more ? "0" : "20",
        },
      },
    });
  }) as typeof fetch);
  let service = serviceFor(f, api);
  try {
    await service.saveDiscoveryKey({ value: token });
    const first = await service.discover({
      mode: "search",
      keyword: "完整内容",
    });
    assert.equal(first.items.length, 250);
    assert.equal(first.items[0].text.length, body.length);
    assert.equal(calls, 1);
    const stored = f.app.db.get<{ response: string }>(
      "SELECT response FROM content_source_responses",
    )!.response;
    assert.ok(!stored.includes(token));
    assert.equal(JSON.parse(stored).data.data.data.length, 250);
    const local = service.knowledge({ mode: "search", keyword: "完整内容" });
    assert.equal(local.total, 250);
    assert.equal(local.items.length, 6);
    assert.deepEqual(local.next, { cursor: "20", page: 1 });
    f.app.secrets.remove("pipix:tikhub");
    service.close();
    service = serviceFor(f, api);
    assert.equal(
      (await service.discover({ mode: "search", keyword: "完整内容" })).cached,
      true,
    );
    assert.equal(calls, 1);
    assert.equal(
      service.knowledge({ mode: "local", keyword: "模拟作者", page: 20 }).items
        .length,
      6,
    );
    await service.saveDiscoveryKey({ value: token });
    await service.discover({
      mode: "search",
      keyword: "完整内容",
      cursor: "20",
      page: 1,
    });
    assert.equal(calls, 2);
    assert.equal(service.knowledge({ mode: "local" }).total, 250);
    assert.equal(
      service.knowledge({ mode: "search", keyword: "完整内容" }).next,
      null,
    );
  } finally {
    service.close();
    await f.cleanup();
  }
});

test("解析失败先归档，重复读取不重复计费，修复已存响应可本地重建；请求最新页保留历史", async () => {
  const f = await fixture();
  let calls = 0;
  const service = serviceFor(
    f,
    new TikHubPipixDiscovery((async () => {
      calls++;
      return Response.json({ code: 200, data: { changed: true } });
    }) as typeof fetch),
  );
  try {
    await service.saveDiscoveryKey({ value: "qa-token" });
    await assert.rejects(service.discover({ mode: "home" }), /请求记录已保存/);
    assert.equal(service.knowledge({ mode: "local" }).unparsed, 1);
    await assert.rejects(service.discover({ mode: "home" }), /结构无法识别/);
    assert.equal(calls, 1);
    assert.deepEqual(service.reindex(), { indexed: 0, failed: 1 });
    assert.equal(calls, 1);
    // Simulate an offline response repair, without sending another HTTP request.
    f.app.db.run(
      "UPDATE content_source_responses SET response=?",
      JSON.stringify(data()),
    );
    assert.deepEqual(service.reindex(), { indexed: 1, failed: 0 });
    assert.equal(calls, 1);
    assert.equal(service.knowledge({ mode: "local" }).total, 1);
    await assert.rejects(
      service.discover({ mode: "home", force: true }),
      /请求记录已保存/,
    );
    assert.equal(calls, 2);
    assert.equal(service.knowledge({ mode: "local" }).responses, 2);
  } finally {
    service.close();
    await f.cleanup();
  }
});

test("列表完整图文优先用于素材采集，不重新读取分享页；原始图片信息及评论保留", async () => {
  const f = await fixture();
  const urls: string[] = [];
  const item = {
    item_id_str: pipixItemId,
    content: "已入库正文",
    note: {
      multi_image: [
        { url_list: [{ url: "https://p9-ppx-sign.byteimg.com/cached.png" }] },
      ],
    },
    comments: [
      {
        text: "已入库评论",
        user: { name: "模拟评论者" },
        tag_info: { content: "神评" },
      },
    ],
  };
  const service = serviceFor(
    f,
    new TikHubPipixDiscovery((async () =>
      Response.json({
        code: 200,
        data: { cell_list: [{ item }], has_more: false },
      })) as typeof fetch),
    new PipixClient((async (url: string) => {
      urls.push(url);
      return new Response(pipixImage);
    }) as typeof fetch),
  );
  try {
    await service.saveDiscoveryKey({ value: "qa-token" });
    await service.discover({ mode: "home" });
    const source = await service.collect(
      "https://h5.pipix.com/ppx/item/" + pipixItemId,
    );
    assert.equal(urls.length, 1);
    assert.match(urls[0], /byteimg/);
    assert.equal(source.comments[0].label, "神评");
    assert.equal(source.comments[0].text, "已入库评论");
    assert.ok(source.images[0].asset);
  } finally {
    service.close();
    await f.cleanup();
  }
});

test("列表保留精确 ID、去重，未知结构不能变成空态，游标停滞停止翻页", () => {
  const input = pipixDiscoverInput.parse({ mode: "search", keyword: "趣事" });
  const page = parsePipixDiscovery(data(), input);
  assert.equal(page.items[0].id, pipixItemId);
  assert.equal(page.items[0].kind, "images");
  assert.equal(
    page.items[0].url,
    `https://h5.pipix.com/ppx/item/${pipixItemId}`,
  );
  assert.equal(page.nextCursor, "20");
  const highlighted = data();
  highlighted.data.cell_list[0].item.content = "<em>生活</em>趣事";
  assert.equal(
    parsePipixDiscovery(highlighted, input).items[0].text,
    "生活趣事",
  );
  assert.equal(
    parsePipixDiscovery(data(), { ...input, cursor: "20" }).nextCursor,
    null,
  );
  assert.equal(
    parsePipixDiscovery(data({ has_more: false }), input).nextCursor,
    null,
  );
  assert.equal(
    parsePipixDiscovery(data({ offset: Number("7595847114874165558") }), input)
      .nextCursor,
    null,
  );
  const empty = parsePipixDiscovery(
    data({ cell_list: [], has_more: false }),
    input,
  );
  assert.deepEqual(empty.items, []);
  assert.throws(
    () => parsePipixDiscovery({ code: 200, data: null }, input),
    /结构无法识别/,
  );
  assert.throws(
    () =>
      parsePipixDiscovery(
        data({ cell_list: [{ item_id: Number(pipixItemId) }] }),
        input,
      ),
    /结构无法识别/,
  );
  assert.throws(
    () => parsePipixDiscovery(data({ status_code: 1 }), input),
    /上游未返回成功/,
  );
  const duplicate = data();
  duplicate.data.cell_list.push(...duplicate.data.cell_list);
  assert.equal(parsePipixDiscovery(duplicate, input).items.length, 1);
});

test("有文档的四类列表每次只请求一页，Key 仅放请求头，失败不重试不回显服务端消息", async () => {
  const requests: { url: URL; options?: RequestInit }[] = [];
  const api = new TikHubPipixDiscovery((async (url, options) => {
    requests.push({ url: new URL(String(url)), options });
    return Response.json(data());
  }) as typeof fetch);
  await api.discover({ mode: "search", keyword: "生活" }, "qa-token", signal());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get("search_type"), "3");
  assert.equal(requests[0].options?.redirect, "error");
  assert.equal(
    new Headers(requests[0].options?.headers).get("Authorization"),
    "Bearer qa-token",
  );
  assert.ok(!requests[0].url.href.includes("qa-token"));
  for (const mode of ["home", "user", "topic"] as const)
    await api.discover(
      { mode, targetId: "132414", cursor: "33", page: 1 },
      "qa-token",
      signal(),
    );
  assert.match(requests[1].url.pathname, /fetch_home_feed$/);
  assert.equal(requests[2].url.searchParams.get("user_id"), "132414");
  assert.equal(requests[2].url.searchParams.get("feed_count"), "1");
  assert.equal(requests[3].url.searchParams.get("hashtag_id"), "132414");
  let calls = 0;
  const failure = new TikHubPipixDiscovery((async () => {
    calls++;
    return new Response("secret qa-token", { status: 429 });
  }) as typeof fetch);
  await assert.rejects(
    failure.discover({ mode: "home" }, "qa-token", signal()),
    (e) => /429/.test(String(e)) && !String(e).includes("qa-token"),
  );
  assert.equal(calls, 1);
  const network = new TikHubPipixDiscovery((async () => {
    throw Error("Authorization: Bearer qa-token");
  }) as typeof fetch);
  await assert.rejects(
    network.discover({ mode: "home" }, "qa-token", signal()),
    (e) => !String(e).includes("qa-token"),
  );
});

test("配置和本地列表不发远端请求，缺少 Key 不请求，关闭中止请求且不保存候选到素材库", async () => {
  const f = await fixture();
  let calls = 0,
    entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const service = new PipixSources(
    {
      db: f.app.db,
      dataPath: f.dir,
      ports: f.ports,
      secrets: f.app.secrets,
      changed() {},
      destinations: {
        zhihu: (material) => f.app.zhihu.saveSource(material),
        weibo: (material, accountId) =>
          f.app.weiboPosts.saveSource(material, accountId),
      },
    },
    undefined,
    new TikHubPipixDiscovery((async (_url, options) => {
      calls++;
      entered();
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(Error("aborted")),
          { once: true },
        );
      });
    }) as typeof fetch),
  );
  try {
    assert.deepEqual(service.discoveryConfig(), {
      configured: false,
      capacity: null,
    });
    await assert.rejects(service.discover({ mode: "home" }), /先配置/);
    assert.equal(calls, 0);
    await service.saveDiscoveryKey({ value: "qa-token" });
    assert.deepEqual(service.discoveryConfig(), {
      configured: true,
      capacity: null,
    });
    assert.deepEqual(service.list(), []);
    assert.equal(calls, 0);
    const pending = service.discover({ mode: "home" });
    await started;
    assert.equal(service.isBusy, true);
    await assert.rejects(service.discover({ mode: "home" }), /正在进行/);
    service.close();
    await assert.rejects(pending, /请求未完成/);
    assert.equal(calls, 1);
    assert.deepEqual(service.list(), []);
  } finally {
    service.close();
    await f.cleanup();
  }
});
