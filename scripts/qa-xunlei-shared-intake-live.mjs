import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { devSessionRequest } from "./dev-session-client.mjs";

/** Explicit user-provided input lives in a private temp file, never in the repository. */
export async function run({ page, windowId, checkpoint }) {
  const input = JSON.parse(
    await readFile("/private/tmp/panxu-xunlei-intake-input.json", "utf8"),
  );
  const updates = await devSessionRequest("dev.updates");
  assert.ok(updates.runningRevision >= 167 && !updates.applying);
  const baseline = await page.evaluate(async (input) => {
    const snapshot = await window.panxu.invoke("snapshot", {});
    const accounts = snapshot.accounts.filter(
      (a) => a.provider === "xunlei" && a.enabled,
    );
    if (accounts.length !== 1) throw Error("请明确目标迅雷账号");
    const account = accounts[0];
    const source = await window.panxu.invoke("share.parse", {
      text: input.sourceText,
    });
    const existing = await window.panxu.invoke("resource.page", {
      query: input.title,
      accountId: account.id,
      pageSize: 100,
    });
    return {
      account: {
        id: account.id,
        uid: account.uid,
        alias: account.alias,
        directory: account.defaultDirectory,
      },
      source,
      dataPath: snapshot.dataPath,
      existing: existing.items.filter((r) => r.sourceUrl === source.url),
    };
  }, input);
  assert.equal(baseline.source.provider, "xunlei");
  const files = [],
    cursors = new Set();
  let cursor;
  for (let pageNumber = 1; pageNumber <= 100; pageNumber++) {
    await checkpoint();
    const part = await page.evaluate(
      (args) => window.panxu.invoke("share.inspect", args),
      {
        accountId: baseline.account.id,
        sourceText: input.sourceText,
        page: pageNumber,
        cursor,
      },
    );
    files.push(...part.files);
    if (!part.hasMore) break;
    assert.ok(
      part.nextCursor && !cursors.has(part.nextCursor),
      "分享分页重复或缺失",
    );
    cursors.add(part.nextCursor);
    cursor = part.nextCursor;
  }
  assert.ok(files.length > 0 && files.length <= 100, "转存项目数超出支持范围");
  assert.equal(new Set(files.map((f) => f.id)).size, files.length);
  console.log(
    JSON.stringify({
      phase: "source-inspected",
      windowId,
      title: input.title,
      files: files.map((f) => ({
        name: f.name,
        isDirectory: f.isDirectory,
        size: f.size,
      })),
    }),
  );
  if (process.env.PANXU_XUNLEI_INTAKE_EXECUTE !== "1") return;
  let result;
  const prior = baseline.existing[0]?.copies.find(
    (c) => c.accountId === baseline.account.id,
  );
  if (prior) {
    const job = await page.evaluate(
      async (copyId) =>
        (await window.panxu.invoke("snapshot", {})).jobs.find(
          (j) => j.copyId === copyId && j.kind === "transfer",
        ),
      prior.id,
    );
    result = {
      resourceId: prior.resourceId,
      copyId: prior.id,
      jobId: job?.id ?? null,
    };
    if (job && ["failed", "waiting_login", "needs_review"].includes(job.stage))
      await page.evaluate(
        (id) => window.panxu.invoke("job.retry", { id }),
        job.id,
      );
  } else {
    const coverData = input.coverPath
      ? "data:image/png;base64," +
        (await readFile(input.coverPath)).toString("base64")
      : undefined;
    result = await page.evaluate(
      (args) => window.panxu.invoke("resource.save", args),
      {
        title: input.title,
        sourceText: input.sourceText,
        category: input.category,
        tags: input.tags,
        summary: input.summary,
        searchKeywords: input.searchKeywords,
        coverData,
        accountId: baseline.account.id,
        directory: "/盘序资源",
        isOwnResource: false,
        selectedFiles: files,
        enqueue: true,
      },
    );
  }
  await writeFile(
    "/private/tmp/panxu-xunlei-shared-intake-result.json",
    JSON.stringify(result),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ phase: "submitted", ...result }));
  let state;
  for (let attempt = 0; attempt < 240; attempt++) {
    await checkpoint();
    state = await page.evaluate(
      async (ids) => ({
        resource: await window.panxu.invoke("resource.get", {
          id: ids.resourceId,
        }),
        job: (await window.panxu.invoke("snapshot", {})).jobs.find(
          (j) => j.id === ids.jobId,
        ),
      }),
      result,
    );
    if (attempt % 5 === 0)
      console.log(
        JSON.stringify({
          phase: "progress",
          stage: state.job?.stage,
          checkpoint: state.job?.checkpoint,
          error: state.job?.error,
        }),
      );
    if (
      !state.job ||
      [
        "completed",
        "failed",
        "waiting_login",
        "needs_review",
        "cancelled",
      ].includes(state.job.stage)
    )
      break;
    await page.waitForTimeout(1000);
  }
  assert.equal(
    state.job?.stage ?? "completed",
    "completed",
    state.job?.error || "任务未完成",
  );
  const copy = state.resource.copies.find((c) => c.id === result.copyId);
  assert.equal(copy.status, "ready");
  assert.equal(copy.ownerUid, baseline.account.uid);
  assert.ok(copy.shareUrl);
  assert.ok(state.resource.coverId);
  const remote = await page.evaluate(
    (args) => window.panxu.invoke("drive.directory", args),
    { accountId: baseline.account.id, path: copy.directory },
  );
  assert.equal(remote.files.length, files.length);
  assert.ok(
    files.every((f) =>
      remote.files.some(
        (r) =>
          r.name === f.name &&
          r.isDirectory === f.isDirectory &&
          (f.isDirectory || r.size === f.size),
      ),
    ),
  );
  const db = new DatabaseSync(join(baseline.dataPath, "panxu.db"), {
    readOnly: true,
  });
  try {
    const r = db
      .prepare(
        "SELECT title,summary,tags,cover_id,provider FROM resources WHERE id=?",
      )
      .get(result.resourceId);
    const c = db
      .prepare(
        "SELECT status,owner_uid,share_owner_uid,share_id,share_verified_at,files FROM copies WHERE id=? AND resource_id=?",
      )
      .get(result.copyId, result.resourceId);
    assert.equal(r.title, input.title);
    assert.equal(r.summary, input.summary);
    assert.deepEqual(JSON.parse(r.tags), input.tags);
    assert.ok(r.cover_id);
    assert.equal(r.provider, "xunlei");
    assert.equal(c.status, "ready");
    assert.equal(c.owner_uid, baseline.account.uid);
    assert.equal(c.share_owner_uid, baseline.account.uid);
    assert.ok(c.share_id && c.share_verified_at);
    assert.equal(JSON.parse(c.files).length, files.length);
  } finally {
    db.close();
  }
  console.log(
    JSON.stringify({
      phase: "completed",
      runningRevision: updates.runningRevision,
      title: input.title,
      ...result,
      topLevelFiles: remote.files.length,
      coverSaved: true,
      status: copy.status,
      ownShareVerified: true,
      scope:
        "user supplied Thunder package, actual transfer and own-share verification, SQLite readback; no paid query",
    }),
  );
}
