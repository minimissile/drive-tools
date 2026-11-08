import test from "node:test";
import assert from "node:assert/strict";
import type { ResourceCopy, RemoteFile } from "../shared/types";
import type { DriveDirectory } from "../shared/drive-files";
import {
  loadVideoDirectorySnapshot,
  readVideoDirectorySnapshot,
  videoDirectorySnapshot,
  videoDirectorySnapshotKey,
  videoDirectoryTargets,
  type VideoDirectoryTarget,
} from "../src/video/resource-video-source";

const file = (id: string, name: string, isDirectory = false): RemoteFile => ({
  id,
  name,
  isDirectory,
  size: 0,
  parentId: "root",
});
const copy = (files: RemoteFile[]): ResourceCopy => ({
  id: "copy-a",
  resourceId: "resource-a",
  accountId: "account-a",
  directory: "/资料",
  folderId: "parent",
  files,
  status: "ready",
  ownerUid: "owner",
  verifiedAt: null,
  shareId: null,
  shareUrl: null,
  shareOwnerUid: null,
  shareVersion: 0,
  shareVerifiedAt: null,
  noteStatus: "none",
  error: null,
});
const target: VideoDirectoryTarget = {
  id: "root",
  name: "测评合集",
  accountId: "account-a",
  path: "/资料/测评合集",
};
function directory(
  folderId: string,
  path: string,
  files: RemoteFile[],
): DriveDirectory {
  return {
    accountId: "account-a",
    provider: "quark",
    folderId,
    path,
    files,
    readAt: "2026-11-07T12:00:00.000Z",
    capabilities: { rename: false, delete: false, upload: false },
    pending: null,
  };
}

test("folder targets remain under the recorded resource and do not trust an unrelated absolute file path", () => {
  const resourceCopy = copy([
    { ...file("valid", "测评合集", true), path: "/别人的目录" },
    file("not-folder", "练习.pdf"),
    ...[".", "..", "上级/别处", "上级\\别处"].map((name, index) =>
      file(`invalid-${index}`, name, true),
    ),
  ]);
  const original = structuredClone(resourceCopy);
  assert.deepEqual(videoDirectoryTargets(resourceCopy), [
    { ...target, id: "valid" },
  ]);
  assert.deepEqual(resourceCopy, original);
  assert.deepEqual(
    videoDirectoryTargets({ ...resourceCopy, directory: "/资料/../别处" }),
    [],
  );
});

test("snapshot keys isolate workspace, copy, account, folder ID and path", () => {
  const key = videoDirectorySnapshotKey("space-a", "copy-a", target);
  const alternatives = [
    videoDirectorySnapshotKey("space-b", "copy-a", target),
    videoDirectorySnapshotKey("space-a", "copy-b", target),
    videoDirectorySnapshotKey("space-a", "copy-a", {
      ...target,
      accountId: "account-b",
    }),
    videoDirectorySnapshotKey("space-a", "copy-a", {
      ...target,
      id: "different-root",
    }),
    videoDirectorySnapshotKey("space-a", "copy-a", {
      ...target,
      path: "/资料/改名后的合集",
    }),
  ];
  assert.equal(new Set([key, ...alternatives]).size, alternatives.length + 1);
});

test("one explicit read expands direct child folders only and preserves real relative names", async () => {
  const calls: string[] = [];
  const root = directory("root", target.path, [
    file("mbti", "MBTI", true),
    file("career", "职业规划", true),
    file("guide", "使用说明.pdf"),
  ]);
  const known = new Map([
    [target.path, root],
    [
      `${target.path}/MBTI`,
      directory("mbti", `${target.path}/MBTI`, [
        file("questions", "测试题.pdf"),
        file("deep", "更多题目", true),
      ]),
    ],
    [
      `${target.path}/职业规划`,
      directory("career", `${target.path}/职业规划`, [
        file("career-guide", "霍兰德.docx"),
      ]),
    ],
  ]);
  const snapshot = await loadVideoDirectorySnapshot(
    target,
    async (accountId, path) => {
      assert.equal(accountId, target.accountId);
      calls.push(path);
      assert(known.has(path), "不得读取孙级目录或当前资源范围外的路径");
      return known.get(path)!;
    },
  );
  assert.deepEqual(calls, [
    target.path,
    `${target.path}/MBTI`,
    `${target.path}/职业规划`,
  ]);
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.name),
    [
      "MBTI",
      "职业规划",
      "使用说明.pdf",
      "MBTI/测试题.pdf",
      "MBTI/更多题目",
      "职业规划/霍兰德.docx",
    ],
  );
  assert.equal(snapshot.total, 6);
  assert.equal(snapshot.truncated, false);
  assert.equal(root.files.length, 3);
});

