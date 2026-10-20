import test from "node:test";
import assert from "node:assert/strict";
import { createIpcRegistry } from "../core/ipc/registry";
import type { IpcHandler } from "../core/ipc/types";

test("IPC rejects duplicate domain registrations instead of replacing commands", () => {
  assert.throws(
    () =>
      createIpcRegistry(
        { "account.add": () => "first" },
        { "account.add": () => "second" },
      ),
    { code: "DUPLICATE_IPC_METHOD" },
  );
});

test("IPC routes aliases with the original method and contains unknown commands", async () => {
  const calls: { method: string; input: unknown }[] = [];
  const control: IpcHandler = (input, method) => {
    calls.push({ method, input });
    return method;
  };
  const registry = createIpcRegistry({
    "batch.cancel": control,
    "batch.retry": control,
  });
  assert.equal(
    await registry.invoke("batch.cancel", { id: "one" }),
    "batch.cancel",
  );
  assert.equal(
    await registry.invoke("batch.retry", { id: "two" }),
    "batch.retry",
  );
  for (const method of ["batch.typo", "toString", "constructor", "__proto__"]) {
    await assert.rejects(registry.invoke(method, {}), {
      code: "UNKNOWN_METHOD",
    });
  }
  assert.deepEqual(calls, [
    { method: "batch.cancel", input: { id: "one" } },
    { method: "batch.retry", input: { id: "two" } },
  ]);
});
