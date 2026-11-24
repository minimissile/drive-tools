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
