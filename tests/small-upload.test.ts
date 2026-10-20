import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  gcid,
  storageUrl,
  uploadOss,
  uploadS3,
  digest,
  type UploadAsset,
} from "../core/providers/small-upload";
import { QuarkProvider } from "../core/providers/quark";
import { UcProvider } from "../core/providers/uc";
import { BaiduProvider } from "../core/providers/baidu";
import { TokenDriveProvider } from "../core/providers/token-drive";
import { GuangyaProvider } from "../core/providers/guangya";
import type { Account } from "../shared/types";
import type { ProviderTransport } from "../core/providers/provider";
const account = { id: "test-account" } as Account,
  asset: UploadAsset = {
    name: "说明.txt",
    mime: "text/plain;charset=utf-8",
    bytes: Buffer.from("测试资料说明"),
  };
const params = {
  endpoint: "oss-cn-hangzhou.aliyuncs.com",
  bucket: "test-bucket",
  key: "中文目录/说明.txt",
  accessKey: "temporary-access",
  secret: "temporary-secret",
  token: "temporary-session",
};
async function mockStorage(
  fn: (requests: { url: string; init: RequestInit }[]) => Promise<void>,
) {
  const original = globalThis.fetch,
    requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return new Response("<CompleteMultipartUploadResult/>", {
      status: 200,
      headers: { ETag: '"ABCDEF123456"' },
    });
  };
  try {
    await fn(requests);
  } finally {
    globalThis.fetch = original;
  }
}
test("storage upload rejects unknown hosts, credentials in URL and plaintext endpoints before network", () => {
  for (const u of [
    "http://oss.aliyuncs.com/a",
    "https://evil.test/a",
    "https://oss.aliyuncs.com.evil.test/a",
    "https://u:p@oss.aliyuncs.com/a",
    "https://oss.aliyuncs.com:444/a",
  ])
    assert.throws(() => storageUrl("quark", u), {
      code: "INVALID_UPLOAD_HOST",
    });
  assert.equal(
    storageUrl("quark", "https://test.oss-cn-hangzhou.aliyuncs.com/a").protocol,
    "https:",
  );
});
test("GCID handles empty files and block boundaries rather than ordinary SHA1", () => {
  assert.equal(
    gcid(Buffer.alloc(0)),
    "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709",
  );
  const bytes = Buffer.alloc(0x40001, 97),
    parts = [bytes.subarray(0, 0x40000), bytes.subarray(0x40000)];
  const expected = createHash("sha1")
    .update(
      Buffer.concat(parts.map((p) => createHash("sha1").update(p).digest())),
    )
    .digest("hex")
    .toUpperCase();
  assert.equal(gcid(bytes), expected);
  assert.notEqual(gcid(bytes), digest("sha1", bytes).toUpperCase());
});
test("OSS and S3 put use temporary signatures only, escaped paths and no redirects", async () =>
  mockStorage(async (calls) => {
    await uploadOss("pikpak", params, asset);
    await uploadS3(
      "xunlei",
      { ...params, endpoint: "https://upload.xunlei.com" },
      asset,
    );
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.init.method, "PUT");
      assert.equal(call.init.credentials, "omit");
      assert.equal(call.init.redirect, "error");
      assert.ok(!new Headers(call.init.headers).has("cookie"));
      assert.ok(call.url.includes("%E4%B8%AD"));
    }
    assert.match(
      new Headers(calls[0].init.headers).get("authorization")!,
      /^OSS temporary-access:/,
    );
    assert.equal(
      new Headers(calls[0].init.headers).get("content-md5"),
      digest("md5", asset.bytes, "base64"),
    );
    assert.match(
      new Headers(calls[1].init.headers).get("authorization")!,
      /AWS4-HMAC-SHA256.*\/xunlei\/s3\/aws4_request/,
    );
  }));
for (const provider of ["quark", "uc"] as const)
  test(`${provider} file upload uses preflight, hash, authorized multipart and finish`, async () =>
    mockStorage(async (storage) => {
      const calls: { path: string; body: any }[] = [];
      const transport: ProviderTransport = {
        text: async () => "",
        json: async (_id, text, init) => {
          const path = new URL(text).pathname.replace("/1/clouddrive/", "");
          const body = JSON.parse(String(init?.body));
          calls.push({ path, body });
          if (path === "file/upload/pre")
            return {
              code: 0,
              data: {
                task_id: "t",
                upload_id: "u",
                obj_key: "object.txt",
                upload_url: "https://oss-cn-hangzhou.aliyuncs.com",
                bucket: "bucket",
                auth_info: "temporary",
                callback: {
                  callbackUrl: "https://callback.test/",
                  callbackBody: "x",
                },
              },
              metadata: { part_size: 1024 },
            };
          if (path === "file/update/hash")
            return { code: 0, data: { finish: false } };
          if (path === "file/upload/auth")
            return { code: 0, data: { auth_key: "temporary-auth" } };
          if (path === "file/upload/finish") return { code: 0, data: {} };
          throw Error("unexpected " + path);
        },
      };
      const p =
        provider === "quark"
          ? new QuarkProvider(transport)
          : new UcProvider(transport);
      await p.upload(account, "parent", asset);
      assert.deepEqual(
        calls.map((c) => c.path),
        [
          "file/upload/pre",
          "file/update/hash",
          "file/upload/auth",
          "file/upload/auth",
          "file/upload/finish",
        ],
      );
      assert.equal(calls[0].body.pdir_fid, "parent");
      assert.equal(calls[1].body.md5, digest("md5", asset.bytes));
      assert.equal(storage.length, 2);
      assert.match(String(storage[1].init.body), /<PartNumber>1<\/PartNumber>/);
      assert.equal(calls.at(-1)?.body.task_id, "t");
    }));
