import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, file } from "./helpers";
import { ShareCreation } from "../core/share-creation";
import type { DriveProvider } from "../core/providers/provider";
import type { DriveFiles } from "../core/drive-files";

test("问答额外分享只创建并保存回执，不定位目录、不拉取或匹配文件、不核验新链接", async () => {
  const f = await fixture();
  let creates = 0,
    unknown = false,
    connections = 0;
  try {
    const saved = await f.add(false);
    f.app.db.run(
      "UPDATE copies SET status='ready',files=?,owner_uid=?,verified_at='2026-11-19',share_url='https://pan.quark.cn/s/canonical' WHERE id=?",
      JSON.stringify([file]),
      f.provider.uid,
      saved.copyId,
    );
    const provider = f.provider as DriveProvider;
    provider.list = async () => assert.fail("额外分享不能读取目录清单");
    provider.verifyShare = async () =>
      assert.fail("额外分享不能重复核验文件或链接");
    provider.createShareWithOptions = async (
      _account,
      files,
      _title,
      options,
      _onCreated,
      verification,
    ) => {
      assert.equal(verification, "receipt");
      assert.deepEqual(files, [file]);
      creates++;
      if (unknown) throw new Error("响应中断");
      return {
        id: `variant-${creates}`,
        url: `https://pan.quark.cn/s/variant${creates}`,
        code: options.extractionCode || "abcd",
        ownerUid: f.provider.uid,
      };
    };
    const service = new ShareCreation({
      withSession: async (_id, action) => {
        connections++;
        return action();
      },
      repo: f.app.repo,
      secrets: f.app.secrets,
      driveFiles: {
        locateCopy: async () => assert.fail("额外分享不能重复定位、匹配原文件"),
      } as unknown as DriveFiles,
      hasRunningJobs: () => service.isBusy,
      assertIdle: () => {},
      assertMutable: () => {},
      changed: () => {},
      authenticated: async (_id, action) =>
        action(f.app.repo.getAccount(f.account.id), provider),
    });
    const input = {
      operationId: randomUUID(),
      copyId: saved.copyId,
      expiresInDays: 0,
    };
    assert.equal((await service.createIndependent(input)).state, "success");
    assert.equal((await service.createIndependent(input)).state, "success");
    assert.equal(creates, 1);
    assert.equal(
      f.app.repo.getCopy(saved.copyId).shareUrl,
      "https://pan.quark.cn/s/canonical",
    );
    await service.withIndependentSession(saved.copyId, async () => {
      assert.equal(service.busyAccount(f.account.id), true);
      for (let i = 0; i < 19; i++)
        assert.equal(
          (
            await service.createIndependent({
              ...input,
              operationId: randomUUID(),
            })
          ).state,
          "success",
        );
    });
    assert.equal(connections, 1);
    assert.equal(creates, 20);
    assert.equal(service.isBusy, false);
    await assert.rejects(
      () =>
        service.withIndependentSession(saved.copyId, async () => {
          throw new Error("测试连接中断");
        }),
      /测试连接中断/,
    );
    assert.equal(service.isBusy, false, "异常退出释放批次，不锁死后续操作");
    unknown = true;
    const next = { ...input, operationId: randomUUID() };
    assert.equal((await service.createIndependent(next)).state, "uncertain");
    assert.equal((await service.recheck(next.operationId)).state, "uncertain");
    assert.equal((await service.createIndependent(next)).state, "uncertain");
    assert.equal(creates, 21, "未知回执不能重发");
  } finally {
    await f.cleanup();
  }
});

