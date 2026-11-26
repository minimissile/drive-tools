import test from "node:test";
import assert from "node:assert/strict";
import { file, fixture, TestProvider } from "./helpers";
import { driveLinkCodeKey } from "../core/resource-drive-links";
import { removeResourceRecords } from "../core/resource-records";
import type { DriveProvider } from "../core/providers/provider";
import type { Account, ResourcePage, ShareInput } from "../shared/types";
import type { ResourceDriveLink } from "../shared/resource-drive-links";

async function setup() {
  const connector = new TestProvider();
  connector.ownUrl = "https://pan.baidu.com/s/1verifiedOwn";
  const received: ShareInput[] = [];
  const provider: DriveProvider = connector;
  const transfer = provider.transfer.bind(provider);
  provider.transfer = (...args) => {
    received.push(args[1]);
    return transfer(...args);
  };
  const f = await fixture({ baidu: provider });
  const baidu = (await f.app.invoke("account.add", {
    provider: "baidu",
    alias: "百度资料账号",
  })) as Account;
  await f.app.invoke("account.check", { id: baidu.id });
  const saved = await f.add(false);
  const resourceId = saved.resourceId;
  const text = "百度网盘：https://pan.baidu.com/s/1external\n提取码：8002";
  const start = (overrides: Record<string, unknown> = {}) =>
    f.app.invoke("resource.transferDriveLink", {
      resourceId,
      text,
      accountId: baidu.id,
      directory: "/盘序资料",
      selectedFiles: [file],
      ...overrides,
    }) as Promise<{ copyId: string; jobId: string }>;
  const links = () =>
    f.app.invoke("resource.driveLinks", { resourceId }) as Promise<
      ResourceDriveLink[]
    >;
  return { ...f, connector, baidu, saved, resourceId, received, start, links };
}

test("补充网盘走转存、归属核验与建链，在同一资源中复制本人分享", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.start({ accountId: f.account.id }), {
      code: "CROSS_PROVIDER_UNSUPPORTED",
    });
    await assert.rejects(f.start({ selectedFiles: [] }));
    const { copyId, jobId } = await f.start();
    assert.notEqual(copyId, f.saved.copyId);
    const [pending] = await f.links();
    assert.equal(pending.shareUrl, null);
    assert.equal(pending.status, "queued");
    assert.equal(pending.jobId, jobId);
    assert.equal(f.app.repo.resourceTotals().resources, 1);
    assert.equal(f.app.repo.getResource(f.resourceId).copies.length, 2);
    assert.equal(f.connector.transfers, 0);
    await assert.rejects(f.app.invoke("copy.link", { copyId }), {
      code: "SHARE_NOT_READY",
    });
    await assert.rejects(f.start(), { code: "RESOURCE_DRIVE_TRANSFER_EXISTS" });
    await assert.rejects(
      f.app.invoke("resource.removeDriveLink", {
        resourceId: f.resourceId,
        linkId: pending.id,
      }),
      { code: "RESOURCE_DRIVE_TRANSFER_EXISTS" },
    );
    await f.app.queue.execute(jobId);
    const [ready] = await f.links();
    assert.equal(f.app.repo.getJob(jobId).stage, "completed");
    assert.equal(ready.shareUrl, f.connector.ownUrl);
    assert.equal(ready.status, "ready");
    assert.equal(f.connector.transfers, 1);
    assert.equal(f.connector.shares, 1);
    assert.deepEqual(
      f.received.map(({ url, code, provider }) => ({ url, code, provider })),
      [
        {
          url: "https://pan.baidu.com/s/1external",
          code: "8002",
          provider: "baidu",
        },
      ],
    );
    assert.deepEqual(await f.app.invoke("copy.link", { copyId }), {
      text: `${f.connector.ownUrl}?pwd=test`,
    });
    const original = f.app.repo.getResource(f.resourceId);
    assert.equal(original.provider, "quark");
    assert.equal(original.sourceUrl, "https://pan.quark.cn/s/source123");
    assert.equal(
      original.copies.find((c) => c.id === f.saved.copyId)?.shareUrl,
      null,
    );
    const page = (await f.app.invoke("resource.page", {
      provider: "baidu",
      accountId: f.baidu.id,
    })) as ResourcePage;
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, f.resourceId);
    await f.add(false, {
      id: f.resourceId,
      copyId,
      accountId: f.baidu.id,
      sourceText: "https://pan.baidu.com/s/1external",
      summary: "编辑公共资料",
    });
    assert.equal(f.app.repo.getResource(f.resourceId).summary, "编辑公共资料");
    assert.equal(f.app.repo.getResource(f.resourceId).copies.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("旧的外部链接可继续转存，重试不重复请求，删除资源清理来源凭据", async () => {
  const f = await setup();
  try {
    const legacyId = "pending-source";
    const legacyUrl = "https://pan.baidu.com/s/1legacy";
    f.app.db.run(
      "INSERT INTO resource_drive_links(id,resource_id,provider,url,needs_code) VALUES(?,?,'baidu',?,1)",
      legacyId,
      f.resourceId,
      legacyUrl,
    );
    await f.app.secrets.set(driveLinkCodeKey(legacyId), "8002");
    const [legacy] = await f.links();
    assert.equal(legacy.copyId, null);
    assert.equal(legacy.shareUrl, null);
    await f.app.invoke("share.inspect", {
      resourceId: f.resourceId,
      sourceLinkId: legacyId,
      sourceText: legacyUrl,
      accountId: f.baidu.id,
    });
    const { jobId } = await f.start({ text: legacyUrl, replaceId: legacyId });
    const [source] = await f.links();
    assert.equal(await f.app.secrets.get(driveLinkCodeKey(source.id)), "8002");
    assert(!f.app.secrets.has(driveLinkCodeKey(legacyId)));
    f.connector.failTransfer = true;
    await f.app.queue.execute(jobId);
    assert.equal(f.app.repo.getJob(jobId).stage, "needs_review");
    // The provider completed the original transfer before dropping its response.
    await f.app.queue.execute(jobId);
    assert.equal(f.app.repo.getJob(jobId).stage, "completed");
    assert.equal(f.connector.transfers, 1);
    f.app.db.transaction(() =>
      removeResourceRecords(f.app.db, f.app.repo.getResource(f.resourceId)),
    );
    assert(!f.app.secrets.has(driveLinkCodeKey(source.id)));
    assert.equal(f.app.db.all("SELECT * FROM resource_drive_links").length, 0);
  } finally {
    await f.cleanup();
  }
});
