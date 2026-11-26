import test from "node:test";
import assert from "node:assert/strict";
import { formatRuntimeLogs } from "../src/lib/runtime-log";
import type { RuntimeLogEntry } from "../shared/runtime-logs";
test("贴吧复制日志与显示一样最新在上；保留其他调用的默认顺序且不修改输入", () => {
  const items = [
    {
      id: 2,
      createdAt: "2026-11-25T10:01:00Z",
      level: "info",
      message: "最新一条",
      event: "new",
      taskId: null,
      details: {},
    },
    {
      id: 1,
      createdAt: "2026-11-25T10:00:00Z",
      level: "info",
      message: "旧的一条",
      event: "old",
      taskId: null,
      details: {},
    },
  ] as RuntimeLogEntry[];
  const newest = formatRuntimeLogs(items, () => "本人", { newestFirst: true });
  assert.ok(newest.indexOf("最新一条") < newest.indexOf("旧的一条"));
  const legacy = formatRuntimeLogs(items, () => "本人");
  assert.ok(legacy.indexOf("最新一条") > legacy.indexOf("旧的一条"));
  assert.deepEqual(
    items.map((i) => i.id),
    [2, 1],
  );
});
