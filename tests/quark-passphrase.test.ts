import test from "node:test";
import assert from "node:assert/strict";
import { createQuarkPassphrases } from "../core/providers/quark-passphrase";
import { QuarkProvider } from "../core/providers/quark";
import { fixture, file } from "./helpers";
import type { OwnShare } from "../core/providers/provider";

const word = "祄二七三一并词玄页娃枫汢";
const share: OwnShare = {
  id: "existing",
  url: "https://pan.quark.cn/s/owned",
  code: "8002",
  ownerUid: "owner-1",
};
test("官方桌面协议：签名排序、中文生成、回解析校验链接和提取码，无账号 Cookie", async () => {
  let scopes = 0;
  const signedInputs: string[] = [];
  const calls: { path: string; body: Record<string, string> }[] = [];
  const generator = createQuarkPassphrases({
    async withSigner(action) {
      scopes++;
      return action(async (value) => {
        signedInputs.push(value);
        return "fixture-sign";
      });
    },
    async request(raw, init) {
      const url = new URL(raw),
        body = JSON.parse(String(init.body));
      calls.push({ path: url.pathname, body });
      assert.equal(url.origin, "https://utoken2.uc.cn");
      assert.equal(init.credentials, "omit");
      assert(!new Headers(init.headers).has("cookie"));
      assert.equal(body.sign, "fixture-sign");
      if (url.pathname.endsWith("create")) {
        const target = "https://pan.quark.cn/s/owned?pwd=8002&way=u_token";
        assert.equal(
          signedInputs[0],
          `${target}QUARKquark_cloud_disk立即查看来自剪切板资料${target}auto3_c_code${body.timestamp}`,
        );
        assert.equal(body.shareCode, "auto3_c_code");
        assert.equal(body.app, "QUARK");
        assert.equal(new URL(body.androidUrl).searchParams.get("pwd"), "8002");
        assert(!("reflowExtInfo" in body), "使用已实测的桌面请求形态");
        return Response.json({
          success: true,
          code: "OK",
          data: { value: word },
        });
      }
      assert.equal(body.clipboard, word);
      assert.equal(signedInputs[1], `QUARK${word}!xxxxxxxx${body.timestamp}`);
      return Response.json({
        success: true,
        code: "OK",
        data: {
          androidUrl: "https://pan.quark.cn/s/owned?pwd=8002&way=u_token",
          iosUrl: "https://pan.quark.cn/s/owned?pwd=8002&way=u_token",
        },
      });
    },
  });
  assert.equal(await generator.create(share, "资料", "auto3_c_code"), word);
  assert.equal(scopes, 1);
  assert.equal(calls.length, 2);
});
for (const failure of [
  "wrong-share",
  "wrong-code",
  "no-url",
  "ordinary-token",
  "remote-failed",
]) {
  test(`口令失败不接受伪成功：${failure}`, async () => {
    const generator = createQuarkPassphrases({
      withSigner: (action) => action(async () => "sign"),
      request: async (raw) => {
        if (new URL(raw).pathname.endsWith("create"))
          return Response.json({
            success: failure !== "remote-failed",
            code: failure === "remote-failed" ? "ERROR" : "OK",
            data: {
              value: failure === "ordinary-token" ? "~ordinary~:/" : word,
            },
          });
        return Response.json({
          success: true,
          code: "OK",
          data:
            failure === "no-url"
              ? {}
              : {
                  androidUrl:
                    failure === "wrong-share"
                      ? "https://pan.quark.cn/s/other?pwd=8002"
                      : "https://pan.quark.cn/s/owned?pwd=wrong",
                },
        });
      },
    });
    await assert.rejects(generator.create(share, "资料", "auto3_c_code"));
  });
}

test("新建夸克分享自动取得中文方案；口令服务失败仍返回同一个已创建链接及明确原因", async () => {
  const f = await fixture();
  try {
    for (const fail of [false, true]) {
      let writes = 0,
        generated = 0;
      const provider = new QuarkProvider(
        {
          text: async () => "",
          json: async (_id, raw, init) => {
            const path = new URL(raw).pathname;
            if (path.endsWith("/share")) {
              writes++;
              return { code: 0, data: { share_id: share.id } };
            }
            if (path.endsWith("share/password")) {
              const input = JSON.parse(String(init?.body));
              assert.equal(input.distribute_share_plan, 1);
              assert.equal(input.utoken_version, "v2");
              return {
                code: 0,
                data: {
                  share_url: share.url,
                  passcode: share.code,
                  command_type: 1,
                  plan_id: "auto3_c_code",
                },
              };
            }
            if (path === "/account/info")
              return {
                code: "OK",
                success: true,
                data: { uid: share.ownerUid },
              };
            throw Error("Unexpected request " + path);
          },
        },
        "quark",
        {
          create: async (value, _title, plan) => {
            generated++;
            assert.equal(value.id, share.id);
            assert.equal(plan, "auto3_c_code");
            if (fail) throw Error("官方组件不可用");
            return word;
          },
        },
      );
      provider.verifyShare = async () => true;
      const result = await provider.createShare(f.account, [file], "资料");
      assert.equal(writes, 1);
      assert.equal(generated, 1);
      assert.equal(result.url, share.url);
      assert.equal(result.passphrase, fail ? undefined : word);
      assert.equal(result.passphraseIssue, fail ? "官方组件不可用" : undefined);
      if (fail)
        await assert.rejects(provider.readSharePassphrase(f.account, result));
      else
        assert.equal(
          await provider.readSharePassphrase(f.account, result),
          word,
        );
      assert.equal(writes, 1, "补取口令不创建新分享");
      await assert.rejects(
        provider.readSharePassphrase(f.account, { ...result, code: "wrong" }),
        { code: "PASSPHRASE_SHARE_MISMATCH" },
      );
    }
  } finally {
    await f.cleanup();
  }
});
