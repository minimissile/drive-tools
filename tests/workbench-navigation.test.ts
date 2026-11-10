import test from "node:test";
import assert from "node:assert/strict";
import { allowDevelopmentWorkbenchReload } from "../desktop/workbench-navigation";

const entry = "http://127.0.0.1:8070/";
test("开发窗口允许重新加载当前工作台，Vite断线恢复能真正刷新界面", () => {
  assert.equal(
    allowDevelopmentWorkbenchReload(true, entry, entry, entry),
    true,
  );
  assert.equal(
    allowDevelopmentWorkbenchReload(true, entry.slice(0, -1), entry, entry),
    true,
  );
});
test("其他页面、端口、查询、凭据和伪装地址均不能从工作台跳转", () => {
  for (const target of [
    "https://example.com/",
    "http://127.0.0.1:8071/",
    "http://localhost:8070/",
    "http://127.0.0.1:8070/other",
    "http://127.0.0.1:8070/?url=external",
    "http://127.0.0.1:8070/#external",
    "http://user:pass@127.0.0.1:8070/",
    "http://127.0.0.1.attacker.test:8070/",
    "javascript:alert(1)",
    "file:///tmp/index.html",
    "not-a-url",
  ])
    assert.equal(
      allowDevelopmentWorkbenchReload(true, entry, entry, target),
      false,
      target,
    );
  assert.equal(
    allowDevelopmentWorkbenchReload(
      true,
      entry,
      "http://127.0.0.1:8070/other",
      entry,
    ),
    false,
  );
});
test("生产窗口继续阻止全部页面导航，异常开发入口也不能放行", () => {
  assert.equal(
    allowDevelopmentWorkbenchReload(false, entry, entry, entry),
    false,
  );
  for (const invalid of [
    "https://example.com/",
    "file:///tmp/index.html",
    entry + "?x=1",
    entry + "other",
    "bad",
  ])
    assert.equal(
      allowDevelopmentWorkbenchReload(true, invalid, invalid, invalid),
      false,
    );
});
