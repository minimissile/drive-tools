import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { devSessionRequest } from "./dev-session-client.mjs";

export async function run({ page, windowId, checkpoint }) {
  const updates = await devSessionRequest("dev.updates");
  assert.ok(
    !updates.applying &&
      updates.runningRevision >=
        Number(process.env.PANXU_XUNLEI_MIN_REVISION || 0),
    "容量修复尚未加载",
  );
  const account = await page.evaluate(async () => {
    const accounts = (
      await window.panxu.invoke("snapshot", {})
    ).accounts.filter((a) => a.provider === "xunlei" && a.enabled);
    if (accounts.length !== 1)
      throw Error("Expected one enabled Thunder account");
    return { id: accounts[0].id, alias: accounts[0].alias };
  });
  const reads = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await checkpoint();
    const started = Date.now();
    const result = await page.evaluate(async (id) => {
      const a = await window.panxu.invoke("account.capacity", { id });
      return {
        status: a.status,
        hasUid: !!a.uid,
        capacity: a.capacity,
        membership: a.membership,
      };
    }, account.id);
    assert.equal(result.status, "connected");
    assert.ok(result.hasUid);
    assert.equal(result.capacity?.error, null);
    assert.deepEqual(result.capacity?.value, {
      totalBytes: 11102490460160,
      usedBytes: 0,
    });
    assert.ok(Date.parse(result.capacity.updatedAt) >= started);
    assert.equal(result.membership?.error, null);
    assert.deepEqual(result.membership?.value, {
      status: "active",
      tier: "超级会员",
      expiresAt: "2026-12-04T15:59:59.000Z",
    });
    reads.push({
      attempt: attempt + 1,
      capacity: result.capacity.value,
      updatedAt: result.capacity.updatedAt,
      membership: result.membership.value,
    });
  }
  const directory = await page.evaluate(async (accountId) => {
    const d = await window.panxu.invoke("drive.directory", {
      accountId,
      path: "/",
    });
    return {
      files: d.files.length,
      folders: d.files.filter((f) => f.isDirectory).length,
    };
  }, account.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: /^迅雷\s*\d+$/ }).click();
  const capacity = page.getByRole("region", {
    name: `${account.alias}网盘容量`,
  });
  await capacity
    .locator(".capacity-values > span")
    .filter({ hasText: "10.1 TB" })
    .waitFor();
  await capacity.locator(".capacity-error").waitFor({state:"hidden"});
  await mkdir("/private/tmp/panxu-xunlei-live", { recursive: true });
  await page.screenshot({
    path: `/private/tmp/panxu-xunlei-live/${windowId}.png`,
    fullPage: false,
  });
  console.log(
    JSON.stringify({
      windowId,
      runningRevision: updates.runningRevision,
      account,
      reads,
      directory,
      scope:
        "Two independent quota reads and root metadata only, with the official account window closed; no remote mutation",
    }),
  );
}