test("large children stop at 120 displayed entries without scanning further folders or claiming their unseen counts", async () => {
  const calls: string[] = [];
  const snapshot = await loadVideoDirectorySnapshot(
    target,
    async (_accountId, path) => {
      calls.push(path);
      if (path === target.path)
        return directory("root", path, [
          file("first", "第一组", true),
          file("later", "第二组", true),
        ]);
      assert.equal(path, `${target.path}/第一组`);
      return directory(
        "first",
        path,
        Array.from({ length: 200 }, (_, index) =>
          file(`item-${index}`, `题目${index}.pdf`),
        ),
      );
    },
  );
  assert.equal(snapshot.entries.length, 120);
  assert.equal(snapshot.total, 202);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(calls, [target.path, `${target.path}/第一组`]);
});

test("at most twelve direct children are queried, and unread folders are marked as limited", async () => {
  const calls: string[] = [];
  const folders = Array.from({ length: 13 }, (_, index) =>
    file(`group-${index}`, `分类${index}`, true),
  );
  const snapshot = await loadVideoDirectorySnapshot(
    target,
    async (_accountId, path) => {
      calls.push(path);
      if (path === target.path) return directory("root", path, folders);
      const index = Number(path.match(/分类(\d+)$/)![1]);
      return directory(`group-${index}`, path, [
        file(`leaf-${index}`, "说明.txt"),
      ]);
    },
  );
  assert.equal(calls.length, 13);
  assert.equal(snapshot.total, 25);
  assert.equal(snapshot.entries.length, 25);
  assert.equal(snapshot.truncated, true);
});

test("changed account or folder identity and a failed child read reject the whole new snapshot", async () => {
  const root = directory("root", target.path, [
    file("child", "子文件夹", true),
  ]);
  await assert.rejects(
    loadVideoDirectorySnapshot(target, async () => ({
      ...root,
      accountId: "account-b",
    })),
    /当前资源不一致/,
  );
  await assert.rejects(
    loadVideoDirectorySnapshot(target, async () => ({
      ...root,
      folderId: "another-folder",
    })),
    /当前资源不一致/,
  );
  await assert.rejects(
    loadVideoDirectorySnapshot(target, async (_accountId, path) => {
      if (path === target.path) return root;
      throw new Error("读取中断");
    }),
    /读取中断/,
  );
});

test("malformed child names cannot escape the selected resource folder", async () => {
  for (const name of [".", "..", "子目录/../../别处", "子目录\\别处"]) {
    const calls: string[] = [];
    await assert.rejects(
      loadVideoDirectorySnapshot(target, async (_accountId, path) => {
        calls.push(path);
        return directory("root", target.path, [file("bad", name, true)]);
      }),
      /文件夹名称或路径不正确/,
    );
    assert.deepEqual(calls, [target.path]);
  }
});

test("restore validates the exact target and malformed snapshots instead of reusing another source", () => {
  const snapshot = videoDirectorySnapshot(
    target,
    directory("root", target.path, [file("one", "测试题.pdf")]),
  );
  assert.deepEqual(
    readVideoDirectorySnapshot(JSON.stringify(snapshot), target),
    snapshot,
  );
  assert.equal(readVideoDirectorySnapshot(undefined, target), null);
  assert.throws(
    () => readVideoDirectorySnapshot("{broken", target),
    /原记录已保留/,
  );
  assert.throws(
    () =>
      readVideoDirectorySnapshot(JSON.stringify(snapshot), {
        ...target,
        id: "other",
      }),
    /原记录已保留/,
  );
  assert.throws(
    () =>
      readVideoDirectorySnapshot(
        JSON.stringify({ ...snapshot, total: 20 }),
        target,
      ),
    /原记录已保留/,
  );
});
