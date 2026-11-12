import test from "node:test";
import assert from "node:assert/strict";
import { runtimeDataPath } from "../desktop/runtime-paths";
import { join, resolve } from "node:path";
test("desktop runtimes use a common data root for their lock and workspace selection", () => {
  const base = resolve("application-data");
  assert.equal(runtimeDataPath(base), join(base, "盘序"));
});

test("explicit test workspace paths remain supported and must be absolute", () => {
  const base = resolve("application-data");
  assert.equal(
    runtimeDataPath(base, resolve("test-profile")),
    resolve("test-profile"),
  );
  assert.throws(
    () => runtimeDataPath(base, "relative/path"),
    /绝对路径/,
  );
});
