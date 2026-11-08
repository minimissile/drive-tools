import { tiebaPublishingIndexKey } from "../core/tieba-publishing/store";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../core/database";
import { SecretStore } from "../core/secrets";
import { WebsiteAccounts } from "../core/website-accounts";
import { BrowserEnvironments } from "../core/browser-environments";
import { BrowserEnvironmentQueue } from "../core/browser-environment-queue";
import { TiebaAutocareStore } from "../core/tieba-autocare/store";
import { TiebaTopics } from "../core/tieba-topics/service";
import { migrateTiebaTopics } from "../core/tieba-topics/migration";
import { stopTiebaTopicsForBackup } from "../core/tieba-topics/store";
import { topicFingerprint } from "../core/tieba-topics/policy";
import type { AppPorts } from "../core/ports";
import type { AiService } from "../core/ai";
import type { TiebaTopicPayload } from "../core/tieba/topic-types";
import type { TiebaTopicReceipt } from "../shared/tieba-topics";

const text =
  "整理本地资料时，可以先列出最常使用的三个场景，再按照场景建立少量主目录。每份文件保留一个位置，用标签区分类型，避免同一文件复制多份。每周检查收件目录，把临时文件归档。记录一次实际查找所需时间，再根据结果调整目录。";
const source = {
  kind: "owned" as const,
  title: "本地资料目录整理说明",
  body: text,
  sourceUrl: "",
  rightsNote: "以上内容由本人整理撰写，允许在指定贴吧使用。",
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL0sAAAAASUVORK5CYII=",
  "base64",
);
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "panxu-topic-")),
    db = new Database(join(dir, "data.db"));
  migrateTiebaTopics(db.db);
  let time = Date.parse("2026-11-07T02:00:00Z"),
    uid = "111",
    calls = 0,
    publishes = 0,
    clicks = 0,
    reconciles = 0;
  let failure: Error | undefined,
    mismatch = false,
    review = false,
    noCheckpoint = false,
    aiFailure: Error | undefined;
  let during: (() => void) | undefined, duringAi: (() => void) | undefined;
  let selected: { name: string; bytes: Buffer }[] | null = null;
  const now = () => new Date(time).toISOString();
  const receipt = (p: TiebaTopicPayload): TiebaTopicReceipt => ({
    status: review ? "pending_review" : "verified",
    forumId: p.forumId,
    threadId: "1000",
    postId: "10001",
    url: "https://tieba.baidu.com/p/1000?pid=10001#10001",
    authorUid: mismatch ? "999" : uid,
    title: p.title,
    body: p.body,
    images: p.images.map((i, n) => ({
      sha256: i.sha256,
      url: `https://tiebapic.baidu.com/forum/pic/item/test${n}.png`,
    })),
    checkedAt: now(),
    message: "官网回执",
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
        _a: unknown,
        _u: string,
        p: TiebaTopicPayload,
        checkpoint: () => Promise<void>,
        guard?: () => Promise<void>,
      ) => {
        publishes++;
        if (!noCheckpoint) await checkpoint();
        during?.();
        if (failure) throw failure;
        if (!noCheckpoint) await guard?.();
        clicks++;
        return receipt(p);
      },
      reconcile: async (_a: unknown, _u: string, p: TiebaTopicPayload) => {
        reconciles++;
        return receipt(p);
      },
    },
  } as unknown as AppPorts;
  const secrets = new SecretStore(db, {
    available: () => true,
    encrypt: async (v) => v,
    decrypt: async (v) => v,
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
      name: "主题fixture",
      engine: "bitbrowser",
      profileId: "topic-fixture",
    }),
    account = accounts.add("tieba", "主题测试", env.id);
  await accounts.verify(account.id);
  const targets = new TiebaAutocareStore(db);
  targets.saveTarget({
    id: "tiebatarget_topic",
    accountId: account.id,
    uid,
    forumId: "100",
    name: "整理资料",
    url: "https://tieba.baidu.com/f?kw=整理资料",
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
  const ai = {
    assertTextConfigured: () => ({ model: "mock/copy" }),
    modelFor: () => "mock/copy",
    resourceExport: async (
      _phase: string,
      _schema: unknown,
      _instruction: string,
      _input: unknown,
      _images: unknown,
      options: { beforeRequest(): void },
    ) => {
      options.beforeRequest();
      calls++;
      duringAi?.();
      if (aiFailure) throw aiFailure;
      return {
        publishable: true,
        title: "整理资料目录的几个步骤",
        body: text,
        evidence: ["每份文件保留一个位置"],
        reason: "",
      };
    },
  } as unknown as AiService;
  const deps = {
    db,
    accounts,
    environments,
    queue,
    ports,
    ai,
    dataPath: dir,
    changed: () => {},
    clock: () => time,
    readImages: async () => selected,
  };
  let service = new TiebaTopics(deps);
  const prepare = () => {
    if (!service.snapshot().rules.length)
      service.saveRule({
        targetId: "tiebatarget_topic",
        version: 0,
        note: "本吧仅发布与资料整理有关的原创经验，图片应有使用权，不允许广告导流或交换互动。",
        allowImages: true,
        confirmed: true,
      });
    return service.save({
      targetId: "tiebatarget_topic",
      title: "整理资料目录的几个步骤",
      body: text,
      source,
    }).drafts[0];
  };
  return {
    db,
    dir,
    ports,
    account,
    targets,
    environments,
    queue,
    prepare,
    async otherDraft() {
      uid = "222";
      const otherEnv = await environments.save({
        name: "另一主题fixture",
        engine: "bitbrowser",
        profileId: "topic-fixture-other",
      });
      const other = accounts.add("tieba", "另一主题账号", otherEnv.id);
      await accounts.verify(other.id);
      const original = targets.targets()[0],
        targetId = "tiebatarget_other";
      targets.saveTarget({
        ...original,
        id: targetId,
        accountId: other.id,
        uid,
        stamp: environments.stamp({ kind: "website", id: other.id }),
      });
      service.saveRule({
        targetId,
        version: 0,
        note: "本吧仅允许原创资料整理内容，禁止广告、导流与交换互动，发布前核对图片使用权。",
        allowImages: true,
        confirmed: true,
      });
      return service.save({
        targetId,
        title: "另一账号整理目录的步骤",
        body: text,
        source,
      }).drafts[0];
    },
    get service() {
      return service;
    },
    get counts() {
      return { calls, publishes, clicks, reconciles };
    },
    get time() {
      return time;
    },
    set time(v: number) {
      time = v;
    },
    set uid(v: string) {
      uid = v;
    },
    set failure(v: Error | undefined) {
      failure = v;
    },
    set aiFailure(v: Error | undefined) {
      aiFailure = v;
    },
    set mismatch(v: boolean) {
      mismatch = v;
    },
    set review(v: boolean) {
      review = v;
    },
    set noCheckpoint(v: boolean) {
      noCheckpoint = v;
    },
    set during(v: (() => void) | undefined) {
      during = v;
    },
    set duringAi(v: (() => void) | undefined) {
      duringAi = v;
    },
    set selected(v: { name: string; bytes: Buffer }[] | null) {
      selected = v;
    },
    reopen() {
      service.dispose();
      service = new TiebaTopics(deps);
    },
    async close() {
      service.dispose();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const submit = (d: { id: string; version: number }) => ({
  ...d,
  confirmed: true as const,
  rightsConfirmed: true as const,
});
test("topic local draft/rule/version checks never trigger paid or remote work", async () => {
  const f = await fixture();
  try {
    const draft = f.service.save({
      targetId: "tiebatarget_topic",
      title: "",
      body: "",
      source: { ...source, body: "" },
    });
    assert.equal(draft.drafts[0].status, "draft");
    assert.equal(draft.savedDraftId, draft.drafts[0].id);
    assert.deepEqual(f.counts, {
      calls: 0,
      publishes: 0,
      clicks: 0,
      reconciles: 0,
    });
    const d = f.prepare();
    assert.equal(d.status, "ready");
    assert.throws(
      () =>
        f.service.save({
          id: d.id,
          version: d.version + 1,
          targetId: d.targetId,
          title: d.title,
          body: d.body,
          source,
        }),
      /其他窗口/,
    );
    f.service.saveRule({
      targetId: d.targetId,
      version: 1,
      note: "本吧仅允许原创资料整理讨论，不得发布广告或导流，需要注明来源且不侵犯图片版权。",
      allowImages: true,
      confirmed: true,
    });
    assert.equal(
      f.service.snapshot().drafts.find((r) => r.id === d.id)?.status,
      "draft",
    );
    await assert.rejects(f.service.submit(submit(d)), /其他窗口/);
  } finally {
    await f.close();
  }
});
test("exact verified topic requires checkpoint plus UID/TID/PID/body evidence", async () => {
  const f = await fixture();
  try {
    const d = f.prepare();
    const s = await f.service.submit(submit(d));
    assert.equal(s.drafts[0].status, "verified");
    assert.equal(f.counts.clicks, 1);
    assert.ok(s.drafts[0].submittedAt);
    await assert.rejects(f.service.submit(submit(s.drafts[0])), /只能核对/);
    assert.equal(f.service.publications()[0].threadId, "1000");
  } finally {
    await f.close();
  }
});
test("a forged receipt without the mutation checkpoint cannot be success", async () => {
  const f = await fixture();
  try {
    f.noCheckpoint = true;
    const s = await f.service.submit(submit(f.prepare()));
    assert.equal(s.drafts[0].status, "draft");
    assert.equal(s.drafts[0].submittedAt, null);
  } finally {
    await f.close();
  }
});
test("disconnect and mismatched identity retain unknown; reconcile never republishes", async () => {
  const f = await fixture();
  try {
    f.failure = new Error("提交后断线");
    const s = await f.service.submit(submit(f.prepare())),
      d = s.drafts[0];
    assert.equal(d.status, "uncertain");
    assert.ok(d.submittedAt);
    await assert.rejects(f.service.submit(submit(d)), /只能核对/);
    f.failure = undefined;
    f.mismatch = true;
    assert.equal(
      (await f.service.reconcile({ id: d.id })).drafts[0].status,
      "uncertain",
    );
    f.mismatch = false;
    assert.equal(
      (await f.service.reconcile({ id: d.id })).drafts[0].status,
      "verified",
    );
    assert.equal(f.counts.publishes, 1);
    assert.equal(f.counts.reconciles, 2);
  } finally {
    await f.close();
  }
});
test("review state is distinct, read-only reconcilable and blocks further UID writes", async () => {
  const f = await fixture();
  try {
    f.review = true;
    const s = await f.service.submit(submit(f.prepare()));
    assert.equal(s.drafts[0].status, "pending_review");
    f.time += 61000;
    const next = f.prepare();
    await assert.rejects(f.service.submit(submit(next)), /结果待核对/);
    f.review = false;
    assert.equal(
      (await f.service.reconcile({ id: s.drafts[0].id })).drafts.find(
        (d) => d.id === s.drafts[0].id,
      )?.status,
      "verified",
    );
  } finally {
    await f.close();
  }
});
test("same-UID relogin recovers an old unknown read-only while another UID remains blocked", async () => {
  const f = await fixture();
  try {
    f.failure = new Error("断线");
    const d = (await f.service.submit(submit(f.prepare()))).drafts[0];
    f.environments.invalidateIdentity({ kind: "website", id: f.account.id });
    f.failure = undefined;
    assert.equal(
      (await f.service.reconcile({ id: d.id })).drafts[0].status,
      "verified",
    );
    assert.equal(f.counts.reconciles, 1);
    assert.equal(f.counts.publishes, 1);
  } finally {
    await f.close();
  }
  const other = await fixture();
  try {
    other.failure = new Error("断线");
    const d = (await other.service.submit(submit(other.prepare()))).drafts[0];
    other.environments.invalidateIdentity({
      kind: "website",
      id: other.account.id,
    });
    other.uid = "999";
    await assert.rejects(other.service.reconcile({ id: d.id }), /原账号登录/);
    assert.equal(other.counts.reconciles, 0);
    assert.equal(other.service.snapshot().drafts[0].status, "uncertain");
  } finally {
    await other.close();
  }
});
test("explicit local save can rebind an unsubmitted draft only to a refreshed target of the same UID/forum", async () => {
  const f = await fixture();
  try {
    const d = f.prepare();
    f.environments.invalidateIdentity({ kind: "website", id: f.account.id });
    assert.throws(
      () =>
        f.service.save({
          id: d.id,
          version: d.version,
          targetId: d.targetId,
          title: d.title,
          body: d.body,
          source,
        }),
      /环境/,
    );
    const t = f.targets.targets()[0];
    f.targets.saveTarget({
      ...t,
      stamp: f.environments.stamp({ kind: "website", id: f.account.id }),
    });
    const saved = f.service.save({
      id: d.id,
      version: d.version,
      targetId: d.targetId,
      title: d.title,
      body: d.body,
      source,
    }).drafts[0];
    assert.equal(saved.status, "ready");
    assert.deepEqual(
      f.service.store.draft(d.id)?.stamp,
      f.environments.stamp({ kind: "website", id: f.account.id }),
    );
    assert.equal(f.counts.publishes, 0);
  } finally {
    await f.close();
  }
});
test("target pause during upload revokes final publish and keeps mutation checkpoint", async () => {
  const f = await fixture();
  try {
    f.during = () => {
      const t = f.targets.targets()[0];
      f.targets.saveTarget({ ...t, paused: true, pauseReason: "用户暂停" });
    };
    const s = await f.service.submit(submit(f.prepare()));
    assert.equal(s.drafts[0].status, "uncertain");
    assert.ok(s.drafts[0].submittedAt);
    assert.equal(f.counts.clicks, 0);
    assert.match(s.drafts[0].message, /用户暂停/);
  } finally {
    await f.close();
  }
});
test("changed website UID before queued submission prevents checkpoint and click", async () => {
  const f = await fixture();
  try {
    const d = f.prepare();
    f.uid = "999";
    const s = await f.service.submit(submit(d));
    assert.equal(s.drafts[0].submittedAt, null);
    assert.equal(f.counts.publishes, 0);
  } finally {
    await f.close();
  }
});
test("cross-account body reuse and per-UID daily limit cannot be replayed", async () => {
  const f = await fixture();
  try {
    const d = f.prepare();
    await f.service.submit(submit(d));
    f.time += 61000;
    const next = f.prepare();
    await assert.rejects(f.service.submit(submit(next)), /不重复发布/);
    const raw = f.service.store.draft(next.id)!;
    raw.body = text + "请为各个目录设置明确的入口。";
    f.service.save({
      id: raw.id,
      version: raw.version,
      targetId: raw.targetId,
      title: raw.title,
      body: raw.body,
      source,
    });
    await assert.rejects(
      f.service.submit(submit(f.service.snapshot().drafts[0])),
      /今日已达/,
    );
    assert.equal(
      topicFingerprint(text),
      topicFingerprint(" " + text.replaceAll("，", ",") + " "),
    );
  } finally {
    await f.close();
  }
});
test("global M1/M2 interval and unknown blocking apply to topics", async () => {
  const f = await fixture();
  try {
    const d = f.prepare();
    f.db.run(
      "INSERT INTO tieba_reply_drafts(id,candidate_id,uid,thread_id,status,version,submitted_at,data) VALUES('reply_fixture','x',?,'123','verified',1,?,'{}')",
      "222",
      new Date(f.time - 1000).toISOString(),
    );
    await assert.rejects(f.service.submit(submit(d)), /不足60秒/);
    f.time += 61000;
    f.db.run(
      "UPDATE tieba_reply_drafts SET uid=?,status='uncertain' WHERE id='reply_fixture'",
      "111",
    );
    await assert.rejects(f.service.submit(submit(d)), /仍有签到或回帖/);
    assert.equal(f.counts.publishes, 0);
  } finally {
    await f.close();
  }
});
test("same body on a different managed account is blocked before another publication", async () => {
  const f = await fixture();
  try {
    await f.service.submit(submit(f.prepare()));
    f.time += 61000;
    const other = await f.otherDraft();
    await assert.rejects(f.service.submit(submit(other)), /不重复发布/);
    assert.equal(f.counts.publishes, 1);
  } finally {
    await f.close();
  }
});
test("only current Beijing-day sign uncertainty blocks topics; older unknown sign is retained", async () => {
  for (const day of ["2026-11-06", "2026-11-07"]) {
    const f = await fixture();
    try {
      const d = f.prepare();
      f.db.run(
        "INSERT INTO tieba_autocare_tasks(id,target_id,uid,forum_id,day,action,status,planned_at,deadline_at,submitted_at,data) VALUES('sign_fixture',?,?,?,?,'sign','uncertain',?,?,?,?)",
        d.targetId,
        d.uid,
        d.forumId,
        day,
        new Date(f.time - 86400000).toISOString(),
        new Date(f.time - 100000).toISOString(),
        new Date(f.time - 86400000).toISOString(),
        JSON.stringify({ accountId: d.accountId }),
      );
      if (day === "2026-11-07")
        await assert.rejects(f.service.submit(submit(d)), /仍有签到或回帖/);
      else
        assert.equal(
          (await f.service.submit(submit(d))).drafts[0].status,
          "verified",
        );
      assert.equal(
        f.db.get<{ status: string }>(
          "SELECT status FROM tieba_autocare_tasks WHERE id='sign_fixture'",
        )?.status,
        "uncertain",
      );
    } finally {
      await f.close();
    }
  }
});
test("long image preparation refreshes shared mutation interval without losing original checkpoint", async () => {
  const f = await fixture();
  try {
    const d = f.prepare(),
      first = f.time;
    f.during = () => {
      f.time += 90000;
    };
    const s = await f.service.submit(submit(d));
    assert.equal(s.drafts[0].status, "verified");
    assert.equal(s.drafts[0].submittedAt, new Date(first).toISOString());
    assert.equal(
      f.db.get<{ submitted_at: string }>(
        "SELECT submitted_at FROM tieba_topic_drafts WHERE id=?",
        d.id,
      )?.submitted_at,
      new Date(f.time).toISOString(),
    );
    const next = f.prepare();
    const n = f.service.save({
      id: next.id,
      version: next.version,
      targetId: next.targetId,
      title: next.title,
      body: next.body + "每个入口再写一段使用说明。",
      source,
    }).drafts[0];
    await assert.rejects(f.service.submit(submit(n)), /不足60秒/);
  } finally {
    await f.close();
  }
});
test("AI creates only a reviewable draft and preserves paid uncertain request", async () => {
  const f = await fixture();
  try {
    let d = f.prepare();
    const s = await f.service.generate(submit(d));
    d = s.drafts[0];
    assert.equal(d.status, "ready");
    assert.equal(d.aiGenerated, true);
    assert.equal(f.counts.calls, 1);
    assert.equal(f.counts.publishes, 0);
    f.aiFailure = new Error("AI transport断线");
    const unknown = (await f.service.generate(submit(d))).drafts[0];
    assert.equal(unknown.status, "attention");
    assert.equal(unknown.generationAttempts, 2);
    await assert.rejects(f.service.generate(submit(unknown)), /明确生成/);
    assert.equal(f.counts.calls, 2);
  } finally {
    await f.close();
  }
});
test("local PNG attachment cancel/import/read/hash check/version/remove remain persistent", async () => {
  const f = await fixture();
  try {
    let d = f.prepare();
    let s = await f.service.pickImages({ id: d.id, version: d.version });
    assert.equal(s.drafts[0].version, d.version);
    f.selected = [{ name: "资料截图.png", bytes: png }];
    s = await f.service.pickImages({ id: d.id, version: d.version });
    d = s.drafts[0];
    assert.equal(d.images.length, 1);
    assert.match(
      await f.service.image({ id: d.id, imageId: d.images[0].id }),
      /^data:image\/png;base64,/,
    );
    f.reopen();
    assert.equal(f.service.snapshot().drafts[0].images.length, 1);
    await writeFile(join(f.dir, "content-assets", d.images[0].file), "changed");
    s = await f.service.submit(submit(d));
    assert.equal(s.drafts[0].submittedAt, null);
    assert.equal(f.counts.publishes, 0);
    s = f.service.removeImage({
      id: d.id,
      version: d.version + 1,
      imageId: d.images[0].id,
    });
    assert.equal(s.drafts[0].images.length, 0);
  } finally {
    await f.close();
  }
});
test("restart and backup stop claims while retaining unknown and paid checkpoints", async () => {
  const f = await fixture();
  try {
    const d = f.prepare(),
      raw = f.service.store.draft(d.id)!;
    raw.status = "submitting";
    raw.submittedAt = new Date(f.time).toISOString();
    f.service.store.save(raw);
    f.reopen();
    assert.equal(f.service.snapshot().drafts[0].status, "uncertain");
    const next = f.prepare(),
      n = f.service.store.draft(next.id)!;
    n.status = "generating";
    f.service.store.save(n);
    f.service.store.saveGeneration({
      id: "gen_fixture",
      draftId: n.id,
      status: "reserved",
      createdAt: n.createdAt,
      message: "",
    });
    stopTiebaTopicsForBackup(f.db);
    assert.equal(
      f.service.snapshot().drafts.find((r) => r.id === n.id)?.status,
      "attention",
    );
    assert.equal(f.service.store.generations()[0].status, "uncertain");
    assert.equal(
      f.service.snapshot().drafts.find((r) => r.id === d.id)?.submittedAt,
      raw.submittedAt,
    );
  } finally {
    await f.close();
  }
});

test("资源发帖未知时养号主题不提交，核实后仍遵守提交间隔", async () => {
  const f = await fixture();
  try {
    const draft = f.prepare();
    const post = {
      id: "tiebapublishing_guard",
      uid: draft.uid,
      status: "uncertain",
      submittedAt: new Date(f.time).toISOString(),
    };
    f.db.setSetting(tiebaPublishingIndexKey, [post.id]);
    f.db.setSetting(`tieba-publishing:draft:v1:${post.id}`, post);
    await assert.rejects(f.service.submit(submit(draft)), {
      code: "TIEBA_PUBLISHING_UNCERTAIN_BLOCK",
    });
    assert.equal(f.counts.clicks, 0);
    post.status = "verified";
    f.db.setSetting(`tieba-publishing:draft:v1:${post.id}`, post);
    await assert.rejects(f.service.submit(submit(draft)), {
      code: "TIEBA_TOPIC_INTERVAL",
    });
    assert.equal(f.counts.clicks, 0);
  } finally {
    await f.close();
  }
});
