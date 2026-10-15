import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSplitTree,
  selectSplitLevel,
  visibleSplitNodes,
} from "../src/split-tree";
import type { RemoteFile, SplitItem } from "../shared/types";

const folder = (id: string, name = id): RemoteFile => ({
  id,
  name,
  isDirectory: true,
  size: null,
  parentId: "0",
});
const file = (id: string, name = id): RemoteFile => ({
  ...folder(id, name),
  isDirectory: false,
  size: 1,
});
function item(file: RemoteFile, ancestors: RemoteFile[] = []): SplitItem {
  return {
    id: `item-${file.id}`,
    copyId: "copy",
    file,
    ancestors,
    depth: ancestors.length + 1,
    path: [...ancestors, file].map((f) => f.name).join(" / "),
    status: "draft",
    shareId: null,
    shareUrl: null,
    ownerUid: null,
    verifiedAt: null,
    error: null,
    jobId: null,
    shareVersion: 0,
    stage: null,
  };
}
const course = folder("course", "课程"),
  chapter = folder("chapter", "第一章"),
  deep = folder("deep", "更深目录");
const items = [
  item(course),
  item(file("intro", "简介.txt"), [course]),
  item(chapter, [course]),
  item(file("video", "视频.mp4"), [course, chapter]),
  item(deep, [course, chapter]),
  item(file("readme", "说明.txt")),
  item(folder("empty", "空目录")),
];

test("directory tree preserves ID identity, hierarchy, and historical context-only parents", () => {
  const rows = buildSplitTree([
    item(file("one", "相同.txt"), [folder("a", "重复 / 名称")]),
    item(file("two", "相同.txt"), [folder("b", "重复 / 名称")]),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].item, undefined);
  assert.deepEqual(
    rows.flatMap((r) => r.children.map((c) => c.id)),
    ["one", "two"],
  );
  const current = buildSplitTree(items);
  assert.equal(
    current
      .find((r) => r.id === "course")
      ?.children.find((r) => r.id === "chapter")?.children.length,
    2,
  );
  assert.equal(visibleSplitNodes(current, new Set(), "").length, 7);
});

test("level shortcuts preserve shallow files and empty folders without parent-child overlap", () => {
  const rows = buildSplitTree(items);
  assert.deepEqual(
    new Set(selectSplitLevel(rows, 1)),
    new Set(["item-course", "item-readme", "item-empty"]),
  );
  assert.deepEqual(
    new Set(selectSplitLevel(rows, 2)),
    new Set(["item-intro", "item-chapter", "item-readme", "item-empty"]),
  );
  assert.deepEqual(
    new Set(selectSplitLevel(rows, 3)),
    new Set([
      "item-intro",
      "item-video",
      "item-deep",
      "item-readme",
      "item-empty",
    ]),
  );
  const legacy = buildSplitTree(
    items.filter((i) => !["course", "chapter"].includes(i.file.id)),
  );
  assert.equal(selectSplitLevel(legacy, 1).length, 2);
  assert.equal(selectSplitLevel(legacy, 3).length, 5);
});

test("collapse hides descendants; search reveals matching ancestors without mutating collapse state", () => {
  const rows = buildSplitTree(items),
    collapsed = new Set(["course"]);
  assert.equal(visibleSplitNodes(rows, collapsed, "").length, 3);
  assert.deepEqual(
    visibleSplitNodes(rows, collapsed, " 视频.MP4 ").map((n) => n.id),
    ["course", "chapter", "video"],
  );
  assert.deepEqual(
    visibleSplitNodes(rows, collapsed, "第一章").map((n) => n.id),
    ["course", "chapter", "deep", "video"],
  );
  assert.equal(visibleSplitNodes(rows, collapsed, "不存在").length, 0);
  assert.deepEqual([...collapsed], ["course"]);
});
