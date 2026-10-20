import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { structuralShare } from "../src/lib/structural-share";
import { keywordMetrics } from "../src/traffic/knowledge";
import { ipc, shouldRefreshSnapshot } from "../src/api/client";
import { updateSelection } from "../src/lib/selection";

test("page selection preserves other pages, order and the original array", () => {
  const previous = ["previous-page", "visible-a"];
  const all = updateSelection(
    previous,
    ["visible-a", "visible-b", "visible-b"],
    true,
  );
  assert.deepEqual(all, ["previous-page", "visible-a", "visible-b"]);
  assert.deepEqual(previous, ["previous-page", "visible-a"]);
  assert.deepEqual(updateSelection(all, ["visible-a", "visible-b"], false), [
    "previous-page",
  ]);
});

test("selection limits apply to additions while removal remains possible at the limit", () => {
  const full = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(updateSelection(full, [100, 101], true, 100), full);
  const remaining = updateSelection(full, [25, 100], false, 25);
  assert.equal(remaining.length, 98);
  assert.ok(!remaining.includes(25) && !remaining.includes(100));
  assert.deepEqual(updateSelection([1, 2], [2, 3, 4], true, 3), [1, 2, 3]);
  assert.deepEqual(updateSelection([], [1, 2], true, 0), []);
});

test("snapshot changes preserve unrelated resource and account references", () => {
  const before = {
    accounts: [{ id: "a", alias: "主账号" }],
    resources: [{ id: "r", copies: [{ id: "c", status: "draft" }] }],
    settings: { model: "old" },
  };
  const received = { ...structuredClone(before), settings: { model: "new" } };
  const next = structuralShare(before, received);
  assert.equal(next.accounts, before.accounts);
  assert.equal(next.resources, before.resources);
  assert.equal(next.settings.model, "new");
  assert.equal(before.settings.model, "old");
  assert.equal(structuralShare(next, structuredClone(next)), next);
});

test("changed copies replace only their own branch, including removals and nulls", () => {
  const before = {
    resources: [
      { id: "a", copies: [{ id: "c", status: "draft" }] },
      { id: "b", copies: [] },
    ],
    selected: "a" as string | null,
  };
  const received = structuredClone(before);
  received.resources[0]!.copies[0]!.status = "ready";
  received.selected = null;
  const next = structuralShare(before, received);
  assert.notEqual(next.resources[0], before.resources[0]);
  assert.equal(next.resources[1], before.resources[1]);
  assert.equal(next.selected, null);
  assert.deepEqual(
    structuralShare({ a: 1, b: 2 }, { a: 1 } as { a: number; b?: number }),
    { a: 1 },
  );
});

test("read and export commands do not refresh unrelated snapshot state", () => {
  for (const method of [
    "search.get",
    "resourceExport.get",
    "publication.package",
    "system.copyText",
    "shareStats.export",
    "updater.check",
  ]) {
    assert.equal(shouldRefreshSnapshot(method), false, method);
  }
  for (const method of [
    "account.update",
    "resource.save",
    "draft.review",
    "pool.save",
  ])
    assert.equal(shouldRefreshSnapshot(method), true, method);
});

test("archived metrics retain valid scalars while excluding invalid pool data", () => {
  assert.deepEqual(
    keywordMetrics({
      index: 0,
      text: "低于10",
      missing: null,
      nested: { value: 2 },
      unknown: undefined,
      invalid: NaN,
      infinite: Infinity,
    }),
    { index: 0, text: "低于10", missing: null },
  );
});

test("shared UI does not import business state or the desktop bridge", () => {
  for (const file of readdirSync(new URL("../src/ui/", import.meta.url)).filter(
    (f) => f.endsWith(".tsx"),
  )) {
    const source = readFileSync(
      new URL(`../src/ui/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:useApp|window\.panxu|from ["']\.\.\/(?:state|api|resources|pages))/,
      file,
    );
  }
});

// These checks are validated by tsc and never invoke desktop services in tests.
if (false) {
  void ipc("resource.get", { id: "r" });
  // @ts-expect-error Unknown methods must be registered in the shared contract.
  void ipc("resource.typo", { id: "r" });
  // @ts-expect-error Resource identifiers are strings.
  void ipc("resource.get", { id: 7 });
  // @ts-expect-error Paid suggestion resubmission requires explicit acknowledgement.
  void ipc("traffic.resumeSuggestion", { id: "q" });
  void ipc("resourceExport.file", {
    runId: "r",
    ids: ["a"],
    columns: [],
    // @ts-expect-error Export formats use the supported format union.
    format: "exe",
  });
}
