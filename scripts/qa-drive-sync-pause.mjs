import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
export async function run({ page, checkpoint }) {
  const ids = (process.env.PANXU_DRIVE_SYNC_PAUSE_ACCOUNTS || "")
    .split(",")
    .filter(Boolean);
  assert.ok(ids.length, "仅能暂停明确指定的本轮账号");
  for (const accountId of ids)
    await page.evaluate(
      (accountId) => window.panxu.invoke("driveSync.pause", { accountId }),
      accountId,
    );
  let states;
  for (let attempt = 0; attempt < 120; attempt++) {
    await checkpoint();
    states = await page.evaluate(
      (ids) =>
        Promise.all(
          ids.map(async (accountId) => ({
            accountId,
            run: (await window.panxu.invoke("driveSync.index", { accountId }))
              .run,
          })),
        ),
      ids,
    );
    if (states.every((s) => !["running", "pausing"].includes(s.run?.status)))
      break;
    await delay(500);
  }
  assert.ok(
    states.every((s) => !["running", "pausing"].includes(s.run?.status)),
  );
  console.log(
    JSON.stringify(
      {
        pausedForBackendUpdate: states.map((s) => ({
          accountId: s.accountId,
          status: s.run?.status,
          files: s.run?.files,
          folders: s.run?.folders,
          pending: s.run?.pending,
        })),
      },
      null,
      2,
    ),
  );
}
