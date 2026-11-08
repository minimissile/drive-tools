import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../core/database";
import { Repository } from "../core/repository";
import { SearchOperations } from "../core/search";
import type { Operations } from "../core/operations";
import { SecretStore } from "../core/secrets";
import { WebsiteAccounts } from "../core/website-accounts";
import { BrowserEnvironments } from "../core/browser-environments";
import { BrowserEnvironmentQueue } from "../core/browser-environment-queue";
import { TiebaAutocareStore } from "../core/tieba-autocare/store";
import { TiebaPublishing } from "../core/tieba-publishing/service";
import { checkResourcePost } from "../core/tieba-publishing/policy";
import {
  stopTiebaPublishingForBackup,
  tiebaPublishingWriteState,
} from "../core/tieba-publishing/store";
import type { TiebaPublishingRecord } from "../core/tieba-publishing/store";
import { fixture as applicationFixture } from "./helpers";
import { queryMethods } from "../shared/ipc";
import {
  tiebaPublishingSaveSchema,
  tiebaPublishingSubmitSchema,
} from "../shared/tieba-publishing";
import type { AppPorts } from "../core/ports";
import type { TiebaTopicPayload } from "../core/tieba/topic-types";
import type { TiebaTopicReceipt } from "../shared/tieba-topics";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "panxu-resource-post-")),
    db = new Database(join(dir, "data.db"));
  const repo = new Repository(db),
    search = new SearchOperations(repo, {} as Operations, () => {});
  let time = Date.parse("2026-11-07T02:00:00Z"),
    uid = "111",
    publishes = 0,
    clicks = 0,
    reconciles = 0;
  let failure: Error | undefined,
    during: (() => void) | undefined,
    duringFinal: (() => void) | undefined,
    badReceipt = false,
    futureReceipt = false,
    review = false;
  const now = () => new Date(time).toISOString();
  const receipt = (payload: TiebaTopicPayload): TiebaTopicReceipt => ({
    status: review ? "pending_review" : "verified",
    forumId: payload.forumId,
    threadId: "1000",
    postId: "10001",
    url: "https://tieba.baidu.com/p/1000?pid=10001#10001",
    authorUid: badReceipt ? "999" : uid,
    title: payload.title,
    body: payload.body,
    images: [],
    checkedAt: futureReceipt ? new Date(time + 60000).toISOString() : now(),
    message: "官网模拟回执",
  });
  const ports = {
    browserEnvironments: {
      prepare: async () => {},
      assertIdle: async () => {},
      checkNetwork: async () => "203.0.113.10",
    },
    websiteSessions: {
      isOpen: () => false,
      login: async () => {},
      clear: async () => {},
      invalidate: async () => {},
      status: async () => ({
        hasSession: true,
        uid,
        windowOpen: false,
        error: null,
      }),
      verify: async () => ({
        hasSession: true,
        uid,
        windowOpen: false,
        error: null,
      }),
    },
    tiebaTopics: {
      publish: async (
        _account: unknown,
        _uid: string,
        payload: TiebaTopicPayload,
        checkpoint: () => Promise<void>,
        guard: () => Promise<void>,
      ) => {
        publishes++;
        during?.();
        await checkpoint();
        duringFinal?.();
        if (failure) throw failure;
        await guard();
        clicks++;
        return receipt(payload);
      },
      reconcile: async (
        _account: unknown,
        _uid: string,
        payload: TiebaTopicPayload,
      ) => {
        reconciles++;
        return receipt(payload);
      },
    },
  } as unknown as AppPorts;
  const secrets = new SecretStore(db, {
    available: () => true,
    encrypt: async (value) => value,
    decrypt: async (value) => value,
  });
  const environments = new BrowserEnvironments(
    db,
    secrets,
    ports,
    dir,
    () => {},
  );
  environments.setExternalNetworkChecker(async () => "203.0.113.10");
  const queue = new BrowserEnvironmentQueue(db, environments, () => {}),
    accounts = new WebsiteAccounts(db, ports, () => {}, environments, queue);
  const env = await environments.save({
    name: "资源发帖fixture",
    engine: "bitbrowser",
    profileId: "resource-post-fixture",
  });
  const account = accounts.add("tieba", "贴吧测试", env.id);
  await accounts.verify(account.id);
  const targets = new TiebaAutocareStore(db);
  targets.saveTarget({
    id: "tiebatarget_resource",
    accountId: account.id,
    uid,
    forumId: "100",
    name: "学习资料",
    url: "https://tieba.baidu.com/f?kw=学习资料",
    source: "observed",
    level: null,
    experience: null,
    signed: null,
    canSign: null,
    message: null,
    checkedAt: now(),
    paused: false,
    pauseReason: null,
    syncedAt: now(),
    stamp: environments.stamp({ kind: "website", id: account.id }),
  });
  db.run(
    "INSERT INTO accounts(id,provider,alias,uid,status,enabled,created_at,updated_at) VALUES('drive_test','baidu','本人网盘','333','connected',1,?,?)",
    now(),
    now(),
  );
  db.run(
    "INSERT INTO resources(id,title,source_url,source_key,source_kind,provider,category,tags,summary,revision,created_at,updated_at) VALUES('resource_test','Excel学习资料','https://pan.baidu.com/s/1Owned','1Owned','owned','baidu','办公','[\"Excel\"]','本人整理的Excel练习文档与学习说明。',1,?,?)",
    now(),
    now(),
  );
  db.run(
    "INSERT INTO copies(id,resource_id,account_id,directory,files,status,owner_uid,verified_at,share_id,share_url,share_owner_uid,share_version,share_verified_at,created_at,updated_at) VALUES('copy_test','resource_test','drive_test','/测试','[]','ready','333',?,'share_test','https://pan.baidu.com/s/1Owned','333',1,?,?,?)",
    now(),
    now(),
    now(),
    now(),
  );
  await secrets.set("share:copy_test", "a1b2", { preserveEmpty: true });
  const deps = {
    db,
    repo,
    search,
    accounts,
    environments,
    queue,
    ports,
    secrets,
    dataPath: dir,
    changed: () => {},
    clock: () => time,
  };
  let service = new TiebaPublishing(deps);
  const input = (patch = {}) =>
    tiebaPublishingSaveSchema.parse({
      targetId: "tiebatarget_resource",
      keyword: "Excel学习资料",
      keywordSourceId: "manual",
      copyIds: ["copy_test"],
      title: "Excel练习资料与学习说明",
      body: "整理了Excel学习用的练习文档，请按资料中的示例与说明练习。资料包含基础函数与表格整理练习，请结合实际任务核对适用范围。\n网盘链接：https://pan.baidu.com/s/1Owned\n提取码：a1b2",
      ...patch,
    });
  const prepare = async (patch = {}) => {
    const snapshot = await service.save(input(patch));
    return snapshot.drafts.find((draft) => draft.id === snapshot.savedDraftId)!;
  };
  return {
    db,
    repo,
    accounts,
    account,
    targets,
    secrets,
    environments,
    ports,
    input,
    prepare,
    get service() {
      return service;
    },
    get publishes() {
      return publishes;
    },
    get clicks() {
      return clicks;
    },
    get reconciles() {
      return reconciles;
    },
    set failure(value: Error | undefined) {
      failure = value;
    },
    set during(value: (() => void) | undefined) {
      during = value;
    },
    set duringFinal(value: (() => void) | undefined) {
      duringFinal = value;
    },
    set uid(value: string) {
      uid = value;
    },
    set badReceipt(value: boolean) {
      badReceipt = value;
    },
    set futureReceipt(value: boolean) {
      futureReceipt = value;
    },
    set review(value: boolean) {
      review = value;
    },
    advance(ms = 61000) {
      time += ms;
    },
    restart() {
      service.dispose();
      service = new TiebaPublishing(deps);
    },
    pause() {
      const target = targets.targets()[0];
      targets.saveTarget({ ...target, paused: true, pauseReason: "测试暂停" });
    },
    async cleanup() {
      service.dispose();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const submit = (id: string, version: number) => ({
  id,
  version,
  confirmed: true as const,
});

test("资源发帖从本地词池和资源库读取，不发起建链、转存或模型请求", async () => {
  const f = await fixture();
  try {
    f.db.run(
      "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES('pool_test','学习词',NULL,?,?)",
      JSON.stringify([
        {
          id: "kw1",
          word: "Excel练习",
          source: "manual",
          metrics: {},
          fetchedAt: null,
        },
      ]),
      "2026-11-07T02:00:00Z",
    );
    const words = f.service.words({ query: "Excel" });
    assert.equal(words[0].id, "pool:pool_test:kw1");
    const resources = await f.service.resources({ query: "Excel" });
    assert.equal(resources.length, 1);
    assert.equal(resources[0].url, "https://pan.baidu.com/s/1Owned");
    assert.equal(resources[0].code, "a1b2");
    assert.equal(f.publishes, 0);
    f.secrets.remove("share:copy_test");
    await assert.rejects(
      () => f.service.resources({ query: "Excel" }),
      /提取码记录缺失/,
    );
    await f.secrets.set("share:copy_test", "a1b2");
    f.db.run("UPDATE copies SET share_owner_uid='other'");
    assert.equal((await f.service.resources({ query: "Excel" })).length, 0);
  } finally {
    await f.cleanup();
  }
});
test("历史流量词超过30条时，本地词池独立查询和草稿来源校验仍可使用", async () => {
  const f = await fixture();
  try {
    f.db.run(
      "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,status) VALUES('query_many','longtail','fixture','{}','[]','success')",
    );
    for (let index = 0; index < 35; index++)
      f.db.run(
        "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,source,metrics,data,observed_at) VALUES(?, 'query_many','word',?,?,'历史接口来源','{}','{}','2026-11-07T02:00:00Z')",
        `history_${index}`,
        `Excel学习资料${index}`,
        `excel学习资料${index}`,
      );
    f.db.run(
      "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES('pool_source','本地学习词池',NULL,?,'2026-11-07T02:00:00Z')",
      JSON.stringify([
        { id: "kw1", word: "Excel学习资料", source: "manual", metrics: {} },
      ]),
    );
    assert.equal(
      f.service.words({ query: "Excel学习资料" }).length,
      30,
      "兼容旧all查询上限",
    );
    const pool = f.service.words({ query: "Excel学习资料", source: "pool" });
    assert.equal(pool.length, 1);
    assert.equal(pool[0].id, "pool:pool_source:kw1");
    assert.ok(
      f.service
        .words({ query: "Excel学习资料", source: "history" })
        .every((item) => item.id.startsWith("knowledge:")),
    );
    const draft = await f.prepare({ keywordSourceId: pool[0].id });
    assert.equal(draft.status, "ready");
    assert.equal(draft.keywordSourceId, pool[0].id);
    assert.equal(f.publishes, 0);
  } finally {
    await f.cleanup();
  }
});
test("资源稿仅允许所选本人链接及准确提取码，养号主题策略不受影响", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    assert.equal(draft.status, "ready");
    assert.equal(f.publishes, 0);
    for (const body of [
      draft.body.replace("1Owned", "1Other"),
      draft.body.replace("a1b2", "wrong"),
      draft.body + "\nhttps://evil.invalid/s/a",
      draft.body.replace("https:", "http:"),
      draft.body + "\nhttps://pan.baidu.com/s/1Owned?pwd=bad1",
    ])
      assert.throws(() => checkResourcePost({ ...draft, body }));
    assert.equal(
      (
        await f.prepare({
          body: "未放入网盘链接的资料说明，请按实际内容核对。",
        })
      ).status,
      "draft",
    );
  } finally {
    await f.cleanup();
  }
});
test("编辑保留版本且拒绝旧窗口覆盖；词来源失效不会冒充本地流量词", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    const saved = await f.service.save(
      f.input({
        id: draft.id,
        version: draft.version,
        title: "Excel资料使用说明更新",
      }),
    );
    assert.equal(saved.drafts[0].version, 2);
    await assert.rejects(
      () => f.service.save(f.input({ id: draft.id, version: 1 })),
      /其他窗口/,
    );
    await assert.rejects(
      () => f.prepare({ keywordSourceId: "pool:missing" }),
      /来源已变化/,
    );
  } finally {
    await f.cleanup();
  }
});
test("20至79字资源正文保持草稿，不能出现已就绪却被官网适配器拒绝的状态", async () => {
  const f = await fixture();
  try {
    const body = "练习资料说明\nhttps://pan.baidu.com/s/1Owned\n提取码：a1b2";
    assert.ok(body.length >= 20 && body.length < 80);
    const draft = await f.prepare({ body });
    assert.equal(draft.status, "draft");
    assert.match(draft.message, /80至10000/);
    await assert.rejects(
      () => f.service.submit(submit(draft.id, draft.version)),
      /尚未就绪/,
    );
    assert.equal(f.publishes, 0);
  } finally {
    await f.cleanup();
  }
});
test("多资源提取码按链接后方对应校验，不能用另一条链接的提取码凑齐", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    const second = {
      ...draft.resources[0],
      copyId: "copy_second",
      url: "https://pan.baidu.com/s/1Second",
      code: "c3d4",
    };
    const resources = [...draft.resources, second];
    assert.doesNotThrow(() =>
      checkResourcePost({
        ...draft,
        resources,
        body: `${draft.body}\n第二份资料\n${second.url}\n提取码：c3d4`,
      }),
    );
    assert.throws(
      () =>
        checkResourcePost({
          ...draft,
          resources,
          body: `第一份资料分享\nhttps://pan.baidu.com/s/1Owned\n提取码：c3d4\n第二份资料\n${second.url}\n提取码：a1b2`,
        }),
      /提取码/,
    );
    assert.throws(
      () =>
        checkResourcePost({
          ...draft,
          resources,
          body: `第一份资料分享\nhttps://pan.baidu.com/s/1Owned\n第二份资料\n${second.url}\n提取码：a1b2\n提取码：c3d4`,
        }),
      /提取码/,
    );
  } finally {
    await f.cleanup();
  }
});
test("发布以明确按钮请求为准，不需要额外权利勾选，保存不会自动提交", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    assert.equal(draft.status, "ready");
    assert.equal(f.publishes, 0);
    assert.equal(f.clicks, 0);
    const request = submit(draft.id, draft.version);
    assert.deepEqual(tiebaPublishingSubmitSchema.parse(request), request);
    assert.equal(Object.hasOwn(request, "rightsConfirmed"), false);
    for (const confirmed of [undefined, false]) {
      const invalid = { ...request, confirmed };
      assert.equal(
        tiebaPublishingSubmitSchema.safeParse(invalid).success,
        false,
      );
      await assert.rejects(
        () =>
          f.service.submit(
            invalid as unknown as Parameters<TiebaPublishing["submit"]>[0],
          ),
        { code: "TIEBA_PUBLISHING_CONFIRM" },
      );
    }
    assert.equal(f.publishes, 0);
    assert.equal(f.service.snapshot().drafts[0].version, draft.version);
    const result = await f.service.submit(request);
    assert.equal(result.drafts[0].status, "verified");
    assert.equal(f.publishes, 1);
    assert.equal(f.clicks, 1);
  } finally {
    await f.cleanup();
  }
});
test("明确提交一次保存检查点，准确作者和正文回执才进入统计", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare(),
      result = await f.service.submit(submit(draft.id, draft.version));
    assert.equal(result.drafts[0].status, "verified");
    assert.equal(f.clicks, 1);
    assert.ok(result.drafts[0].submittedAt);
    assert.equal(f.service.publications()[0].threadId, "1000");
    await assert.rejects(
      () => f.service.submit(submit(draft.id, result.drafts[0].version)),
      /只能|确认|保存/,
    );
    assert.equal(f.clicks, 1);
  } finally {
    await f.cleanup();
  }
});
test("提交未知跨重启保留，只读核对不重发", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.failure = new Error("网络断开");
    const result = await f.service.submit(submit(draft.id, draft.version));
    assert.equal(result.drafts[0].status, "uncertain");
    assert.equal(f.publishes, 1);
    assert.equal(f.clicks, 0);
    assert.equal(tiebaPublishingWriteState(f.db, "111").uncertain, true);
    f.restart();
    const pending = f.service.snapshot().drafts[0];
    assert.equal(pending.status, "uncertain");
    await assert.rejects(
      () => f.service.submit(submit(pending.id, pending.version)),
      { code: "TIEBA_PUBLISHING_CONFIRM" },
    );
    assert.equal(f.publishes, 1);
    const recovered = await f.service.reconcile({ id: draft.id });
    assert.equal(recovered.drafts[0].status, "verified");
    assert.equal(f.reconciles, 1);
    assert.equal(f.publishes, 1);
  } finally {
    await f.cleanup();
  }
});
test("资源分享版本改变阻止旧正文发布，返回可编辑原稿", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.db.run("UPDATE copies SET share_version=2");
    const result = await f.service.submit(submit(draft.id, draft.version));
    assert.equal(result.drafts[0].status, "draft");
    assert.match(result.drafts[0].message, /资源或分享版本已变化/);
    assert.equal(f.publishes, 0);
  } finally {
    await f.cleanup();
  }
});
test("提交检查点前暂停不点击，检查点后暂停保留未知", async () => {
  for (const after of [false, true]) {
    const f = await fixture();
    try {
      const draft = await f.prepare();
      if (after) f.duringFinal = () => f.pause();
      else f.during = () => f.pause();
      const result = await f.service.submit(submit(draft.id, draft.version));
      assert.equal(f.clicks, 0);
      assert.equal(result.drafts[0].status, after ? "uncertain" : "draft");
      assert.equal(!!result.drafts[0].submittedAt, after);
    } finally {
      await f.cleanup();
    }
  }
});
test("旧回帖未知、账号切换与环境变化都不能借资源发帖绕过", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.db.run(
      "INSERT INTO tieba_reply_drafts(id,candidate_id,uid,thread_id,status,version,submitted_at,data) VALUES('old_reply','missing','111','3000','uncertain',1,?, '{}')",
      "2026-11-07T01:00:00Z",
    );
    const result = await f.service.submit(submit(draft.id, draft.version));
    assert.equal(result.drafts[0].status, "draft");
    assert.match(result.drafts[0].message, /待核对/);
    assert.equal(f.publishes, 0);
    f.db.run("DELETE FROM tieba_reply_drafts");
    const other = await f.prepare();
    f.uid = "222";
    const changed = await f.service.submit(submit(other.id, other.version));
    assert.equal(changed.drafts[0].status, "draft");
    assert.equal(f.publishes, 0);
  } finally {
    await f.cleanup();
  }
});
test("主题与资源发帖共享至少60秒间隔并阻止相同正文再次提交", async () => {
  const f = await fixture();
  try {
    const first = await f.prepare();
    await f.service.submit(submit(first.id, first.version));
    const second = await f.prepare({
      title: "另一篇Excel资料说明",
      body: f.input().body.replace("整理了", "本次整理了"),
    });
    const blocked = await f.service.submit(submit(second.id, second.version));
    assert.equal(blocked.drafts[0].status, "draft");
    assert.match(blocked.drafts[0].message, /60秒/);
    f.advance();
    const duplicate = await f.prepare();
    const duplicateResult = await f.service.submit(
      submit(duplicate.id, duplicate.version),
    );
    assert.match(duplicateResult.drafts[0].message, /相同正文/);
    assert.equal(f.clicks, 1);
  } finally {
    await f.cleanup();
  }
});
test("资源发帖共享关注动作的未知阻断与60秒间隔", async () => {
  const f = await fixture();
  try {
    const original = f.targets.targets()[0];
    const draft = await f.prepare();
    const followIntent = {
      status: "uncertain" as const,
      submittedAt: "2026-11-07T01:59:45.000Z",
      checkedAt: null,
      message: "关注待核对",
    };
    f.targets.saveTarget({ ...original, followIntent });
    const pending = await f.service.submit(submit(draft.id, draft.version));
    assert.match(pending.drafts[0].message, /待核对/);
    assert.equal(f.publishes, 0);
    f.targets.saveTarget({
      ...original,
      followIntent: { ...followIntent, status: "verified" },
    });
    const checked = await f.prepare({
      id: draft.id,
      version: pending.drafts[0].version,
    });
    const interval = await f.service.submit(
      submit(checked.id, checked.version),
    );
    assert.match(interval.drafts[0].message, /60秒/);
    assert.equal(f.publishes, 0);
  } finally {
    await f.cleanup();
  }
});
test("错误作者、未来时间和审核回执不会冒充已核实", async () => {
  for (const mode of ["author", "future", "review"] as const) {
    const f = await fixture();
    try {
      const draft = await f.prepare();
      f.badReceipt = mode === "author";
      f.futureReceipt = mode === "future";
      f.review = mode === "review";
      const result = await f.service.submit(submit(draft.id, draft.version));
      assert.equal(
        result.drafts[0].status,
        mode === "review" ? "pending_review" : "uncertain",
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("备份及重启撤回待发资格，未知检查点始终保留", async () => {
  const f = await fixture();
  try {
    const ready = await f.prepare();
    f.restart();
    assert.equal(f.service.snapshot().drafts[0].status, "draft");
    const checked = await f.prepare({
      id: ready.id,
      version: f.service.snapshot().drafts[0].version,
    });
    f.failure = new Error("断开");
    await f.service.submit(submit(checked.id, checked.version));
    const pending = await f.prepare({
      title: "第二份资料说明",
      body: f.input().body + "\n请根据需要选择合适练习。",
    });
    stopTiebaPublishingForBackup(f.db);
    assert.equal(f.service.store.draft(pending.id)?.status, "draft");
    assert.equal(f.service.store.draft(checked.id)?.status, "uncertain");
    assert.ok(f.service.store.draft(checked.id)?.submittedAt);
  } finally {
    await f.cleanup();
  }
});
test("提交检查点后退出服务不会落成失败重试，重启只读恢复", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.duringFinal = () => f.service.dispose();
    await assert.rejects(
      () => f.service.submit(submit(draft.id, draft.version)),
      /资源发帖已停止/,
    );
    assert.ok(f.service.store.draft(draft.id)?.submittedAt);
    assert.equal(f.clicks, 0);
    f.restart();
    assert.equal(f.service.snapshot().drafts[0].status, "uncertain");
    await f.service.reconcile({ id: draft.id });
    assert.equal(f.reconciles, 1);
    assert.equal(f.publishes, 1);
  } finally {
    await f.cleanup();
  }
});
test("资源发帖IPC按只读与明确提交分类，快照无远端调用且备份撤销ready资格", async () => {
  const f = await applicationFixture();
  try {
    let websiteReads = 0;
    f.ports.websiteSessions = {
      isOpen: () => false,
      login: async () => {},
      clear: async () => {},
      invalidate: async () => {},
      status: async () => {
        websiteReads++;
        throw new Error("快照不应读取远端");
      },
    };
    const readOnly = queryMethods as readonly string[];
    for (const method of [
      "tieba.publishing.snapshot",
      "tieba.publishing.words",
      "tieba.publishing.resources",
    ])
      assert.ok(readOnly.includes(method));
    for (const method of [
      "tieba.publishing.save",
      "tieba.publishing.submit",
      "tieba.publishing.reconcile",
    ])
      assert.equal(readOnly.includes(method), false);
    const snapshot = (await f.app.invoke(
      "tieba.publishing.snapshot",
      undefined,
    )) as import("../shared/tieba-publishing").TiebaPublishingSnapshot;
    assert.deepEqual(snapshot.drafts, []);
    assert.deepEqual(
      await f.app.invoke("tieba.publishing.words", { query: "" }),
      [],
    );
    assert.deepEqual(
      await f.app.invoke("tieba.publishing.resources", { query: "" }),
      [],
    );
    for (const method of ["tieba.publishing.save", "tieba.publishing.submit"])
      await assert.rejects(f.app.invoke(method, { confirmed: false }));
    assert.equal(websiteReads, 0);
    const record: TiebaPublishingRecord = {
      id: "tiebapublishing_backup",
      targetId: "tiebatarget_backup",
      accountId: "web_backup",
      uid: "111",
      forumId: "100",
      forumName: "学习资料",
      keyword: "Excel",
      keywordSourceId: "manual",
      resources: [],
      title: "备份草稿",
      body: "备份测试仅验证本地已保存记录不会继承发布确认。",
      ruleNote: "",
      version: 1,
      status: "ready",
      checks: [],
      message: "",
      submittedAt: null,
      receipt: null,
      createdAt: "2026-11-07T02:00:00Z",
      updatedAt: "2026-11-07T02:00:00Z",
      stamp: {
        environmentId: "env_backup",
        identityId: "identity_backup",
        revision: 1,
        identityRevision: 1,
      },
      payloadHash: "fixture",
      lastMutationAt: null,
    };
    f.app.tiebaPublishing.store.save(record);
    f.ports.chooseDirectory = async () => f.dir;
    const folder = await f.app.backup();
    assert.ok(folder);
    const backup = new Database(join(folder, "panxu.db"));
    try {
      const { TiebaPublishingStore } =
        await import("../core/tieba-publishing/store");
      assert.equal(
        new TiebaPublishingStore(backup).draft(record.id)?.status,
        "draft",
      );
      assert.equal(
        f.app.tiebaPublishing.store.draft(record.id)?.status,
        "ready",
        "备份只撤销副本的确认，源数据库不变",
      );
    } finally {
      backup.close();
    }
  } finally {
    await f.cleanup();
  }
});
