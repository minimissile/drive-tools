import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { devSessionRequest } from "./dev-session-client.mjs";
import { parseResourceTagInput } from "../src/lib/resource-tag-input.ts";
import { parseResourceKeywordText } from "../shared/resource-keywords.ts";

/** Submit only the user's specifically requested cached resource; preserve their main draft. */
export async function run({ page, windowId, checkpoint }) {
  const updates = await devSessionRequest("dev.updates");
  assert.ok(
    updates.runningRevision >= Number(process.env.PANXU_CMCC_MIN_REVISION || 0),
    "分享修复尚未加载",
  );
  assert.equal(
    process.env.PANXU_CMCC_INTAKE_EXECUTE,
    "1",
    "真实转存仅在明确执行该缓存资源时开启",
  );
  const savedDraft = JSON.parse(
    await readFile("/private/tmp/panxu-cmcc-intake-draft.json", "utf8"),
  );
  const cached = await page.evaluate(
    async ({ key, sourceKey }) => {
      const raw = localStorage.getItem(key);
      if (!raw) throw Error("原缓存草稿已不存在");
      const value = JSON.parse(raw),
        source = await window.panxu.invoke("share.parse", {
          text: value.sourceText,
          code: value.code,
        });
      if (value.provider !== "cmcc" || source.shareKey !== sourceKey)
        throw Error("主窗口已切换到其他资源，停止旧资源提交");
      const snapshot = await window.panxu.invoke("snapshot", {});
      let coverData;
      if (
        (await indexedDB.databases()).some(
          (d) => d.name === "panxu-form-attachments-v1",
        )
      )
        coverData = await new Promise((resolve, reject) => {
          const request = indexedDB.open("panxu-form-attachments-v1", 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const read = db
              .transaction("attachments", "readonly")
              .objectStore("attachments")
              .get(`panxu-intake-cover:${snapshot.dataPath}:new:new`);
            read.onsuccess = () => {
              resolve(read.result);
              db.close();
            };
            read.onerror = () => {
              reject(read.error);
              db.close();
            };
          };
        });
      const account = snapshot.accounts.find((a) => a.id === value.accountId);
      if (!account || account.provider !== "cmcc")
        throw Error("缓存目标账号不可用");
      const existing = await window.panxu.invoke("resource.page", {
        query: value.title,
        accountId: value.accountId,
        pageSize: 100,
      });
      return {
        value,
        source,
        coverData,
        dataPath: snapshot.dataPath,
        ownerUid: account.uid,
        existing: existing.items.filter((r) => r.title === value.title),
      };
    },
    { key: savedDraft.key, sourceKey: savedDraft.source.shareKey },
  );
  const inspection = await page.evaluate(
    (input) => window.panxu.invoke("share.inspect", input),
    {
      accountId: cached.value.accountId,
      sourceText: cached.source.url,
      code: cached.source.code,
    },
  );
  assert.equal(inspection.files.length, 1);
  assert.equal(inspection.files[0].isDirectory, true);
  assert.equal(inspection.files[0].name, savedDraft.value.title);
  let result;
  const prior = cached.existing
    .find((r) => r.sourceUrl === cached.source.url)
    ?.copies.find((c) => c.accountId === cached.value.accountId);
  if (prior) {
    const snapshot = await page.evaluate(() =>
      window.panxu.invoke("snapshot", {}),
    );
    const job = snapshot.jobs.find(
      (j) => j.copyId === prior.id && j.kind === "transfer",
    );
    result = {
      resourceId: prior.resourceId,
      copyId: prior.id,
      jobId: job?.id ?? null,
    };
    if (job && ["failed", "needs_review", "waiting_login"].includes(job.stage))
      await page.evaluate(
        (id) => window.panxu.invoke("job.retry", { id }),
        job.id,
      );
  } else {
    const d = cached.value;
    const input = {
      title: d.title,
      sourceText: cached.source.url,
      extractionCode: cached.source.code || undefined,
      category: d.category,
      tags: parseResourceTagInput(d.tags),
      searchKeywords: parseResourceKeywordText(d.keywords.text),
      summary: d.summary,
      coverData: cached.coverData,
      accountId: d.accountId,
      directory: d.directory,
      isOwnResource: false,
      selectedFiles: inspection.files,
      enqueue: true,
    };
    result = await page.evaluate(
      (input) => window.panxu.invoke("resource.save", input),
      input,
    );
  }
  await writeFile(
    "/private/tmp/panxu-cmcc-intake-result.json",
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      windowId,
      phase: "submitted",
      title: cached.value.title,
      ...result,
    }),
  );
  let resource, job;
  for (let attempt = 0; attempt < 120; attempt++) {
    await checkpoint();
    const state = await page.evaluate(
      async ({ resourceId, jobId }) => ({
        resource: await window.panxu.invoke("resource.get", { id: resourceId }),
        job: (await window.panxu.invoke("snapshot", {})).jobs.find(
          (j) => j.id === jobId,
        ),
      }),
      result,
    );
    resource = state.resource;
    job = state.job;
    if (attempt % 5 === 0)
      console.log(
        JSON.stringify({
          phase: "progress",
          stage: job?.stage,
          checkpoint: job?.checkpoint,
          error: job?.error,
        }),
      );
    if (
      !job ||
      [
        "completed",
        "failed",
        "needs_review",
        "waiting_login",
        "cancelled",
      ].includes(job.stage)
    )
      break;
    await page.waitForTimeout(1000);
  }
  const copy = resource.copies.find((c) => c.id === result.copyId);
  assert.ok(copy);
  assert.equal(
    job?.stage ?? "completed",
    "completed",
    job?.error || "资源归档尚未完成",
  );
  assert.equal(copy.status, "ready");
  assert.equal(copy.ownerUid, cached.ownerUid);
  assert.ok(copy.shareUrl);
  const target = await page.evaluate(
    (input) => window.panxu.invoke("drive.directory", input),
    { accountId: cached.value.accountId, path: copy.directory },
  );
  assert.equal(target.files.length, 1);
  assert.equal(target.files[0].isDirectory, true);
  const contents = await page.evaluate(
    (input) => window.panxu.invoke("drive.directory", input),
    {
      accountId: cached.value.accountId,
      path: `${copy.directory}/${target.files[0].name}`,
    },
  );
  assert.equal(contents.files.filter((f) => !f.isDirectory).length, 175);
  const db = new DatabaseSync(join(cached.dataPath, "panxu.db"), {
    readOnly: true,
  });
  let persisted;
  try {
    const r = db
      .prepare("SELECT id,title,provider FROM resources WHERE id=?")
      .get(result.resourceId);
    const c = db
      .prepare(
        "SELECT id,status,owner_uid,share_id,files FROM copies WHERE id=? AND resource_id=?",
      )
      .get(result.copyId, result.resourceId);
    assert.equal(r.provider, "cmcc");
    assert.equal(r.title, cached.value.title);
    assert.equal(c.status, "ready");
    assert.equal(c.owner_uid, cached.ownerUid);
    assert.ok(c.share_id);
    assert.equal(JSON.parse(c.files).length, 1);
    persisted = {
      resourceId: r.id,
      title: r.title,
      copyId: c.id,
      status: c.status,
      topLevelFiles: JSON.parse(c.files).length,
      remoteAudioFiles: contents.files.length,
    };
  } finally {
    db.close();
  }
  console.log(
    JSON.stringify({
      phase: "completed",
      runningRevision: updates.runningRevision,
      persisted,
      scope:
        "Only the requested cached CMCC package; real transfer, own-share verification and SQLite readback; main form retained",
    }),
  );
}
