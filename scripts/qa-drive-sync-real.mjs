import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Real read-only scans through the exact account environment. Never creates resources/shares. */
export async function run({ page, checkpoint, windowId }) {
  const minimumRevision = Number(
    process.env.PANXU_DRIVE_SYNC_MIN_REVISION || 0,
  );
  const baseline = await page.evaluate(async () => ({
    updates: await window.panxu.invoke("dev.updates"),
    accounts: (await window.panxu.invoke("snapshot")).accounts
      .filter(
        (a) =>
          ["baidu", "quark", "uc", "xunlei", "guangya"].includes(a.provider) &&
          a.enabled,
      )
      .map((a) => ({
        id: a.id,
        provider: a.provider,
        alias: a.alias,
        browser: a.browserEngine,
        hasUid: !!a.uid,
      })),
  }));
  assert.ok(
    baseline.updates.runningRevision >= minimumRevision,
    "本轮后端尚未加载，请由用户手动应用更新后验收。",
  );
  const output = `/private/tmp/panxu-drive-sync-real/${windowId}`;
  await mkdir(output, { recursive: true });
  const results = [];
  for (const account of baseline.accounts) {
    await checkpoint();
    const result = await page.evaluate(async (account) => {
      try {
        if (!account.hasUid) {
          const checked = await window.panxu.invoke("account.check", {
            id: account.id,
          });
          if (checked.status !== "connected")
            return { error: checked.error || "未登录" };
        }
        const index = await window.panxu.invoke("driveSync.index", {
          accountId: account.id,
        });
        const run = index.run;
        if (run?.status === "completed") return { run };
        if (run && ["running", "pausing"].includes(run.status)) return { run };
        return {
          run: await window.panxu.invoke(
            run && !["completed", "blocked"].includes(run.status)
              ? "driveSync.resume"
              : "driveSync.start",
            {
              accountId: account.id,
              ...(run?.status === "blocked" ? { restart: true } : {}),
            },
          ),
        };
      } catch (error) {
        return { error: error.message };
      }
    }, account);
    results.push({ ...account, ...result });
    console.log(
      JSON.stringify({
        phase: "started",
        account: account.alias,
        provider: account.provider,
        status: result.run?.status,
        error: result.error,
      }),
    );
  }
  let lastLog = 0;
  while (
    results.some((r) => r.run && ["running", "pausing"].includes(r.run.status))
  ) {
    await checkpoint();
    await delay(1500);
    for (const result of results.filter(
      (r) => r.run && ["running", "pausing"].includes(r.run.status),
    )) {
      const view = await page.evaluate(
        (accountId) => window.panxu.invoke("driveSync.index", { accountId }),
        result.id,
      );
      result.run = view.run;
    }
    if (Date.now() - lastLog > 15000) {
      console.log(
        JSON.stringify({
          phase: "progress",
          accounts: results.map((r) => ({
            alias: r.alias,
            status: r.run?.status,
            files: r.run?.files,
            folders: r.run?.folders,
            pending: r.run?.pending,
            failed: r.run?.failed,
            error: r.error || r.run?.message,
          })),
        }),
      );
      lastLog = Date.now();
    }
  }
  for (const result of results.filter((r) => r.run?.status === "completed")) {
    const check = await page.evaluate(async (accountId) => {
      const root = await window.panxu.invoke("driveSync.index", { accountId });
      const folder = root.items.find((e) => e.isDirectory);
      const child = folder
        ? await window.panxu.invoke("driveSync.index", {
            accountId,
            parentId: folder.id,
          })
        : null;
      const first = root.items.find((e) => !e.isDirectory) || root.items[0];
      const search = first
        ? await window.panxu.invoke("driveSync.index", {
            accountId,
            search: first.name,
          })
        : null;
      return {
        root: root.total,
        child: child?.total,
        search: search?.total,
        lastCompleteAt: root.lastCompleteAt,
        missing: root.items.filter((e) => e.missing).length,
      };
    }, result.id);
    assert.ok(check.lastCompleteAt);
    if (check.root) assert.ok(check.search > 0);
    result.check = check;
  }
  const report = {
    windowId,
    runningRevision: baseline.updates.runningRevision,
    skipped: ["pikpak"],
    missing: ["baidu", "quark", "uc", "xunlei", "guangya"].filter(
      (p) => !results.some((r) => r.provider === p),
    ),
    results,
  };
  await writeFile(output + "/results.json", JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ phase: "finished", output, ...report }, null, 2),
  );
}
