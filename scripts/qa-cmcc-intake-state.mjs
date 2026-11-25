import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function run({ page }) {
  const ids = JSON.parse(
    await readFile("/private/tmp/panxu-cmcc-intake-result.json", "utf8"),
  );
  const state = await page.evaluate(async (ids) => {
    const snapshot = await window.panxu.invoke("snapshot", {});
    const resource = await window.panxu.invoke("resource.get", {
      id: ids.resourceId,
    });
    const copy = resource.copies.find((c) => c.id === ids.copyId);
    const checked = await window.panxu.invoke("account.capacity", {
      id: copy.accountId,
    });
    const target = await window.panxu.invoke("drive.directory", {
      accountId: copy.accountId,
      path: copy.directory,
    });
    const child = target.files.find(
      (f) => f.isDirectory && f.name === resource.title,
    );
    const contents = child
      ? await window.panxu.invoke("drive.directory", {
          accountId: copy.accountId,
          path: copy.directory + "/" + child.name,
        })
      : null;
    return {
      title: resource.title,
      status: copy.status,
      accountStatus: checked.status,
      capacityError: checked.capacity?.error,
      job: snapshot.jobs.find((j) => j.id === ids.jobId),
      targetFolders: target.files.length,
      childFiles: contents?.files.length,
    };
  }, ids);
  assert.equal(state.accountStatus, "connected");
  console.log(JSON.stringify(state));
}
