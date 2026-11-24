import assert from "node:assert/strict";
/** Uses only the task window's real IPC. No third-party transport mocking. */
export async function run({ page, checkpoint }) {
  await page.getByRole("heading", { name: "网盘文件", exact: true }).waitFor();
  const accounts = await page.evaluate(async () =>
    (await window.panxu.invoke("snapshot")).accounts
      .filter((a) => a.provider === "quark" && a.enabled)
      .map((a) => ({ id: a.id, alias: a.alias, engine: a.browserEngine })),
  );
  const results = [];
  for (const account of accounts) {
    await checkpoint();
    const result = await page.evaluate(async ({ id }) => {
      try {
        const a = await window.panxu.invoke("account.check", { id });
        let index;
        try {
          index = await window.panxu.invoke("driveSync.index", {
            accountId: id,
          });
        } catch (error) {
          index = { error: error.message };
        }
        return {
          status: a.status,
          error: a.error,
          membership: a.membership,
          capacityError: a.capacity?.error,
          index: index.error
            ? index
            : {
                total: index.total,
                run: index.run?.status,
                ownerVerified: !!index.ownerUid,
              },
        };
      } catch (error) {
        return { error: error.message };
      }
    }, account);
    results.push({ ...account, ...result });
  }
  console.log(JSON.stringify({ quarkReadOnly: results }, null, 2));
  assert.ok(accounts.length, "没有启用的夸克账号");
}