test("真实服务组装：拓词和分享读取窗口保留打开时，3条已确认问答仍可补足独立链接且不重复创建", async () => {
  const f = await fixture();
  let creates = 0;
  try {
    const account = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "发布账号",
    })) as import("../shared/types").Account;
    await f.app.invoke("account.check", { id: account.id });
    const saved = await f.add(false, {
      accountId: account.id,
      sourceText: "https://pan.baidu.com/s/source-fixture",
    });
    f.app.db.run(
      "UPDATE copies SET status='ready',files=?,owner_uid=?,verified_at=?,share_id='canonical',share_url='https://pan.baidu.com/s/canonical',share_owner_uid=?,share_verified_at=? WHERE id=?",
      JSON.stringify([file]),
      f.provider.uid,
      new Date().toISOString(),
      f.provider.uid,
      new Date().toISOString(),
      saved.copyId,
    );
    await f.app.secrets.set(`share:${saved.copyId}`, "abcd");
    (f.provider as DriveProvider).createShareWithOptions = async (
      _account,
      files,
      _title,
      options,
      _created,
      verification,
    ) => {
      assert.equal(verification, "receipt");
      assert.deepEqual(files, [file]);
      creates++;
      return {
        id: `independent-${creates}`,
        url: `https://pan.baidu.com/s/variant${creates}`,
        code: options.extractionCode!,
        ownerUid: f.provider.uid,
      };
    };
    const resource = {
      key: randomUUID(),
      resourceId: saved.resourceId,
      copyId: saved.copyId,
      title: "办公练习",
      category: "效率办公",
      link: "https://pan.baidu.com/s/source-fixture",
      summary: "包含表格整理、数据核对和月报练习。",
      keywords: ["表格整理", "数据核对", "月报练习"],
    };
    const [planned] = f.app.zhidaoWorkflow.planMany([resource]);
    f.app.db.setSetting(`zhidao-publishing-resource:${planned.id}`, {
      ...planned,
      copyId: saved.copyId,
      accountId: account.id,
      stage: "sharing",
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
        question: `${keyword}材料的百度网盘在哪里？`,
        answer: `<p>这份办公练习包括${keyword}，可结合现有表格整理和月报内容安排练习。</p>`,
        reviewed: true,
      })),
    });
    // These three ports report both active requests and passive visible windows.
    f.ports.keywordWebBrowser = {
      isOpen: () => true,
      open: async () => {},
      close: () => {},
      check: async () => {},
    };
    f.ports.baiduDiscovery = {
      isOpen: () => true,
      close: () => {},
    } as NonNullable<typeof f.ports.baiduDiscovery>;
    f.ports.baiduShareReader = {
      isOpen: () => true,
      close: () => {},
    } as NonNullable<typeof f.ports.baiduShareReader>;
    assert.throws(
      () => f.app.assertUpdateIdle(),
      { code: "UPDATE_TASKS_RUNNING" },
      "更新仍需等待这些既有窗口，不改变重启保护",
    );
    const queued = await f.add(true, {
      title: "其他排队资源",
      accountId: account.id,
      sourceText: "https://pan.baidu.com/s/another-source",
    });
    await assert.rejects(
      () =>
        f.app.invoke("zhidao.workflow.shares", {
          id: planned.id,
          authorized: true,
        }),
      { code: "ACTIVE_JOBS" },
      "真正存在转存任务时仍然阻止建链",
    );
    assert.equal(creates, 0);
    await f.app.invoke("job.cancel", { id: queued.jobId });
    assert.equal(
      f.app.zhidaoWorkflow.get(planned.id).links.length,
      1,
      "失败后保留常规分享，重试只补足剩余两条",
    );
    const ready = (await f.app.invoke("zhidao.workflow.shares", {
      id: planned.id,
      authorized: true,
    })) as import("../shared/zhidao-workflow").PublishingRecord;
    assert.equal(ready.stage, "ready");
    assert.equal(ready.links.length, 3);
    assert.equal(creates, 2);
    assert.equal(
      new Set(Object.values(ready.rowShares!).map((link) => link.url)).size,
      3,
    );
    await f.app.invoke("zhidao.workflow.shares", {
      id: planned.id,
      authorized: true,
    });
    assert.equal(creates, 2);
    assert.equal(f.app.shareCreation.isBusy, false);
    assert.equal(
      f.app.repo.getCopy(saved.copyId).shareUrl,
      "https://pan.baidu.com/s/canonical",
    );
  } finally {
    await f.cleanup();
  }
});
