import test from "node:test";
import assert from "node:assert/strict";
import { BaiduProvider } from "../core/providers/baidu";
import { fixture, file } from "./helpers";

// /share/set response fields and marker pair verified against official 13.37.9.
const word = "囟梨霹稀勺轩且诈竌千";
for (const command of [
  word,
  undefined,
  "",
  "legacy-alphanumeric",
  "坏\n字段",
]) {
  test(`百度建链原请求获取中文口令：${command === word ? "官方返回" : JSON.stringify(command)}`, async () => {
    const f = await fixture();
    let writes = 0;
    const returned: unknown[] = [];
    try {
      const provider = new BaiduProvider({
        text: async () => assert.fail("回执模式不访问分享页"),
        async json(_id, raw, init) {
          const url = new URL(raw);
          if (url.pathname === "/api/gettemplatevariable")
            return {
              errno: 0,
              result: { uk: "owner-1", bdstoken: "fixture-token" },
            };
          assert.equal(url.pathname, "/share/set");
          const body = new URLSearchParams(String(init?.body));
          assert.equal(body.get("fid_list"), JSON.stringify([file.id]));
          assert.equal(body.get("share_type"), "9");
          assert.equal(body.get("command_type"), "1");
          assert.equal(body.get("pwd"), "8002");
          assert.equal(body.get("period"), "1");
          writes++;
          return {
            errno: 0,
            shareid: "receipt-id",
            link: "https://pan.baidu.com/s/1new",
            command_word: command,
          };
        },
      });
      const share = await provider.createShareWithOptions(
        f.account,
        [file],
        "资料",
        { expiresInDays: 1, extractionCode: "8002" },
        async (value) => {
          returned.push(value);
        },
        "receipt",
      );
      assert.equal(
        share.passphrase,
        command === word ? `@@${word}#` : undefined,
      );
      assert.equal(share.url, "https://pan.baidu.com/s/1new");
      assert.equal(share.code, "8002");
      assert.equal(writes, 1, "未返回口令也不重复创建或调用备用建链接口");
      assert.deepEqual(returned, [share], "第一份建链回执已包含口令");
    } finally {
      await f.cleanup();
    }
  });
}
