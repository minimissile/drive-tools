import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

/** Read the explicitly requested main intake draft; only write this task's copy. */
export async function run({ page, windowId }) {
  const draft = await page.evaluate(async () => {
    const s = await window.panxu.invoke("snapshot", {});
    const key = `panxu-intake-v1:${s.dataPath}:new:new`;
    const raw = localStorage.getItem(key);
    if (!raw) throw Error("主窗口没有新增资源草稿");
    const value = JSON.parse(raw);
    if (value.provider !== "cmcc") throw Error("主窗口缓存已变更，停止接续");
    const source = await window.panxu.invoke("share.parse", {
      text: value.sourceText,
      code: value.code,
    });
    localStorage.setItem(
      `panxu-window:${encodeURIComponent(window.panxu.windowId)}:${key}`,
      raw,
    );
    return { key, value, source };
  });
  assert.equal(draft.source.provider, "cmcc");
  await writeFile(
    "/private/tmp/panxu-cmcc-intake-draft.json",
    JSON.stringify(draft, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      windowId,
      title: draft.value.title,
      provider: draft.value.provider,
      accountId: draft.value.accountId,
      directory: draft.value.directory,
      sourceHost: new URL(draft.source.url).hostname,
      hasCode: !!draft.source.code,
      isOwnResource: draft.value.isOwnResource,
      scope:
        "read requested main draft, preserve original, copy only into this task window",
    }),
  );
}
