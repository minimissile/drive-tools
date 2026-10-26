import { test } from "node:test";
import assert from "node:assert/strict";
import {
  otherAccountActions,
  type OtherAccount,
} from "../src/accounts/useOtherAccounts";

test("其他账号按平台调用原账号接口，保留各自账号 ID", async () => {
  const calls: { method: string; args: any }[] = [];
  const oldWindow = globalThis.window;
  globalThis.window = {
    panxu: {
      invoke: async (method: string, args: any) => {
        calls.push({ method, args });
        return { id: method === "zhidao.account.add" ? "known-1" : "web_1" };
      },
    },
  } as any;
  try {
    for (const provider of ["baidu-zhidao", "baidu-marketing"] as const) {
      calls.length = 0;
      const created = await otherAccountActions.add(
        provider,
        " 测试备注 ",
        "qa-cookie",
      );
      const account = {
        ...created,
        alias: "测试备注",
        status: "connected",
        windowOpen: false,
        message: "",
        uid: null,
      } as OtherAccount;
      await otherAccountActions.login(account);
      await otherAccountActions.check(account);
      await otherAccountActions.rename(account, "新备注");
      await otherAccountActions.remove(account);
      const isKnown = provider === "baidu-zhidao";
      const prefix = isKnown ? "zhidao.account" : "websiteAccounts";
      assert.deepEqual(
        calls.map((c) => c.method),
        ["add", "login", "check", isKnown ? "update" : "rename", "remove"].map(
          (s) => `${prefix}.${s}`,
        ),
      );
      assert.deepEqual(
        calls[0].args,
        isKnown
          ? { alias: "测试备注", cookie: "qa-cookie" }
          : { provider, alias: "测试备注" },
      );
      for (const call of calls.slice(1)) assert.equal(call.args.id, created.id);
      assert.equal(calls[4].args.confirmed, true);
      assert.equal(
        created.key,
        `${isKnown ? "zhidao" : "website"}:${created.id}`,
      );
    }
  } finally {
    if (oldWindow) globalThis.window = oldWindow;
    else Reflect.deleteProperty(globalThis, "window");
  }
});
