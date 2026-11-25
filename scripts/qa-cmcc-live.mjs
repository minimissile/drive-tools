import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { devSessionRequest } from "./dev-session-client.mjs";

/** Run only after the user has applied the backend and logged in. Never logs credentials. */
export async function run({ page, windowId, checkpoint }) {
  const updates = await devSessionRequest("dev.updates");
  const required = Number(process.env.PANXU_CMCC_MIN_REVISION || 0);
  assert.ok(
    !updates.applying && updates.runningRevision >= required,
    "移动云盘后端尚未应用，本轮不记为真实通过。",
  );
  const accounts = await page.evaluate(async () => {
    const snapshot = await window.panxu.invoke("snapshot", {});
    return snapshot.accounts
      .filter((a) => a.provider === "cmcc" && a.enabled)
      .map((a) => ({ id: a.id, alias: a.alias, status: a.status }));
  });
  const requested = process.env.PANXU_CMCC_ACCOUNT_ID;
  const account = requested
    ? accounts.find((a) => a.id === requested)
    : accounts.length === 1
      ? accounts[0]
      : null;
  assert.ok(
    account,
    "请先添加并登录移动云盘；有多个账号时请显式指定验收账号。",
  );
  const checked = await page.evaluate(async (id) => {
    const a = await window.panxu.invoke("account.capacity", { id });
    return {
      id: a.id,
      alias: a.alias,
      status: a.status,
      hasUid: !!a.uid,
      capacity: a.capacity?.value ?? null,
      capacityError: a.capacity?.error ?? null,
      capacityUpdatedAt: a.capacity?.updatedAt,
      membership: a.membership?.value ?? null,
      membershipError: a.membership?.error ?? null,
    };
  }, account.id);
  assert.equal(checked.status, "connected");
  assert.equal(checked.hasUid, true);
  assert.equal(checked.capacityError, null);
  assert.equal(checked.membershipError, null);
  assert.ok(checked.membership && checked.membership.status !== "unknown");
  if (process.env.PANXU_CMCC_EXPECTED_EXPIRY)
    assert.equal(
      checked.membership.expiresAt,
      process.env.PANXU_CMCC_EXPECTED_EXPIRY,
    );
  if (process.env.PANXU_CMCC_EXPECTED_TOTAL)
    assert.equal(
      checked.capacity.totalBytes,
      Number(process.env.PANXU_CMCC_EXPECTED_TOTAL),
    );
  assert.ok(
    checked.capacity &&
      checked.capacity.totalBytes >=
        Number(process.env.PANXU_CMCC_TOTAL_MIN || 0),
  );
  if (process.env.PANXU_CMCC_TOTAL_MAX)
    assert.ok(
      checked.capacity.totalBytes <= Number(process.env.PANXU_CMCC_TOTAL_MAX),
    );
  const root = await page.evaluate(async (accountId) => {
    const d = await window.panxu.invoke("drive.directory", {
      accountId,
      path: "/",
    });
    return {
      files: d.files.length,
      folders: d.files.filter((f) => f.isDirectory).length,
      capabilities: d.capabilities,
    };
  }, account.id);
  await checkpoint();
  if (process.env.PANXU_CMCC_SCREENSHOT === "1") {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("tab", { name: /^移动云盘\s*\d+$/ }).click();
    const membership = page.getByRole("region", {
      name: `${checked.alias}会员信息`,
    });
    await membership
      .getByText(checked.membership.tier, { exact: true })
      .waitFor();
    if (process.env.PANXU_CMCC_EXPECTED_EXPIRY)
      await membership.getByText(/到期时间：2027\/2\/24 23:52:32/).waitFor();
    await mkdir("/private/tmp/panxu-cmcc-live", { recursive: true });
    await page.screenshot({
      path: `/private/tmp/panxu-cmcc-live/${windowId}.png`,
      fullPage: false,
    });
  }
  let scan = { started: false, status: "not-requested" };
  const readScan = () =>
    page.evaluate(
      async (id) =>
        (await window.panxu.invoke("driveSync.index", { accountId: id })).run,
      account.id,
    );
  if (process.env.PANXU_CMCC_SCAN === "1") {
    const previous = await readScan();
    if (previous && !["completed"].includes(previous.status))
      scan = {
        started: false,
        status: previous.status,
        message: "保留既有同步现场，未接管或暂停其他操作。",
      };
    else {
      const started = await page.evaluate(
        (id) => window.panxu.invoke("driveSync.start", { accountId: id }),
        account.id,
      );
      let current = started;
      const deadline = Date.now() + 12000;
      while (
        ["running", "pausing"].includes(current.status) &&
        Date.now() < deadline
      ) {
        await page.waitForTimeout(400);
        await checkpoint();
        current = await readScan();
        assert.equal(
          current.id,
          started.id,
          "同步任务已由其他窗口更新，停止本轮控制。",
        );
      }
      if (current.status === "running") {
        await page.evaluate(
          (id) => window.panxu.invoke("driveSync.pause", { accountId: id }),
          account.id,
        );
        const pauseDeadline = Date.now() + 30000;
        do {
          await page.waitForTimeout(400);
          await checkpoint();
          current = await readScan();
        } while (
          current.id === started.id &&
          ["running", "pausing"].includes(current.status) &&
          Date.now() < pauseDeadline
        );
      }
      scan = {
        started: true,
        status: current.status,
        files: current.files,
        folders: current.folders,
        pending: current.pending,
        failed: current.failed,
        message: current.message,
      };
      assert.ok(
        ["completed", "paused"].includes(current.status),
        JSON.stringify(scan),
      );
      assert.equal(current.failed, 0);
    }
  }
  console.log(
    JSON.stringify({
      windowId,
      runningRevision: updates.runningRevision,
      account: checked,
      root,
      scan,
      scope:
        "real identity, quota and directory metadata only; no upload, rename, delete, transfer or sharing",
    }),
  );
}
