import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, file } from "./helpers";
import { resourceLinkNetworkError } from "../core/resource-link-errors";
import type {
  RemoteResourceLink,
  ResourceLinkWrite,
} from "../shared/resource-links";

async function setup() {
  type NetworkMode = "normal" | "offline" | "lost-receipt" | "other-operation";
  let mode: NetworkMode = "normal";
  let cloud: RemoteResourceLink | null = null;
  let page: { lastOperationId: string; document: unknown } | null = null;
  const calls: { path: string; method: string }[] = [];
  const writes: ResourceLinkWrite[] = [];
  const receipts = new Map<string, RemoteResourceLink>();
  const f = await fixture(
    {},
    {
      resourceLinksFetch: async (url, init) => {
        const path = new URL(url).pathname,
          method = init.method ?? "GET";
        calls.push({ path, method });
        if (mode === "offline") throw new Error("net::ERR_NAME_NOT_RESOLVED");
        if (path.startsWith("/api/pages/")) {
          if (method === "PUT") {
            const input = JSON.parse(String(init.body));
            page = {
              lastOperationId: input.operationId,
              document: input.document,
            };
            if (mode === "lost-receipt")
              throw new Error("net::ERR_CONNECTION_RESET");
          }
          return Response.json(page, { status: page ? 200 : 404 });
        }
        if (method === "GET")
          return Response.json(cloud, { status: cloud ? 200 : 404 });
        const input = JSON.parse(String(init.body)) as ResourceLinkWrite;
        writes.push(input);
        const receipt = receipts.get(input.operationId) ?? {
          ...input,
          id: path.split("/").at(-1)!,
          url: `https://panxu.site/r/${input.slug}`,
          revision: input.expectedRevision + 1,
          lastOperationId: input.operationId,
          updatedAt: new Date().toISOString(),
        };
        cloud = structuredClone(receipt);
        receipts.set(input.operationId, structuredClone(receipt));
        if (mode === "other-operation") cloud.lastOperationId = randomUUID();
        if (mode !== "normal") throw new Error("net::ERR_CONNECTION_RESET");
        return Response.json(receipt);
      },
    },
  );
  const saved = await f.add(false);
  await f.app.resourceLinks.configure({
    enabled: true,
    baseUrl: "https://panxu.site",
    token: "x".repeat(32),
  });
  return {
    ...f,
    ...saved,
    calls,
    writes,
    setMode(value: NetworkMode) {
      mode = value;
    },
    async shareReady() {
      const uid = f.app.repo.getAccount(f.account.id).uid;
      f.app.db.run(
        "UPDATE copies SET status='ready',files=?,owner_uid=?,verified_at='2026-11-23',share_id='own123',share_url='https://pan.quark.cn/s/own123',share_owner_uid=?,share_verified_at='2026-11-23',share_version=1 WHERE id=?",
        JSON.stringify([file]),
        uid,
        uid,
        saved.copyId,
      );
      await f.app.secrets.set(`share:${saved.copyId}`, "1234");
    },
  };
}

test("网络错误区分超时、代理、DNS和TLS，只保留安全诊断字段", () => {
  for (const [cause, expected] of [
    [new DOMException("timed out", "TimeoutError"), "响应超时"],
    [new Error("net::ERR_PROXY_CONNECTION_FAILED"), "代理连接失败"],
    [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("secret URL"), { code: "ENOTFOUND" }),
      }),
      "域名解析失败",
    ],
    [new Error("net::ERR_CERT_AUTHORITY_INVALID"), "安全连接失败"],
  ] as const) {
    const error = resourceLinkNetworkError(
      cause,
      "PUT",
      "/api/pages/id",
      new AbortController().signal,
    );
    assert(error.message.includes(`落地页服务${expected}`));
    assert.equal(error.uncertain, true);
    assert(!JSON.stringify(error.details).includes("secret"));
  }
  const read = resourceLinkNetworkError(
    new Error(),
    "GET",
    "/api/links/id",
    new AbortController().signal,
  );
  assert.equal(read.uncertain, false);
  assert(!read.message.includes("同步结果"));
});

