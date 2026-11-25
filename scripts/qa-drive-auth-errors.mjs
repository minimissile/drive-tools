import assert from "node:assert/strict";
import { devSessionRequest } from "./dev-session-client.mjs";

/** Read-only diagnosis in a dedicated workbench window; never logs credentials. */
export async function run({ page, windowId, checkpoint }) {
  const version = await devSessionRequest("dev.updates");
  const verify = process.env.PANXU_DRIVE_AUTH_VERIFY === "1";
  if (verify)
    assert.ok(
      !version.applying &&
        version.runningRevision >=
          Number(process.env.PANXU_DRIVE_AUTH_MIN_REVISION || 0),
      "新后端尚未加载，不能记录为本轮通过。",
    );
  const accounts = await page.evaluate(async () => {
    const s = await window.panxu.invoke("snapshot", {});
    return s.accounts
      .filter((a) => ["cmcc", "xunlei"].includes(a.provider) && a.enabled)
      .map((a) => ({
        id: a.id,
        provider: a.provider,
        alias: a.alias,
        status: a.status,
        hasUid: !!a.uid,
        error: a.error,
        capacity: a.capacity ?? null,
      }));
  });
  console.log(JSON.stringify({ windowId, version, accounts }));
  const verified = [];
  for (const account of accounts) {
    await checkpoint();
    const started = Date.now();
    const result = await page.evaluate(async (id) => {
      try {
        const a = await window.panxu.invoke("account.capacity", { id });
        return {
          ok: true,
          status: a.status,
          hasUid: !!a.uid,
          error: a.error,
          capacity: a.capacity,
          membership: a.membership,
        };
      } catch (error) {
        return {
          ok: false,
          name: error.name,
          code: error.code,
          message: error.message,
        };
      }
    }, account.id);
    console.log(
      JSON.stringify({
        provider: account.provider,
        accountId: account.id,
        result,
      }),
    );
    if (verify) {
      const directory = await page.evaluate(async (accountId) => {
        try {
          const d = await window.panxu.invoke("drive.directory", {
            accountId,
            path: "/",
          });
          return {
            ok: true,
            files: d.files.length,
            folders: d.files.filter((f) => f.isDirectory).length,
          };
        } catch (error) {
          return { ok: false, code: error.code, message: error.message };
        }
      }, account.id);
      console.log(JSON.stringify({ provider: account.provider, directory }));
      verified.push({
        provider: account.provider,
        passed:
          result.ok &&
          result.status === "connected" &&
          result.hasUid &&
          !result.capacity?.error &&
          !!result.capacity?.value &&
          Date.parse(result.capacity.updatedAt) >= started &&
          directory.ok,
      });
    }
  }
  if (verify) {
    assert.ok(
      accounts.some((a) => a.provider === "cmcc") &&
        accounts.some((a) => a.provider === "xunlei"),
      "本轮需要同时核验移动云盘和迅雷账号。",
    );
    assert.ok(
      verified.every((r) => r.passed),
      JSON.stringify({ verification: verified }),
    );
  }
}
