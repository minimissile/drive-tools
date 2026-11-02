import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../core/database";
import { ResourceLanding } from "../core/resource-landing";
import { AppError } from "../core/errors";
import {
  landingQuality,
  landingSimilarity,
  type LandingWrite,
  type RemoteLanding,
} from "../shared/resource-landing";
import { article, source, review } from "./resource-landing-fixture";

function setup() {
  const db = new Database(":memory:");
  db.run(
    "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    "resource-test",
    source().resourceTitle,
    "https://pan.quark.cn/s/test",
    "test",
    "quark",
    "学习资料",
    "[]",
    "",
    "2026-11-02",
    "2026-11-02",
  );
  const resource = {
    id: "resource-test",
    provider: "quark",
    title: source().resourceTitle,
    category: "学习资料",
    tags: [],
    summary: "",
    revision: 1,
    copies: [
      {
        id: "copy-test",
        accountId: "account-test",
        status: "ready",
        verifiedAt: source().shareCheckedAt,
        shareVerifiedAt: source().shareCheckedAt,
        ownerUid: "owner",
        shareOwnerUid: "owner",
        shareId: "share",
        shareUrl: "https://pan.quark.cn/s/test",
        files: [
          {
            id: "file-test",
            name: "人情世故指南.pdf",
            size: 4800000,
            isDirectory: false,
          },
        ],
      },
    ],
  };
  let calls = 0,
    failAI = false,
    rejectReview = false,
    failRead = false,
    failWrite = false;
  let cloud: RemoteLanding | null = null;
  const receipts = new Map<string, RemoteLanding>();
  const writes: LandingWrite[] = [];
  const links = {
    context: async () => ({
      link: {
        id: "link-test",
        revision: 1,
        targetUrl: resource.copies[0].shareUrl,
        state: "synced",
        enabled: true,
        url: "https://panxu.site/r/abcdefgh",
        hasPendingOperation: false,
      },
    }),
    withLandingLock: async (_: string, fn: () => Promise<unknown>) => fn(),
    landingCloud: async (_: string, method: string, input?: LandingWrite) => {
      if (method === "GET") {
        if (failRead) throw new AppError("NETWORK", "读取失败");
        return cloud;
      }
      writes.push(input!);
      if (receipts.has(input!.operationId))
        return receipts.get(input!.operationId);
      cloud = {
        linkId: "link-test",
        version: (cloud?.version ?? 0) + 1,
        lastOperationId: input!.operationId,
        document: input!.document,
        publishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      receipts.set(input!.operationId, structuredClone(cloud));
      if (failWrite) throw new AppError("TIMEOUT", "写入超时", true);
      return cloud;
    },
  };
  const ai = {
    assertTextConfigured() {},
    modelFor: () => "fixture/model",
    resourceExport: async (name: string) => {
      calls++;
      if (failAI) throw new AppError("AI_FAILED", "生成失败");
      return name.endsWith("review")
        ? rejectReview
          ? {
              ...review,
              score: 60,
              verdict: "revise",
              reasons: ["需提供具体依据"],
              unsupportedClaims: ["测试拒绝事实"],
            }
          : review
        : article();
    },
  };
  const service = new ResourceLanding({
    repo: {
      db,
      getResource: () => resource,
      getAccount: () => ({ uid: "owner", enabled: true }),
    } as any,
    ai: ai as any,
    links: links as any,
    changed() {},
  });
  db.run(
    "INSERT INTO resource_landing_pages(resource_id,data) VALUES(?,?)",
    "resource-test",
    JSON.stringify({
      notes: "",
      draft: null,
      draftVersion: 0,
      source: null,
      generatedAt: null,
      model: null,
      review: null,
      reviewHash: null,
      published: null,
      pending: null,
      error: null,
      readings: [
        {
          copyId: "copy-test",
          fileId: "file-test",
          name: "人情世故指南.pdf",
          bytes: 4800000,
          sha256: "b".repeat(64),
          pageCount: 2,
          sampled: false,
          readAt: "2026-11-02T00:00:00.000Z",
          pages: [
            { page: 1, text: "请求案例比较了背景、时间和可选方案。" },
            { page: 2, text: "临时任务需确认截止时间、优先级和交付安排。" },
          ],
        },
      ],
    }),
  );
  return {
    db,
    service,
    resource,
    writes,
    get calls() {
      return calls;
    },
    set failAI(v: boolean) {
      failAI = v;
    },
    set rejectReview(v: boolean) {
      rejectReview = v;
    },
    set failRead(v: boolean) {
      failRead = v;
    },
    set failWrite(v: boolean) {
      failWrite = v;
    },
    links,
  };
}
test("质量门槛区分事实与建议，拒绝无引用、虚构承诺和重复正文", () => {
  assert.equal(landingQuality(article(), source(), review).eligible, true);
  const unsafe = article();
  unsafe.sections[0].evidenceIds = [];
  unsafe.sections[1].body += "保证录用";
  assert.equal(landingQuality(unsafe, source(), review).eligible, false);
  assert.equal(landingQuality(article(), source()).eligible, false);
  assert.equal(landingSimilarity(article(), article()), 1);
  const bounded = article();
  bounded.sections[0].body += "分享状态以平台为准，不保证永久有效。";
  assert.equal(landingQuality(bounded, source(), review).eligible, true);
  bounded.sections[0].body += "本站保证永久有效。";
  assert.equal(landingQuality(bounded, source(), review).eligible, false);
});
test("生成请求可重复读取且不能跨资源复用；AI失败保留旧草稿并脱敏补充", async () => {
  const f = setup();
  try {
    const id = randomUUID();
    const first = await f.service.generate(
      "resource-test",
      id,
      "contact@example.com，电话：13812345678",
    );
    assert.equal(first.quality?.eligible, true);
    assert(!first.notes.includes("example.com"));
    assert(!first.notes.includes("13812345678"));
    await f.service.generate("resource-test", id, "");
    assert.equal(f.calls, 2);
    await assert.rejects(f.service.generate("resource-other", id, ""), {
      code: "LANDING_REQUEST_CONFLICT",
    });
    f.failAI = true;
    await assert.rejects(f.service.generate("resource-test", randomUUID(), ""));
    assert.deepEqual((await f.service.get("resource-test")).draft, first.draft);
  } finally {
    f.db.close();
  }
});
test("独立检查不通过只修订一次，禁止发布；资料变化也阻止发布", async () => {
  const f = setup();
  try {
    f.rejectReview = true;
    const result = await f.service.generate("resource-test", randomUUID(), "");
    assert.equal(f.calls, 4);
    assert.equal(result.quality?.eligible, false);
    await assert.rejects(
      f.service.publish("resource-test", result.draftVersion),
      { code: "LANDING_QUALITY_REQUIRED" },
    );
    f.resource.revision++;
    assert.equal((await f.service.get("resource-test")).stale, true);
    await assert.rejects(
      f.service.publish("resource-test", result.draftVersion),
      { code: "LANDING_SOURCE_CHANGED" },
    );
    assert.equal(f.writes.length, 0);
  } finally {
    f.db.close();
  }
});

test("中断的生成不自动重试，显式新生成成功后不残留中断状态", async () => {
  const f = setup();
  try {
    const interrupted = randomUUID();
    f.db.run(
      "INSERT INTO resource_landing_generations(request_id,resource_id,status,created_at) VALUES(?,?,?,?)",
      interrupted,
      "resource-test",
      "running",
      new Date().toISOString(),
    );
    assert((await f.service.get("resource-test")).error?.includes("已中断"));
    assert.equal(f.calls, 0);
    await assert.rejects(f.service.generate("resource-test", interrupted, ""), {
      code: "LANDING_ALREADY_ATTEMPTED",
    });
    await f.service.generate("resource-test", randomUUID(), "");
    const result = await f.service.get("resource-test");
    assert.equal(result.error, null);
    assert.equal(result.generating, false);
    assert.equal(f.calls, 2);
    assert.equal(
      f.db.get<any>(
        "SELECT status FROM resource_landing_generations WHERE request_id=?",
        interrupted,
      )?.status,
      "failed",
    );
  } finally {
    f.db.close();
  }
});
test("编辑版本冲突被拒绝，编辑正文会重新审阅；发布和撤回独立于固定入口", async () => {
  const f = setup();
  try {
    const first = await f.service.generate("resource-test", randomUUID(), "");
    const draft = structuredClone(first.draft!);
    draft.title += "与整理建议";
    const saved = await f.service.saveDraft(
      "resource-test",
      first.draftVersion,
      draft,
    );
    assert.equal(saved.quality?.eligible, false);
    await assert.rejects(
      f.service.saveDraft("resource-test", first.draftVersion, draft),
      { code: "LANDING_DRAFT_CHANGED" },
    );
    const pub = await f.service.publish("resource-test", saved.draftVersion);
    assert.equal(pub.published?.version, 1);
    assert.equal(f.calls, 3);
    const withdrawn = await f.service.unpublish("resource-test");
    assert.equal(withdrawn.published?.document, null);
    assert(withdrawn.draft);
    assert.equal(withdrawn.published?.version, 2);
  } finally {
    f.db.close();
  }
});
test("云端已写入但回执超时，保留原操作并幂等重试", async () => {
  const f = setup();
  try {
    const draft = await f.service.generate("resource-test", randomUUID(), "");
    f.failWrite = true;
    await assert.rejects(
      f.service.publish("resource-test", draft.draftVersion),
    );
    assert.equal((await f.service.get("resource-test")).pending, true);
    f.failWrite = false;
    const result = await f.service.retry("resource-test");
    assert.equal(result.pending, false);
    assert.equal(result.published?.version, 1);
    assert.equal(f.writes[0].operationId, f.writes[1].operationId);
  } finally {
    f.db.close();
  }
});
test("已收到发布回执但随后读取失败，也必须保留原操作", async () => {
  const f = setup();
  try {
    const draft = await f.service.generate("resource-test", randomUUID(), "");
    const original = f.links.landingCloud;
    f.links.landingCloud = async (...args) => {
      const result = await original(...args);
      if (args[1] === "PUT") f.failRead = true;
      return result;
    };
    await assert.rejects(
      f.service.publish("resource-test", draft.draftVersion),
    );
    assert.equal((await f.service.get("resource-test")).pending, true);
    f.failRead = false;
    const result = await f.service.refresh("resource-test");
    assert.equal(result.pending, false);
    assert.equal(result.published?.version, 1);
  } finally {
    f.db.close();
  }
});
test("v28升级保留业务数据和凭据，并创建落地页表", () => {
  const dir = mkdtempSync(join(tmpdir(), "panxu-landing-migrate-")),
    path = join(dir, "test.db");
  try {
    const db = new Database(path);
    db.setSetting("sentinel", "keep");
    db.close();
    const old = new DatabaseSync(path);
    old.exec(
      "DROP TABLE resource_landing_generations; DROP TABLE resource_landing_pages; PRAGMA user_version=28",
    );
    old.close();
    const upgraded = new Database(path);
    assert.equal(upgraded.setting("sentinel", ""), "keep");
    assert.equal(upgraded.get<any>("PRAGMA user_version")?.user_version, 29);
    assert.equal(
      upgraded.all("SELECT * FROM resource_landing_pages").length,
      0,
    );
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺少实际正文时在付费调用前阻止生成，不影响已有草稿", async () => {
  const f = setup();
  try {
    const record = JSON.parse(
      f.db.get<{ data: string }>(
        "SELECT data FROM resource_landing_pages WHERE resource_id=?",
        "resource-test",
      )!.data,
    );
    delete record.readings;
    f.db.run(
      "UPDATE resource_landing_pages SET data=? WHERE resource_id=?",
      JSON.stringify(record),
      "resource-test",
    );
    await assert.rejects(
      f.service.generate("resource-test", randomUUID(), "宣传资料不能替代正文"),
      { code: "LANDING_SOURCE_REQUIRED" },
    );
    assert.equal(f.calls, 0);
  } finally {
    f.db.close();
  }
});
