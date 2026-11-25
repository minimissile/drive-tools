import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** Compare the complete source share tree with the already synced local metadata, no writes. */
export async function run({ page, checkpoint }) {
  const ids = JSON.parse(
    await readFile(
      "/private/tmp/panxu-xunlei-shared-intake-result.json",
      "utf8",
    ),
  );
  const input = JSON.parse(
    await readFile("/private/tmp/panxu-xunlei-intake-input.json", "utf8"),
  );
  const state = await page.evaluate(
    async (id) => ({
      resource: await window.panxu.invoke("resource.get", { id }),
      dataPath: (await window.panxu.invoke("snapshot", {})).dataPath,
    }),
    ids.resourceId,
  );
  const copy = state.resource.copies.find((c) => c.id === ids.copyId);
  assert.equal(copy.status, "ready");
  const source = [],
    queue = [{ id: "0", prefix: "" }],
    visited = new Set();
  while (queue.length) {
    await checkpoint();
    assert.ok(visited.size < 200, "分享目录数超出核对上限");
    const folder = queue.shift();
    assert.ok(!visited.has(folder.id), "分享目录出现循环");
    visited.add(folder.id);
    let cursor;
    const cursors = new Set();
    for (let number = 1; number <= 100; number++) {
      const part = await page.evaluate(
        (args) => window.panxu.invoke("share.inspect", args),
        {
          accountId: copy.accountId,
          sourceText: input.sourceText,
          parentId: folder.id,
          page: number,
          cursor,
        },
      );
      for (const file of part.files) {
        const path = folder.prefix + file.name;
        source.push({
          path,
          isDirectory: file.isDirectory,
          size: file.isDirectory ? null : file.size,
        });
        if (file.isDirectory) queue.push({ id: file.id, prefix: path + "/" });
      }
      if (!part.hasMore) break;
      assert.ok(part.nextCursor && !cursors.has(part.nextCursor));
      cursors.add(part.nextCursor);
      cursor = part.nextCursor;
    }
  }
  const db = new DatabaseSync(join(state.dataPath, "panxu.db"), {
    readOnly: true,
  });
  let local;
  try {
    local = db
      .prepare(
        "SELECT path,is_directory,size,missing FROM drive_index_entries WHERE account_id=? AND owner_uid=? AND substr(path,1,?)=? ORDER BY path",
      )
      .all(
        copy.accountId,
        copy.ownerUid,
        copy.directory.length + 1,
        copy.directory + "/",
      );
  } finally {
    db.close();
  }
  assert.ok(local.every((f) => !f.missing));
  local = local.map((f) => ({
    path: f.path.slice(copy.directory.length + 1),
    isDirectory: !!f.is_directory,
    size: f.is_directory ? null : f.size,
  }));
  const sorted = (rows) => rows.sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    sorted(local),
    sorted(source),
    "来源分享与本地索引中的文件名、相对路径、类型或大小不一致",
  );
  const report = {
    title: state.resource.title,
    sourceFiles: source.filter((f) => !f.isDirectory).length,
    sourceFolders: source.filter((f) => f.isDirectory).length,
    localEntries: local.length,
    matched: true,
    files: source
      .filter((f) => !f.isDirectory)
      .map((f) => ({ name: f.path.split("/").at(-1), bytes: f.size })),
    totalBytes: source
      .filter((f) => !f.isDirectory)
      .reduce((n, f) => n + f.size, 0),
  };
  await writeFile(
    "/private/tmp/panxu-xunlei-manifest-result.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
}
