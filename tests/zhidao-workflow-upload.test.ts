import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { publishingFixture } from "./zhidao-publish-fixture";
import { file } from "./helpers";
import type { DriveProvider } from "../core/providers/provider";
import {
  publishingRowsWithLinks,
  publishingSelectionRevision,
  publishingTaskName,
} from "../shared/zhidao-workflow";

async function readyFixture(count = 3) {
  const f = await publishingFixture();
  try {
    let account = await f.invoke("account.add", {
      provider: "baidu",
      alias: "资料网盘",
    });
    await f.invoke("account.check", { id: account.id });
    account = f.service.repo.getAccount(account.id);
    const saved = (await f.service.invoke("resource.save", {
      title: "表格练习",
      sourceText: "https://pan.baidu.com/s/fixture-source",
      category: "效率办公",
      tags: [],
      summary: "包含表格整理、数据核对和月报练习。",
      accountId: account.id,
      directory: "/练习",
      selectedFiles: [file],
      enqueue: false,
      rightsConfirmed: true,
    })) as { resourceId: string; copyId: string };
    f.service.db.run(
      "UPDATE copies SET status='ready',files=?,owner_uid=?,verified_at=?,share_id='canonical',share_url='https://pan.baidu.com/s/canonical',share_owner_uid=?,share_verified_at=? WHERE id=?",
      JSON.stringify([file]),
      account.uid,
      new Date().toISOString(),
      account.uid,
      new Date().toISOString(),
      saved.copyId,
    );
    await f.service.secrets.set(`share:${saved.copyId}`, "abcd");
    let creates = 0;
    (f.provider as DriveProvider).createShareWithOptions = async (
      _a,
      _files,
      _title,
      options,
    ) => ({
      id: `share-${++creates}`,
      url: `https://pan.baidu.com/s/new${creates}`,
      code: options.extractionCode!,
      ownerUid: account.uid!,
    });
    const resource = {
      key: randomUUID(),
      resourceId: saved.resourceId,
      copyId: saved.copyId,
      title: "表格练习",
      link: "https://pan.baidu.com/s/fixture-source",
      category: "效率办公",
      summary: "包含表格整理、数据核对和月报练习。",
      keywords: ["表格整理", "数据核对", "月报练习"].slice(0, count),
    };
    const [plan] = f.service.zhidaoWorkflow.planMany([resource]);
    f.service.db.setSetting(`zhidao-publishing-resource:${plan.id}`, {
      ...plan,
      linkedAnswerFormat: true,
      generation: {
        id: randomUUID(),
        status: "completed",
        targets: [],
        drafts: [],
      },
      rows: resource.keywords.map((keyword) => ({
        id: randomUUID(),
        keyword,
        relatedKeywords: [],
        question: `${keyword}材料的百度网盘链接在哪？`,
        answer: `<p>这些办公材料包括${keyword}，可以结合现有表格和月报练习安排使用。</p>`,
        reviewed: true,
      })),
    });
    await f.service.zhidaoWorkflow.prepare(resource, "");
    const record = await f.service.zhidaoWorkflow.shares(plan.id);
    const submit = (
      overrides: Partial<
        import("../shared/ipc").IpcArgs<"zhidao.workflow.publish">
      > = {},
    ) =>
      f.invoke("zhidao.workflow.publish", {
        ids: [record.id],
        accountId: f.account.id,
        taskName: "五步上传验收",
        authorized: true,
        selectionRevision: publishingSelectionRevision([record]),
        ...overrides,
      });
    return { ...f, record, submit, creates: () => creates };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}

test("五步真实组装：3条问答直接生成一份表格上传一次，重复调用及刷新返回同一任务", async () => {
  const f = await readyFixture();
  try {
    const [a, b] = await Promise.all([f.submit(), f.submit()]);
    assert.equal(a.id, b.id);
    await f.service.zhidao.settled(a.id);
    const run = f.service.zhidao.store.run(a.id);
    assert.equal(run.status, "completed");
    assert.equal(run.done, 3);
    const uploads = f.events.filter((e) => e.type === "upload");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].accountId, f.account.id);
    assert.deepEqual(uploads[0].rows, [
      ["qid", "问题标题", "回答内容"],
      ...publishingRowsWithLinks(f.record).map((r) => [
        "",
        r.question,
        r.answer,
      ]),
    ]);
    assert.equal(
      f.service.zhidaoWorkflow.get(f.record.id).publicationRunId,
      run.id,
    );
    assert.equal((await f.submit()).id, run.id);
    assert.equal(f.events.filter((e) => e.type === "upload").length, 1);
    assert.equal(f.creates(), 2, "上传不另外创建分享");
    const audit = await f.invoke("zhidao.publish.sync", { id: run.id });
    assert.equal((audit.config.platformTasks as any[]).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("五步上传阻止未确认、过期版本、非法账号和缺少授权，失败不遗留上传源或误发", async () => {
  const f = await readyFixture();
  try {
    const before = f.service.db.get<{ n: number }>(
      "SELECT count(*) n FROM operation_runs",
    )!.n;
    await assert.rejects(() => f.submit({ selectionRevision: "old" }), {
      code: "SELECTION_CHANGED",
    });
    await assert.rejects(() => f.submit({ accountId: "missing" }));
    assert.equal(
      f.service.db.get<{ n: number }>("SELECT count(*) n FROM operation_runs")!
        .n,
      before,
    );
    await assert.rejects(() =>
      f.service.invoke("zhidao.workflow.publish", {
        ids: [f.record.id],
        accountId: f.account.id,
        taskName: "未授权",
        selectionRevision: publishingSelectionRevision([f.record]),
      }),
    );
    f.service.zhidaoWorkflow.saveRows(
      f.record.id,
      f.record.rows.map((r) => ({ ...r, reviewed: false })),
      f.record.generation!.id,
    );
    await assert.rejects(() => f.submit(), { code: "SELECTION_CHANGED" });
    await assert.rejects(
      () =>
        f.submit({
          selectionRevision: publishingSelectionRevision([
            f.service.zhidaoWorkflow.get(f.record.id),
          ]),
        }),
      { code: "REVIEW_REQUIRED" },
    );
    assert.equal(f.events.filter((e) => e.type === "upload").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("五步上传实时检查额度，额度失败及响应未知时保留原任务且不自动重发", async () => {
  for (const mode of ["quota", "unknown"] as const) {
    const f = await readyFixture();
    try {
      if (mode === "quota") f.state.rights.quota = 0;
      else f.state.mode = "unknown";
      const started = await f.submit();
      await f.service.zhidao.settled(started.id);
      const n = f.events.filter((e) => e.type === "upload").length;
      assert.equal(n, mode === "quota" ? 0 : 1);
      assert.equal((await f.submit()).id, started.id);
      assert.equal(
        f.service.zhidaoWorkflow.get(f.record.id).publicationRunId,
        started.id,
      );
      assert.equal(f.events.filter((e) => e.type === "upload").length, n);
      if (mode === "unknown")
        assert.ok(
          f.service.zhidao.store
            .items(started.id)
            .every((i) => i.status === "uncertain"),
        );
    } finally {
      await f.cleanup();
    }
  }
});

test("上传任务创建后另一个窗口改动正文，发送前再次校验并阻止旧内容上传", async () => {
  const f = await readyFixture();
  let release!: () => void;
  try {
    f.state.identityGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = await f.submit();
    f.service.zhidaoWorkflow.saveRows(
      f.record.id,
      f.record.rows.map((row, index) =>
        index === 0
          ? { ...row, question: "表格整理资料的百度网盘分享地址在哪？" }
          : row,
      ),
      f.record.generation!.id,
    );
    release();
    await f.service.zhidao.settled(run.id);
    assert.equal(f.events.filter((e) => e.type === "upload").length, 0);
    assert.match(
      f.service.zhidao.store.run(run.id).message,
      /问答或独立链接已变化/,
    );
  } finally {
    release?.();
    await f.cleanup();
  }
});

test("任务名依据资源生成，保留书名、资源数量，长中文及Emoji不超过15字", () => {
  assert.equal(
    publishingTaskName(["《限时营救》正式版1080P百度分享"]),
    "《限时营救》问答",
  );
  assert.equal(
    publishingTaskName(["办公表格练习", "预算整理练习"]),
    "办公表格练习等2份问答",
  );
  assert.equal(
    publishingTaskName(["英语语法宝典百度网盘分享"]),
    "英语语法宝典问答",
  );
  for (const titles of [
    ["很长的中文资源名称".repeat(10)],
    ["🎬资料".repeat(10), "其他"],
    [],
  ]) {
    const name = publishingTaskName(titles);
    assert.ok(name.length <= 15 && name.length > 0);
    assert.equal(name.includes("\ud83c问答"), false);
  }
});

test("已上传的五步问答也不能通过已有问答入口换号重复发送相同URL", async () => {
  const f = await readyFixture();
  try {
    const run = await f.submit();
    await f.service.zhidao.settled(run.id);
    const original = f.service.zhidao.store.run(run.id).config
      .itemIds as string[];
    const other = await f.invoke("zhidao.account.add", { alias: "另一答主" });
    f.state.identity = "other-publisher";
    await f.invoke("zhidao.account.check", { id: other.id });
    await assert.rejects(
      () =>
        f.invoke("zhidao.start", {
          kind: "publish",
          authorized: true,
          input: {
            accountId: other.id,
            taskName: "重复提交",
            itemIds: original,
          },
        }),
      { code: "URL_ALREADY_SUBMITTED" },
    );
    assert.equal(f.events.filter((e) => e.type === "upload").length, 1);
  } finally {
    await f.cleanup();
  }
});

function publishedEntry(
  f: Awaited<ReturnType<typeof readyFixture>>,
  options: { landing?: boolean; enabled?: boolean; revision?: number } = {},
) {
  const resourceId = f.record.libraryResourceId,
    version = options.revision ?? 1;
  const entry = {
    id: "qa-public-link",
    resourceId,
    slug: "workflow123",
    baseUrl: "https://panxu.site",
    state: "synced",
    enabled: options.enabled ?? true,
    targetUrl: f.record.canonicalShare!.url,
    revision: version,
    syncedAt: new Date().toISOString(),
    operationId: null,
  };
  f.service.db.run(
    "INSERT INTO resource_links(id,resource_id,slug,base_url,data) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET data=excluded.data",
    entry.id,
    resourceId,
    entry.slug,
    entry.baseUrl,
    JSON.stringify(entry),
  );
  f.service.db.run(
    "INSERT INTO resource_landing_pages(resource_id,data) VALUES(?,?) ON CONFLICT(resource_id) DO UPDATE SET data=excluded.data",
    resourceId,
    JSON.stringify({
      published: options.landing === false ? null : { version, document: {} },
      pending: null,
    }),
  );
}

test("单条问答复用已发布落地页或直达链接，导出和上传正文一致，不建新链接或发布页面", async () => {
  for (const linkType of ["landing", "redirect"] as const) {
    const f = await readyFixture(1);
    try {
      publishedEntry(f);
      const options = await f.invoke("zhidao.workflow.linkOptions", {
        ids: [f.record.id],
      });
      const url =
        linkType === "landing" ? options.landingUrl! : options.redirectUrl!;
      await f.invoke("zhidao.workflow.export", {
        ids: [f.record.id],
        linkType,
        linkRevision: options.revision,
      });
      const { readXlsx } = await import("../core/table-files");
      const exported = readXlsx(Buffer.from(f.downloads[0]));
      assert.ok(exported[1][2].includes(url));
      assert.ok(!exported[1][2].includes("?pwd="));
      const run = await f.submit({ linkType, linkRevision: options.revision });
      await f.service.zhidao.settled(run.id);
      const uploads = f.events.filter((e) => e.type === "upload");
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0].rows, exported);
      assert.equal(
        f.service.zhidao.store.run(run.id).config.workflowLinkType,
        linkType,
      );
      assert.equal(f.creates(), 0);
      assert.equal(
        f.service.repo.getCopy(f.record.copyId).shareUrl,
        f.record.canonicalShare!.url,
      );
      assert.equal(
        (await f.submit({ linkType, linkRevision: options.revision })).id,
        run.id,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("多条问答从前后端契约拒绝落地页和直达模式，保持独立网盘链接", async () => {
  const f = await readyFixture();
  try {
    await assert.rejects(
      () => f.invoke("zhidao.workflow.linkOptions", { ids: [f.record.id] }),
      { code: "SINGLE_QUESTION_REQUIRED" },
    );
    for (const linkType of ["landing", "redirect"] as const) {
      await assert.rejects(
        () =>
          f.invoke("zhidao.workflow.export", {
            ids: [f.record.id],
            linkType,
            linkRevision: "invalid",
          }),
        { code: "SINGLE_QUESTION_REQUIRED" },
      );
      await assert.rejects(
        () => f.submit({ linkType, linkRevision: "invalid" }),
        { code: "SINGLE_QUESTION_REQUIRED" },
      );
    }
    assert.equal(f.events.filter((e) => e.type === "upload").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("公共入口缺失、页面未发布、入口停用或版本变化时阻断，不退回网盘直链", async () => {
  const f = await readyFixture(1);
  try {
    let options = await f.invoke("zhidao.workflow.linkOptions", {
      ids: [f.record.id],
    });
    assert.equal(options.redirectUrl, null);
    await assert.rejects(
      () => f.submit({ linkType: "redirect", linkRevision: options.revision }),
      { code: "PUBLIC_LINK_NOT_READY" },
    );
    publishedEntry(f, { landing: false });
    options = await f.invoke("zhidao.workflow.linkOptions", {
      ids: [f.record.id],
    });
    assert.equal(options.landingUrl, null);
    assert.ok(options.redirectUrl);
    await assert.rejects(
      () => f.submit({ linkType: "landing", linkRevision: options.revision }),
      { code: "PUBLIC_LINK_NOT_READY" },
    );
    publishedEntry(f, { enabled: false });
    options = await f.invoke("zhidao.workflow.linkOptions", {
      ids: [f.record.id],
    });
    await assert.rejects(
      () => f.submit({ linkType: "redirect", linkRevision: options.revision }),
      { code: "PUBLIC_LINK_NOT_READY" },
    );
    publishedEntry(f);
    options = await f.invoke("zhidao.workflow.linkOptions", {
      ids: [f.record.id],
    });
    publishedEntry(f, { revision: 2 });
    await assert.rejects(
      () => f.submit({ linkType: "landing", linkRevision: options.revision }),
      { code: "PUBLIC_LINK_CHANGED" },
    );
    assert.equal(f.events.filter((e) => e.type === "upload").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("提交后公共入口版本变化，发送前再次拦截过期链接配置", async () => {
  const f = await readyFixture(1);
  let release!: () => void;
  try {
    publishedEntry(f);
    const options = await f.invoke("zhidao.workflow.linkOptions", {
      ids: [f.record.id],
    });
    f.state.identityGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = await f.submit({
      linkType: "redirect",
      linkRevision: options.revision,
    });
    publishedEntry(f, { revision: 2 });
    release();
    await f.service.zhidao.settled(run.id);
    assert.equal(f.events.filter((e) => e.type === "upload").length, 0);
    assert.match(f.service.zhidao.store.run(run.id).message, /资源入口已变化/);
  } finally {
    release?.();
    await f.cleanup();
  }
});

test("资源公共入口已有上传记录时，新批次也不能重复提交同一URL", async () => {
  const f = await readyFixture(1);
  try {
    publishedEntry(f);
    const options = await f.invoke("zhidao.workflow.linkOptions", {
      ids: [f.record.id],
    });
    const run = await f.submit({
      linkType: "landing",
      linkRevision: options.revision,
    });
    await f.service.zhidao.settled(run.id);
    const next = structuredClone(f.record),
      id = randomUUID(),
      rowId = randomUUID();
    next.id = id;
    next.resource.key = id;
    next.rows[0].id = rowId;
    next.rows[0].question = "办公练习资料的百度网盘链接在哪里？";
    next.rowShares = { [rowId]: next.links[0] };
    delete next.publicationRunId;
    f.service.db.setSetting(`zhidao-publishing-resource:${id}`, next);
    await assert.rejects(
      () =>
        f.submit({
          ids: [id],
          selectionRevision: publishingSelectionRevision([next]),
          linkType: "landing",
          linkRevision: options.revision,
        }),
      { code: "URL_ALREADY_SUBMITTED" },
    );
    assert.equal(f.events.filter((e) => e.type === "upload").length, 1);
  } finally {
    await f.cleanup();
  }
});
