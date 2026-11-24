import test from "node:test";
import assert from "node:assert/strict";
import { BitBrowserManagement } from "../core/bitbrowser-management";
import { bitIdlePolicySchema } from "../shared/bitbrowser";
function fixture() {
  const input = {
    profileId: "fixture",
    connectorKey: "http://127.0.0.1:54345",
  };
  const key = JSON.stringify([input.connectorKey, input.profileId]);
  const env = {
    id: "env",
    engine: "bitbrowser",
    profileId: input.profileId,
    connectorKey: input.connectorKey,
    accounts: [],
    busy: false,
    revision: 1,
  };
  const state = {
    owner: "panxu",
    busy: false,
    lastUsed: 1,
    temporary: 1,
    protected: 0,
    connected: true,
    minutes: 10,
    pending: [] as string[],
    closed: 0,
    kept: 0,
    inspected: 0,
    control: 0,
    accountBusy: false,
  };
  const management = new BitBrowserManagement({
    connector: () => input.connectorKey,
    readIdlePolicy: () => state.minutes,
    saveIdlePolicy: (_key: string, minutes: number) => {
      state.minutes = minutes;
    },
    pendingOperations: () => state.pending,
    accountState: () => ({}),
    openAccount: async () => true,
    bit: {
      lifecycle: {
        key: () => key,
        touch: () => {},
        candidates: () => [key],
        info: () => state,
        inspect: async () => {
          state.inspected++;
          return {
            temporary: state.temporary,
            protected: state.protected,
            connected: state.connected,
            closed: 0,
          };
        },
      },
      keepWindow: async () => {
        state.kept++;
      },
      closeProfile: async () => {
        state.closed++;
      },
      withProfile: async (
        _id: string,
        fn: (context: any) => Promise<unknown>,
      ) => fn({ pages: () => [] }),
    },
    environments: {
      list: () => [env],
      assertAccountIdle: () => {
        if (state.accountBusy) throw Error("业务任务占用");
      },
      runEnvironment: async (
        _id: string,
        label: string,
        fn: () => Promise<unknown>,
      ) => {
        assert.notEqual(label, "window:clean");
        return fn();
      },
      controlWindow: async (_id: string, fn: () => Promise<unknown>) => {
        state.control++;
        if (state.accountBusy) throw Error("业务任务占用");
        return fn();
      },
    },
  } as any);
  return { management, state, env, input };
}
test("仅关闭已证明由盘序启动、超时且无任务无保留页的窗口", async () => {
  const f = fixture();
  try {
    await f.management.sweepIdle(600_002);
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.control, 1);
  } finally {
    f.management.dispose();
  }
});
test("手动窗口、草稿、排队、未确认发布、无法读取和业务占用均阻止空闲关闭", async () => {
  for (const patch of [
    { owner: "retained" },
    { busy: true },
    { protected: 1 },
    { pending: ["待核对发布"] },
    { connected: false },
    { accountBusy: true },
    { minutes: 0 },
  ]) {
    const f = fixture();
    Object.assign(f.state, patch);
    try {
      await f.management.sweepIdle(600_002);
      assert.equal(f.state.closed, 0, JSON.stringify(patch));
    } finally {
      f.management.dispose();
    }
  }
  const f = fixture();
  f.env.busy = true;
  try {
    await f.management.sweepIdle(600_002);
    assert.equal(f.state.closed, 0);
    await assert.rejects(() => f.management.cleanPages(f.input), /任务/);
  } finally {
    f.management.dispose();
  }
});
test("未达到空闲时长不关闭；手动打开显式保留，清理不发起启动", async () => {
  const f = fixture();
  try {
    await f.management.sweepIdle(500_000);
    assert.equal(f.state.closed, 0);
    assert.equal(f.state.inspected, 0);
    await f.management.open(f.input);
    assert.equal(f.state.kept, 1);
    await f.management.cleanPages(f.input);
    assert.equal(f.state.closed, 0);
    assert.equal(f.state.inspected, 1);
    f.management.idlePolicy({ ...f.input, idleMinutes: 30 });
    assert.equal(f.state.minutes, 30);
    await assert.rejects(
      () =>
        f.management.pages({
          ...f.input,
          connectorKey: "http://127.0.0.1:1111",
        }),
      /地址已变化/,
    );
  } finally {
    f.management.dispose();
  }
});
test("IPC仅接受显式的空闲预设，拒绝非法数值与缺失连接标识", () => {
  const input = {
    profileId: "fixture",
    connectorKey: "http://127.0.0.1:54345",
  };
  for (const idleMinutes of [0, 10, 30, 60])
    assert.equal(
      bitIdlePolicySchema.parse({ ...input, idleMinutes }).idleMinutes,
      idleMinutes,
    );
  for (const idleMinutes of [-1, 1, 10.5, "10", Infinity, null])
    assert.equal(
      bitIdlePolicySchema.safeParse({ ...input, idleMinutes }).success,
      false,
    );
});
