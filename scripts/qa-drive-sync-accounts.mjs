/** Inventory only. No login, browser creation, or remote request is triggered. */
export async function run({ page }) {
  const inventory = await page.evaluate(async () => {
    const snapshot = await window.panxu.invoke("snapshot");
    const providers = ["baidu", "quark", "uc", "xunlei", "guangya"];
    return providers.map((provider) => ({
      provider,
      accounts: snapshot.accounts
        .filter((a) => a.provider === provider)
        .map((a) => ({
          id: a.id,
          alias: a.alias,
          enabled: a.enabled,
          status: a.status,
          browser: a.browserEngine,
          hasUid: !!a.uid,
        })),
    }));
  });
  console.log(JSON.stringify({ driveSyncInventory: inventory }, null, 2));
}
