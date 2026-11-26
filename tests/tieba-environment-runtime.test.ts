import test from "node:test";
import assert from "node:assert/strict";
import { withEnvironmentBrowser } from "../core/environment-browser-runtime";

test("贴吧共享网盘环境仍复用当前窗口；网盘/知乎保持后台模式约束", async () => {
  const env = {
    id: "env_shared",
    engine: "bitbrowser",
    profileId: "profile",
    connectorKey: "http://127.0.0.1:54345",
  };
  const accounts = [
    { kind: "drive", id: "drive", platform: "quark" },
    { kind: "website", id: "tieba", platform: "tieba" },
    { kind: "website", id: "zhihu", platform: "zhihu" },
  ];
  const calls: string[] = [];
  const environments = {
    forAccount: () => env,
    list: () => [{ ...env, accounts }],
  };
  const bit = {
    withProfile: async (_id: unknown, action: () => Promise<unknown>) => {
      calls.push("profile");
      return action();
    },
    withDriveProfile: async (
      _id: unknown,
      headful: unknown,
      action: () => Promise<unknown>,
    ) => {
      assert.equal(headful, false);
      calls.push("drive");
      return action();
    },
  };
  await withEnvironmentBrowser(
    environments as any,
    bit as any,
    { kind: "website", id: "tieba" },
    async () => {},
  );
  assert.deepEqual(calls, ["profile"]);
  for (const ref of [
    { kind: "website", id: "zhihu" },
    { kind: "drive", id: "drive" },
  ] as const)
    await withEnvironmentBrowser(
      environments as any,
      bit as any,
      ref,
      async () => {},
    );
  assert.deepEqual(calls, ["profile", "drive", "drive"]);
});