test("Baidu web upload submits no-overwrite precreate, verifies block MD5 and commits the same path", async () => {
  const calls: { url: URL; body: any }[] = [];
  const transport: ProviderTransport = {
    text: async () => "",
    json: async (_id, text, init) => {
      const url = new URL(text),
        body =
          init?.body instanceof FormData
            ? init.body
            : Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      calls.push({ url, body });
      if (url.pathname === "/api/gettemplatevariable")
        return { errno: 0, result: { uk: "owner", bdstoken: "token" } };
      if (url.pathname === "/api/precreate")
        return { errno: 0, uploadid: "upload-id", return_type: 1 };
      if (url.hostname === "d.pcs.baidu.com") {
        assert.ok(body instanceof FormData);
        return { md5: digest("md5", asset.bytes) };
      }
      if (url.pathname === "/api/create") return { errno: 0, fs_id: 123 };
      throw Error("unexpected");
    },
  };
  await new BaiduProvider(transport).upload(account, "/我的资料", asset);
  assert.equal(calls.length, 4);
  assert.equal(calls[1].body.rtype, "0");
  assert.equal(calls[3].body.rtype, "0");
  assert.equal(calls[1].body.path, "/我的资料/说明.txt");
  assert.equal(calls[3].body.path, calls[1].body.path);
});
for (const kind of ["xunlei", "pikpak"] as const)
  test(`${kind} obtains temporary storage credentials and uses provider-specific signing`, async () =>
    mockStorage(async (storage) => {
      const calls: any[] = [];
      const transport: ProviderTransport = {
        text: async () => "",
        authHeaders: async () => ({ authorization: "Bearer account-session" }),
        json: async (_id, text, init) => {
          const body = JSON.parse(String(init?.body));
          calls.push(body);
          return {
            file: { id: "uploaded-file" },
            resumable: {
              params: {
                endpoint:
                  kind === "xunlei"
                    ? "https://upload.xunlei.com"
                    : "https://mypikpak.net",
                bucket: "bucket",
                key: "object.txt",
                access_key_id: "temporary-access",
                access_key_secret: "temporary-secret",
                security_token: "temporary-session",
              },
            },
          };
        },
      };
      await new TokenDriveProvider(transport, kind).upload(
        account,
        "target-id",
        asset,
      );
      assert.equal(calls[0].parent_id, "target-id");
      assert.equal(calls[0].hash, gcid(asset.bytes));
      assert.equal(storage.length, 1);
      assert.ok(
        !String(
          new Headers(storage[0].init.headers).get("authorization"),
        ).includes("account-session"),
      );
    }));
test("Guangya current web upload uses v2 token with dt=4 and temporary OSS credentials", async () =>
  mockStorage(async (storage) => {
    const calls: any[] = [];
    const transport: ProviderTransport = {
      text: async () => "",
      authHeaders: async () => ({ authorization: "Bearer account-session" }),
      json: async (_id, text, init) => {
        calls.push({ text, init, body: JSON.parse(String(init?.body)) });
        return {
          code: 0,
          data: {
            taskId: "task",
            ...{
              endPoint: params.endpoint,
              bucketName: params.bucket,
              objectPath: params.key,
              creds: {
                accessKeyID: params.accessKey,
                secretAccessKey: params.secret,
                sessionToken: params.token,
              },
            },
          },
        };
      },
    };
    await new GuangyaProvider(transport).upload(account, "target", asset);
    assert.equal(
      new URL(calls[0].text).pathname,
      "/userres/v2/get_res_center_token",
    );
    assert.equal(new Headers(calls[0].init.headers).get("dt"), "4");
    assert.equal(calls[0].body.res.md5, digest("md5", asset.bytes));
    assert.equal(storage.length, 1);
  }));
test("Guangya instant upload code156 does not repeat a storage write", async () =>
  mockStorage(async (storage) => {
    const transport: ProviderTransport = {
      text: async () => "",
      authHeaders: async () => ({ authorization: "Bearer session" }),
      json: async () => ({ code: 156, data: { taskId: "instant" } }),
    };
    await new GuangyaProvider(transport).upload(account, "target", asset);
    assert.equal(storage.length, 0);
  }));
