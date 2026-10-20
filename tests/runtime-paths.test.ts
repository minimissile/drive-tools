import test from "node:test";
import assert from "node:assert/strict";
import { runtimeDataPath } from "../desktop/runtime-paths";
import { join, resolve } from "node:path";
test("development and production profiles isolate databases, cookies and restore pointers", () => {
  const base = resolve("application-data");
  assert.equal(runtimeDataPath(base, true), join(base, "盘序"));
  assert.equal(runtimeDataPath(base, false), join(base, "盘序开发"));
  assert.notEqual(runtimeDataPath(base, true), runtimeDataPath(base, false));
  assert.equal(
    runtimeDataPath(base, true, resolve("test-profile")),
    resolve("test-profile"),
  );
  assert.throws(
    () => runtimeDataPath(base, false, "relative/path"),
    /绝对路径/,
  );
});
