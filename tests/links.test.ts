import test from "node:test";
import assert from "node:assert/strict";
import {
  parseShare,
  validateEditorUrl,
  validateLoopback,
  validateOutgoingLinks,
} from "../core/links";
import { extractBaiduShareData } from "../core/providers/baidu";
import { AccountMutex } from "../core/queue";
test("安全解析分享链接、提取码和百度surl", () => {
  assert.deepEqual(
    parseShare("资料 https://pan.quark.cn/s/abcd 提取码：x1y2"),
    {
      provider: "quark",
      shareKey: "abcd",
      url: "https://pan.quark.cn/s/abcd",
      code: "x1y2",
    },
  );
  assert.equal(
    parseShare("https://pan.baidu.com/share/init?surl=abcdef&pwd=qwer").url,
    "https://pan.baidu.com/s/1abcdef",
  );
  for (const bad of [
    "https://pan.quark.cn.evil.test/s/abc",
    "https://x@pan.quark.cn/s/abc",
    "https://pan.baidu.com:8080/s/abc",
  ])
    assert.throws(() => parseShare(bad));
  assert.throws(
    () =>
      validateOutgoingLinks(
        "https://pan.quark.cn/s/source",
        "https://pan.quark.cn/s/own",
        true,
      ),
    { code: "FOREIGN_SHARE_BLOCKED" },
  );
  assert.throws(
    () =>
      validateOutgoingLinks(
        "https://pan.quark.cn/s/own",
        "https://pan.quark.cn/s/own",
        false,
      ),
    { code: "CHANNEL_LINK_BLOCKED" },
  );
});
test("比特接口限定本机，编辑器域名按平台验证", () => {
  assert.equal(
    validateLoopback("http://127.0.0.1:54345").hostname,
    "127.0.0.1",
  );
  for (const bad of [
    "http://192.168.1.1",
    "http://localhost.evil.test",
    "file:///etc/passwd",
    "http://a@localhost",
    "http://localhost?key=1",
  ])
    assert.throws(() => validateLoopback(bad));
  assert.throws(() => validateEditorUrl("x", "https://creator.douyin.com/"));
  assert.equal(
    validateEditorUrl("x", "https://x.com/compose/post"),
    "https://x.com/compose/post",
  );
});
test("百度HTML只读取JSON数据字面量，不执行页面脚本", () => {
  assert.equal(
    extractBaiduShareData(
      'try { locals.mset({"shareid":123,"share_uk":456,"loginstate":1,"nested":{"a":"}test"}}); }',
    ).shareid,
    123,
  );
  assert.throws(
    () =>
      extractBaiduShareData(
        "locals.mset({loginstate:1,shareid:123}); process.exit();",
      ),
    { code: "SHARE_PAGE_CHANGED" },
  );
});
test("同账号串行，不同账号可并行；异常释放锁", async () => {
  const lock = new AccountMutex(),
    events: string[] = [];
  await Promise.all([
    lock.run("a", async () => {
      events.push("a1");
      await new Promise((r) => setTimeout(r, 15));
      events.push("a1end");
    }),
    lock.run("a", async () => {
      events.push("a2");
    }),
    lock.run("b", async () => {
      events.push("b");
    }),
  ]);
  assert.ok(events.indexOf("b") < events.indexOf("a1end"));
  assert.ok(events.indexOf("a2") > events.indexOf("a1end"));
  await assert.rejects(
    lock.run("a", async () => {
      throw new Error("x");
    }),
  );
  assert.equal(await lock.run("a", async () => 1), 1);
});
