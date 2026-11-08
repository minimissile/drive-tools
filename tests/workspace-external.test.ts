import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";

const methods = ["system.external", "zhidao.open"] as const;

test("外部跳转统一允许任意 HTTP/HTTPS 网页，不依赖渠道域名或文章路径", async () => {
  const f = await fixture();
  try {
    const opened: string[] = [];
    f.ports.openExternal = async (url) => {
      opened.push(url);
    };
    const urls = [
      "https://panxu.site/c/dbedf7b723e3468e",
      "https://panxu.site/r/resource",
      "https://custom-catalog.example.test/c/new-catalog",
      "https://pan.quark.cn/s/share-id",
      "https://pan.baidu.com/s/share-id?pwd=abcd",
      "https://docs.qq.com/doc/example",
      "https://zhuanlan.zhihu.com/p/123",
      "https://mp.weixin.qq.com/s/0GJakdWE1Pwk1AihifGKRA",
      "https://mp.weixin.qq.com/s?__biz=publisher&mid=123&idx=1&sn=signature#rd",
      `https://mp.weixin.qq.com/s?__biz=publisher&mid=123&idx=1&sn=signature&from=${"a".repeat(2100)}`,
      "https://mp.weixin.qq.com/cgi-bin/home",
      "https://openrouter.ai/docs/quickstart",
      `https://openrouter.ai/docs/${"a".repeat(2100)}`,
      "http://example.test/catalog?id=1#resources",
      "http://127.0.0.1:8070/catalog",
      "https://example.test:8443/catalog",
      "HTTPS://EXAMPLE.TEST:443/资料?q=中文#正文",
    ];
    for (const method of methods) {
      for (const url of urls) {
        assert.equal(await f.app.invoke(method, { url }), true);
      }
    }
    const normalized = urls.map((url) => new URL(url).href);
    assert.deepEqual(opened, [...normalized, ...normalized]);
  } finally {
    await f.cleanup();
  }
});

test("两个跳转入口均拒绝非网页协议与包含凭据的地址，不调用系统浏览器", async () => {
  const f = await fixture();
  try {
    let openings = 0;
    f.ports.openExternal = async () => {
      openings++;
    };
    for (const method of methods) {
      for (const url of [
        "https://someone:secret@mp.weixin.qq.com/s/abc",
        "http://someone:secret@example.test/catalog",
        "https://someone@example.test/catalog",
        "javascript:alert(1)",
        "data:text/html,example",
        "file:///tmp/example.html",
        "mailto:example@example.test",
        "smb://example.test/share",
        "custom-app://open/example",
      ]) {
        await assert.rejects(f.app.invoke(method, { url }), {
          code: "EXTERNAL_URL_BLOCKED",
        });
      }
      for (const url of [
        "",
        "not a URL",
        "/catalog",
        `https://example.test/${"a".repeat(4000)}`,
      ]) {
        await assert.rejects(f.app.invoke(method, { url }));
      }
    }
    assert.equal(openings, 0);
  } finally {
    await f.cleanup();
  }
});