test("已提交但回执丢失时只读取核对一次，不重放写入", async () => {
  const f = await setup();
  try {
    f.setMode("lost-receipt");
    const { link } = await f.app.resourceLinks.ensure(f.resourceId);
    assert.equal(link?.state, "synced");
    assert.equal(link?.hasPendingOperation, false);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ["PUT", "GET", "GET"],
    );
    const op = randomUUID();
    const result = (await f.app.resourceLinks.landingCloud(
      f.resourceId,
      "PUT",
      { operationId: op, document: { article: "original" } },
    )) as any;
    assert.equal(result.lastOperationId, op);
    assert.deepEqual(
      f.calls.slice(-2).map((c) => c.method),
      ["PUT", "GET"],
    );
  } finally {
    await f.cleanup();
  }
});

test("其他操作的云端回执不能解除待核对状态，失败后台同步写入日志", async () => {
  const f = await setup();
  try {
    f.setMode("other-operation");
    const { link } = await f.app.resourceLinks.ensure(f.resourceId);
    assert.equal(link?.hasPendingOperation, true);
    assert.equal(link?.revision, 0);
    assert.equal(f.writes.length, 1);
    assert.equal(
      f.app.systemLogs.read({ search: "RESOURCE_LINK_NETWORK", range: "all" })
        .total,
      1,
    );
    await assert.rejects(f.app.resourceLinks.copy(f.resourceId), {
      code: "RESOURCE_LINK_NOT_READY",
    });
  } finally {
    await f.cleanup();
  }
});

test("首次同步失败后重试原请求并继续绑定已核验分享，短码保持不变", async () => {
  const f = await setup();
  try {
    f.setMode("offline");
    const before = await f.app.resourceLinks.ensure(f.resourceId);
    assert.equal(before.link?.hasPendingOperation, true);
    const original = JSON.parse(
      (await f.app.secrets.get(`resource-links:operation:${before.link!.id}`))!,
    );
    await f.shareReady();
    f.setMode("normal");
    const after = await f.app.resourceLinks.retry(f.resourceId);
    assert.equal(after.link?.state, "synced");
    assert.equal(after.link?.url, before.link?.url);
    assert.equal(after.link?.targetUrl, "https://pan.quark.cn/s/own123");
    assert.equal(after.link?.revision, 2);
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.writes[0], original.input, "首先重放完整的原操作");
    assert.equal(f.writes[0].targetUrl, null);
    assert.equal(f.writes[1].targetUrl, after.link?.targetUrl);
    const count = f.calls.length;
    const readSecret = f.app.secrets.get.bind(f.app.secrets);
    f.app.secrets.get = async () => { throw Error("复制地址不应读取凭据"); };
    assert.deepEqual(await f.app.resourceLinks.copy(f.resourceId), {
      text: after.link!.url,
    });
    assert.deepEqual(await f.app.resourceLinks.copy(f.resourceId, "redirect"), {
      text: `https://panxu.site/go/${after.link!.slug}`,
    });
    assert.equal(f.calls.length, count, "复制已同步地址不发起网络请求");
    f.app.secrets.get = readSecret;
    f.setMode("offline");
    await f.app.resourceLinks.setEnabled(f.resourceId, false);
    for (const kind of ["landing", "redirect"] as const)
      await assert.rejects(f.app.resourceLinks.copy(f.resourceId, kind), {
        code: "RESOURCE_LINK_NOT_READY",
      });
  } finally {
    await f.cleanup();
  }
});

test("空入口只能复制领取页，未绑定分享不能复制直达链接", async () => {
  const f = await setup();
  try {
    const { link } = await f.app.resourceLinks.ensure(f.resourceId);
    assert.equal(
      (await f.app.resourceLinks.copy(f.resourceId)).text,
      link!.url,
    );
    await assert.rejects(f.app.resourceLinks.copy(f.resourceId, "redirect"), {
      code: "RESOURCE_LINK_TARGET_REQUIRED",
    });
  } finally {
    await f.cleanup();
  }
});
