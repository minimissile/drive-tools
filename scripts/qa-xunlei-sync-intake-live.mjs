import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { devSessionRequest } from "./dev-session-client.mjs";

/** Metadata scan and one real owned-resource registration; no transfer or share creation. */
export async function run({ page, checkpoint, windowId }) {
  assert.equal(process.env.PANXU_XUNLEI_SYNC_EXECUTE, "1");
  const cmcc = JSON.parse(
    await readFile("/private/tmp/panxu-cmcc-intake-result.json", "utf8"),
  );
  const cmccResource = await page.evaluate(
    (id) => window.panxu.invoke("resource.get", { id }),
    cmcc.resourceId,
  );
  assert.equal(
    cmccResource.copies.find((c) => c.id === cmcc.copyId)?.status,
    "ready",
    "先完成指定的移动云盘资源，再验收迅雷",
  );
  const updates = await devSessionRequest("dev.updates");
  assert.ok(
    !updates.applying &&
      updates.runningRevision >=
        Number(process.env.PANXU_XUNLEI_MIN_REVISION || 0),
  );
  const baseline = await page.evaluate(async () => {
    const snapshot = await window.panxu.invoke("snapshot", {});
    const accounts = snapshot.accounts.filter(
      (a) => a.provider === "xunlei" && a.enabled,
    );
    if (accounts.length !== 1) throw Error("请明确本轮迅雷账号");
    const account = accounts[0];
    if (!account.uid || account.status !== "connected")
      throw Error("迅雷账号尚未通过登录核验");
    return {
      account: { id: account.id, uid: account.uid, alias: account.alias },
      dataPath: snapshot.dataPath,
    };
  });
  const accountId = baseline.account.id;
  const knownIds = process.env.PANXU_XUNLEI_EXISTING_RESOURCE_PATH
    ? JSON.parse(
        await readFile(process.env.PANXU_XUNLEI_EXISTING_RESOURCE_PATH, "utf8"),
      )
    : null;
  const knownResource = knownIds
    ? await page.evaluate(
        (id) => window.panxu.invoke("resource.get", { id }),
        knownIds.resourceId,
      )
    : null;
  const knownCopy = knownResource?.copies.find((c) => c.id === knownIds.copyId);
  if (knownIds) {
    assert.equal(knownCopy?.status, "ready");
    assert.equal(knownCopy.accountId, accountId);
  }
  const initial = await page.evaluate(
    (accountId) => window.panxu.invoke("driveSync.index", { accountId }),
    accountId,
  );
  let run = initial.run;
  if (
    !run ||
    (run.status === "completed" &&
      process.env.PANXU_XUNLEI_REUSE_COMPLETED_SCAN !== "1")
  )
    run = await page.evaluate(
      (accountId) => window.panxu.invoke("driveSync.start", { accountId }),
      accountId,
    );
  else if (!["running", "pausing", "completed"].includes(run.status))
    run = await page.evaluate(
      (accountId) => window.panxu.invoke("driveSync.resume", { accountId }),
      accountId,
    );
  const runId = run.id;
  console.log(
    JSON.stringify({
      phase: "scan-started",
      windowId,
      account: baseline.account.alias,
      runId,
    }),
  );
  for (
    let attempt = 0;
    attempt < 400 && ["running", "pausing"].includes(run.status);
    attempt++
  ) {
    await checkpoint();
    await page.waitForTimeout(1500);
    const view = await page.evaluate(
      (accountId) => window.panxu.invoke("driveSync.index", { accountId }),
      accountId,
    );
    assert.equal(view.run.id, runId, "同步任务被其他操作替换，停止本轮验收");
    run = view.run;
    if (attempt % 10 === 0)
      console.log(
        JSON.stringify({
          phase: "scan-progress",
          status: run.status,
          files: run.files,
          folders: run.folders,
          pending: run.pending,
          failed: run.failed,
          message: run.message,
        }),
      );
  }
  assert.equal(run.status, "completed", run.message || "迅雷扫描尚未完成");
  assert.equal(run.pending, 0);
  assert.equal(run.failed, 0);
  const db = new DatabaseSync(join(baseline.dataPath, "panxu.db"), {
    readOnly: true,
  });
  let entries;
  try {
    const stored = db
      .prepare(
        "SELECT * FROM drive_sync_runs WHERE id=? AND account_id=? AND owner_uid=?",
      )
      .get(runId, accountId, baseline.account.uid);
    assert.equal(stored.status, "completed");
    assert.ok(stored.completed_at);
    const folders = db
      .prepare("SELECT status FROM drive_sync_folders WHERE run_id=?")
      .all(runId);
    assert.ok(folders.length > 0);
    assert.ok(folders.every((f) => f.status === "completed"));
    entries = db
      .prepare(
        "SELECT file_id,name,path,is_directory,size FROM drive_index_entries WHERE account_id=? AND owner_uid=? AND last_seen=? AND missing=0 ORDER BY path",
      )
      .all(accountId, baseline.account.uid, runId);
    assert.equal(entries.filter((e) => !e.is_directory).length, run.files);
    assert.equal(new Set(entries.map((e) => e.file_id)).size, entries.length);
  } finally {
    db.close();
  }
  const root = await page.evaluate(
    (accountId) => window.panxu.invoke("driveSync.index", { accountId }),
    accountId,
  );
  assert.equal(root.ownerUid, baseline.account.uid);
  assert.ok(root.lastCompleteAt);
  const sample = entries.find((e) => !e.is_directory) || entries[0];
  if (sample) {
    const found = await page.evaluate(
      ({ accountId, search }) =>
        window.panxu.invoke("driveSync.index", { accountId, search }),
      { accountId, search: sample.name },
    );
    assert.ok(found.items.some((e) => e.id === sample.file_id));
  }
  const nonEmpty = knownCopy
    ? entries.find((e) => e.file_id === knownCopy.folderId)
    : entries.find(
        (e) =>
          e.is_directory &&
          entries.some(
            (f) => !f.is_directory && f.path.startsWith(e.path + "/"),
          ),
      ) || entries.find((e) => !e.is_directory);
  if (knownCopy) assert.ok(nonEmpty, "刚录入的资源目录未同步到本地");
  let registered = null;
  if (nonEmpty) {
    const input = {
      accountId,
      entries: [
        {
          fileId: nonEmpty.file_id,
          title: knownResource?.title ?? nonEmpty.name,
        },
      ],
    };
    const first = await page.evaluate(
      (input) => window.panxu.invoke("driveSync.register", input),
      input,
    );
    assert.equal(first.length, 1);
    assert.ok(first[0].resourceId, first[0].error);
    const resource = await page.evaluate(
      (id) => window.panxu.invoke("resource.get", { id }),
      first[0].resourceId,
    );
    assert.equal(resource.provider, "xunlei");
    assert.equal(resource.sourceKind, knownResource ? "share" : "owned");
    if (knownResource)
      assert.equal(resource.id, knownResource.id, "已有资源不应重复建档");
    const copy = resource.copies.find((c) => c.accountId === accountId);
    assert.equal(copy?.status, knownResource ? "ready" : "recorded");
    assert.equal(copy.ownerUid, baseline.account.uid);
    assert.ok(
      copy.folderId === nonEmpty.file_id ||
        copy.files.some((f) => f.id === nonEmpty.file_id),
    );
    const again = await page.evaluate(
      (input) => window.panxu.invoke("driveSync.register", input),
      input,
    );
    assert.equal(again[0].resourceId, resource.id, "重复登记应复用同一资源");
    const storedDb = new DatabaseSync(join(baseline.dataPath, "panxu.db"), {
      readOnly: true,
    });
    try {
      const stored = storedDb
        .prepare(
          "SELECT r.provider,r.title,c.id,c.status,c.owner_uid FROM resources r JOIN copies c ON c.resource_id=r.id JOIN drive_resource_entries l ON l.copy_id=c.id WHERE r.id=? AND l.file_id=? AND l.account_id=? AND l.owner_uid=?",
        )
        .get(resource.id, nonEmpty.file_id, accountId, baseline.account.uid);
      assert.equal(stored.status, knownResource ? "ready" : "recorded");
      assert.equal(stored.provider, "xunlei");
      assert.equal(stored.title, knownResource?.title ?? nonEmpty.name);
      registered = {
        resourceId: resource.id,
        copyId: copy.id,
        title: resource.title,
        status: stored.status,
        idempotent: true,
      };
    } finally {
      storedDb.close();
    }
  }
  if (knownCopy) {
    const indexed = await page.evaluate(
      (args) => window.panxu.invoke("driveSync.index", args),
      { accountId, search: knownCopy.directory },
    );
    const owned = indexed.items.filter(
      (e) =>
        e.path === knownCopy.directory ||
        e.path.startsWith(knownCopy.directory + "/"),
    );
    assert.ok(owned.length > 0);
    assert.equal(
      owned.find((e) => e.id === knownCopy.folderId)?.state,
      "recorded",
    );
    assert.ok(
      owned.every(
        (e) => !e.missing && ["recorded", "review"].includes(e.state),
      ),
      "资源目录已登记，未独立登记的子文件保留待核对状态",
    );
  }
  const report = {
    windowId,
    runningRevision: updates.runningRevision,
    account: baseline.account.alias,
    runId,
    status: run.status,
    files: run.files,
    videoFiles: entries.filter(
      (e) => !e.is_directory && /\.(mkv|mp4|m4v|avi|ts|mov)$/i.test(e.name),
    ).length,
    folders: run.folders,
    localEntries: entries.length,
    rootEntries: root.total,
    registered,
    resourceTest: registered
      ? "passed"
      : "no real file found; empty/default folders were not registered",
    scope:
      "Thunder metadata scan, SQLite readback and owned-resource registration only; no remote transfer or share",
  };
  await writeFile(
    "/private/tmp/panxu-xunlei-sync-intake-result.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ phase: "completed", ...report }));
}
