import test from "node:test";
import assert from "node:assert/strict";
import { TiebaAutocare } from "../core/tieba-autocare/service";
import { fixture } from "./helpers";

test("应用启动即驱动贴吧调度，不依赖切换工作空间或测试手动tick；关闭后停止", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let ticks = 0;
  t.mock.method(TiebaAutocare.prototype, "tick", async () => {
    ticks++;
  });
  const f = await fixture();
  let closed = false;
  try {
    t.mock.timers.tick(9999);
    assert.equal(ticks, 0);
    t.mock.timers.tick(1);
    assert.equal(ticks, 1, "AppService正常启动必须注册贴吧调度器");
    await f.cleanup();
    closed = true;
    t.mock.timers.tick(30000);
    assert.equal(ticks, 1, "关闭后不得继续调度");
  } finally {
    if (!closed) await f.cleanup();
  }
});
