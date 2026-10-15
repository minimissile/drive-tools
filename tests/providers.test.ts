import test from "node:test";
import assert from "node:assert/strict";
import { fixture, file } from "./helpers";
import { QuarkProvider } from "../core/providers/quark";
import { BaiduProvider } from "../core/providers/baidu";
import { parseShare } from "../core/links";
import type { ProviderTransport } from "../core/providers/provider";
import { AppError, ProviderHttpError } from "../core/errors";
import { normalizeRemoteFile } from "../core/providers/provider";
test("网盘文件类型兼容数值和字符串标记，不将字符串0误判成目录", () => {
  for (const marker of [1, "1", true, 0, "0", false]) {
    const expected = [1, "1", true].includes(marker);
    assert.equal(
      normalizeRemoteFile(
        { fs_id: "123", server_filename: "教程", isdir: marker, size: 0 },
        "baidu",
        "0",
      ).isDirectory,
      expected,
    );
    assert.equal(
      normalizeRemoteFile(
        { fid: "abc", file_name: "教程", dir: marker, size: 0 },
        "quark",
        "0",
      ).isDirectory,
      expected,
    );
  }
});
test("夸克实名限制明确交给本人处理，HTTP拒绝与业务拒绝均不重复建链", async () => {
  const f = await fixture();
  try {
    for (const http of [true, false]) {
      let requests = 0;
      const p = new QuarkProvider({
        async text() {
          return "";
        },
        async json() {
          requests++;
          if (http)
            throw new ProviderHttpError(400, "32011", "user NOT real name");
          return { code: 32011, message: "user NOT real name" };
        },
      });
      await assert.rejects(
        p.createShare(f.account, [file], "测试"),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "USER_ACTION_REQUIRED");
          assert.match(error.message, /实名认证.*32011/);
          return true;
        },
      );
      assert.equal(requests, 1);
    }
  } finally {
    await f.cleanup();
  }
});
test("本人分享查找会跳过历史失效链接，并以first_fid和公开清单核验新分享", async () => {
  const f = await fixture();
  try {
    const p = new QuarkProvider({
      async text() {
        return "";
      },
      async json(_id, url, init) {
        const path = new URL(url).pathname;
        if (path === "/account/info")
          return {
            code: "OK",
            success: true,
            data: { uid: "owner-1", nickname: "本人" },
          };
        if (path.endsWith("share/mypage/detail"))
          return {
            code: 0,
            data: {
              list: [
                { share_id: "expired", file_num: 1, status: 1 },
                {
                  share_id: "mine",
                  file_num: 1,
                  status: 1,
                  first_fid: "own-file",
                },
              ],
            },
          };
        if (path.endsWith("share/password")) {
          const body = JSON.parse(String(init?.body));
          return {
            code: 0,
            data: {
              share_url: `https://pan.quark.cn/s/${body.share_id}`,
              passcode: "",
            },
          };
        }
        if (path.endsWith("share/sharepage/token")) {
          if (JSON.parse(String(init?.body)).pwd_id === "expired")
            throw new AppError(
              "PROVIDER_HTTP_ERROR",
              "HTTP 404（41019：分享地址已过期）",
            );
          return { code: 0, data: { stoken: "token" } };
        }
        if (path.endsWith("share/sharepage/detail"))
          return {
            code: 0,
            data: {
              list: [
                {
                  fid: "own-file",
                  file_name: file.name,
                  dir: false,
                  size: 120,
                },
              ],
            },
            metadata: { _total: 1 },
          };
        throw new Error(path);
      },
    });
    assert.equal(
      (await p.findOwnShare(f.account, [{ ...file, id: "own-file" }]))?.id,
      "mine",
    );
  } finally {
    await f.cleanup();
  }
});
test("夸克当前OK响应从隔离会话取得稳定账号ID；登录失败不接受残留ID", async () => {
  const f = await fixture();
  try {
    let valid = true;
    const p = new QuarkProvider({
      async text() {
        return "";
      },
      async principalId() {
        return "123456789";
      },
      async json() {
        return {
          success: valid,
          code: valid ? "OK" : "NOT_LOGIN",
          data: valid
            ? {
                nickname: "本人",
                avatarUri: "",
                mobilekps: "private",
                config: {},
              }
            : null,
        };
      },
    });
    assert.equal((await p.identity(f.account)).uid, "123456789");
    valid = false;
    await assert.rejects(p.identity(f.account), { code: "AUTH_EXPIRED" });
  } finally {
    await f.cleanup();
  }
});
test("夸克分享协议：任务取share_id，认证分享记录与文件清单双重核验", async () => {
  const f = await fixture();
  try {
    const calls: string[] = [],
      own = { ...file, id: "own-file" };
    const transport: ProviderTransport = {
      async text() {
        return "";
      },
      async json(_a, url, init) {
        const p = new URL(url).pathname;
        calls.push(p);
        if (p === "/account/info")
          return { data: { uid: "owner-1", nickname: "本人" } };
        if (p.endsWith("/share")) {
          assert.equal(JSON.parse(String(init?.body)).fid_list[0], "own-file");
          return { code: 0, data: { task_id: "share-task" } };
        }
        if (p.endsWith("/task"))
          return { code: 0, data: { status: 2, share_id: "share-1" } };
        if (p.endsWith("/share/password"))
          return {
            code: 0,
            data: {
              share_url: "https://pan.quark.cn/s/own123",
              passcode: "abcd",
            },
          };
        if (p.endsWith("/share/mypage/detail"))
          return {
            code: 0,
            data: { list: [{ share_id: "share-1", status: 1, file_num: 1 }] },
          };
        if (p.endsWith("/share/sharepage/token"))
          return { code: 0, data: { stoken: "private-token" } };
        if (p.endsWith("/share/sharepage/detail"))
          return {
            code: 0,
            data: {
              list: [
                {
                  fid: "own-file",
                  file_name: file.name,
                  dir: false,
                  size: 120,
                },
              ],
            },
            metadata: { _total: 1 },
          };
        throw new Error("未识别接口 " + p);
      },
    };
    const p = new QuarkProvider(transport),
      share = await p.createShare(f.account, [own], "自制练习");
    assert.equal(share.ownerUid, "owner-1");
    assert.equal(share.url, "https://pan.quark.cn/s/own123");
    assert.ok(calls.includes("/1/clouddrive/share/mypage/detail"));
    assert.equal(
      await p.verifyShare(f.account, "share-1", [{ ...own, id: "foreign" }]),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test("百度分享记录兼容shareId字段，核验提取码后才能恢复私密分享", async () => {
  const f = await fixture();
  try {
    const own = { ...file, id: "12345" },
      record = {
        shareId: 9988,
        fsIds: [12345],
        shortlink: "https://pan.baidu.com/s/1mine",
        status: 0,
        public: 0,
      };
    let verifiedCode = false;
    const transport: ProviderTransport = {
      async text() {
        return 'locals.mset({"shareid":9988,"share_uk":777,"loginstate":1});';
      },
      async setCookie() {},
      async json(_a, url, init) {
        const p = new URL(url).pathname;
        if (p === "/share/record") return { errno: 0, list: [record] };
        if (p === "/api/gettemplatevariable")
          return { errno: 0, result: { uk: 777, bdstoken: "token" } };
        if (p === "/share/verify") {
          assert.equal(
            new URLSearchParams(String(init?.body)).get("pwd"),
            "abcd",
          );
          verifiedCode = true;
          return { errno: 0, randsk: "test-only" };
        }
        if (p === "/share/list")
          return {
            errno: 0,
            list: [
              { fs_id: 12345, server_filename: file.name, isdir: 0, size: 120 },
            ],
          };
        if (p === "/share/set")
          return { errno: 0, shareid: 9988, link: record.shortlink };
        throw new Error("未识别接口 " + p);
      },
    };
    const p = new BaiduProvider(transport);
    assert.equal(await p.verifyShare(f.account, "9988", [own]), true);
    await assert.rejects(p.findOwnShare(f.account, [own]), {
      code: "RECOVER_SHARE_MANUALLY",
    });
    const recovered = await p.recoverOwnShare(
      f.account,
      parseShare(record.shortlink, "abcd"),
      [own],
    );
    assert.equal(verifiedCode, true);
    assert.equal(recovered.id, "9988");
    assert.equal(recovered.code, "abcd");
    assert.equal(
      (await p.createShare(f.account, [own], "测试")).url,
      record.shortlink,
    );
  } finally {
    await f.cleanup();
  }
});
