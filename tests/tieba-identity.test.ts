import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import type { BrowserContext } from "playwright-core";
import { tiebaCurrentUser, tiebaIdentityScript } from "../core/tieba/identity";
import { verifyBitTieba } from "../core/tieba/browser-session";

const modern = {
  is_login: true,
  open_uid: 1234567890,
  user_name_show: "接口昵称甲",
  show_nickname: "接口昵称甲",
  user_itieba_id: null,
};

test("贴吧新版当前用户字段与旧PageData字段都能读取UID和昵称", () => {
  assert.deepEqual(tiebaCurrentUser(modern), {
    uid: "1234567890",
    nickname: "接口昵称甲",
  });
  assert.deepEqual(
    tiebaCurrentUser({
      ...modern,
      open_uid: "1234567891",
      user_name_show: "接口昵称乙",
    }),
    { uid: "1234567891", nickname: "接口昵称乙" },
  );
  assert.deepEqual(
    tiebaCurrentUser({ user_id: "9876543210", user_name: "原账号" }),
    { uid: "9876543210", nickname: "原账号" },
  );
});

test("open_uid只接受明确登录且格式有效的当前账号，退出或未知状态不授予身份", () => {
  for (const is_login of [false, 0, "0", undefined, "unknown"])
    assert.equal(tiebaCurrentUser({ ...modern, is_login }), null);
  for (const open_uid of [0, -1, "tb.opaque", Number.MAX_SAFE_INTEGER + 1])
    assert.equal(tiebaCurrentUser({ ...modern, open_uid }), null);
  assert.equal(tiebaCurrentUser({ user_id: "111", is_login: false }), null);
  assert.equal(
    tiebaCurrentUser({ name: "个人主页展示名称", portrait: "其他人的头像" }),
    null,
  );
});

test("内置浏览器用已登录的新版当前用户结果直接核验，不访问旧TBS接口", async () => {
  const paths: string[] = [];
  const identity = await runInNewContext(tiebaIdentityScript(), {
    window: {},
    location: { origin: "https://tieba.baidu.com", pathname: "/" },
    URL,
    AbortSignal,
    fetch: async (path: string) => {
      paths.push(path);
      assert.equal(path, "/f/user/json_userinfo");
      return {
        url: `https://tieba.baidu.com${path}`,
        ok: true,
        text: async () => JSON.stringify({ no: 0, data: modern }),
      };
    },
  });
  assert.equal(identity.uid, "1234567890");
  assert.equal(identity.nickname, "接口昵称甲");
  assert.deepEqual(paths, ["/f/user/json_userinfo"]);
});

test("指纹核验在首页无PageData时识别新版JSON，保留原代理上下文并关闭临时页面", async () => {
  let url = "about:blank",
    closed = false,
    pages = 0;
  const paths: string[] = [];
  const page = {
    route: async () => {},
    goto: async (value: string) => {
      url = value;
      paths.push(new URL(value).pathname);
      assert.notEqual(new URL(value).pathname, "/dc/common/tbs");
      return { ok: () => true, status: () => 200 };
    },
    url: () => url,
    evaluate: async (script: string) =>
      runInNewContext(script, {
        window: {},
        location: {
          origin: "https://tieba.baidu.com",
          pathname: new URL(url).pathname,
        },
        document: {
          body: { innerText: JSON.stringify({ no: 0, data: modern }) },
        },
      }),
    close: async () => {
      closed = true;
    },
  };
  const context = {
    newPage: async () => {
      pages++;
      return page;
    },
  } as unknown as BrowserContext;
  const result = await verifyBitTieba(context);
  assert.equal(result.hasSession, true);
  assert.equal(result.uid, "1234567890");
  assert.equal(result.nickname, "接口昵称甲");
  assert.equal(result.expired, false);
  assert.equal(result.error, null);
  assert.deepEqual(paths, ["/", "/f/user/json_userinfo"]);
  assert.equal(pages, 1);
  assert.equal(closed, true);
});
