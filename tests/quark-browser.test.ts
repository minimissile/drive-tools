import { withPageLifecycleFixture } from "./browser-page-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import type { BrowserContext, Page } from "playwright-core";
import type { BitBrowser } from "../core/bitbrowser";
import { DriveBrowserSessions } from "../core/drive-browser-sessions";
import { QuarkProvider } from "../core/providers/quark";
import { fixture } from "./helpers";
import { quarkIdentity } from "../core/providers/quark-identity";
import type { ProviderTransport } from "../core/providers/provider";

async function setup() {
  const f = await fixture();
  f.app.db.setSetting("bitUrl", "http://127.0.0.1:54345");
  const config = {
    signature: "stable",
    proxy: "configured" as const,
    stopWhileNetError: true,
  };
  f.app.environments.setExternalConfigurationReader(async () => config);
  f.app.environments.setExternalNetworkChecker(async () => "203.0.113.10");
  const calls: { url: string; init: RequestInit }[] = [];
  const state = {
    uid: "quark-fixture-22",
    authenticated: true,
    failStorage: false,
    headless: true,
    connections: 0,
  };
  const files = [
    {
      fid: "file-1",
      file_name: "说明.txt",
      dir: false,
      size: 6,
      pdir_fid: "0",
    },
  ];
  const page = {
    url: () => "https://pan.quark.cn/",
    isClosed: () => false,
    evaluate: async (fn: Function, input: unknown) => {
      if (typeof input === "string") return true;
      // Only this test's page fetch is simulated. The process/global transport is untouched.
      return runInNewContext(`(${fn.toString()})(input)`, {
        input,
        setTimeout,
        clearTimeout,
        AbortController,
        FormData,
        Blob,
        Uint8Array,
        TextDecoder,
        atob,
        btoa,
        fetch: async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          const path = new URL(url).pathname;
          let data: unknown = { code: 0, data: {} };
          if (path === "/account/info")
            data = state.authenticated
              ? {
                  code: "OK",
                  success: true,
                  data: { nickname: "夸克测试用户" },
                }
              : { code: "NOT_LOGIN", success: false, data: {} };
          else if (path.endsWith("file/sort"))
            data = {
              code: 0,
              data: { list: files },
              metadata: { _total: files.length },
            };
          else if (path.endsWith("file/download"))
            data = {
              code: 0,
              data: [
                {
                  fid: "file-1",
                  download_url: "https://dl-test.drive.quark.cn/file",
                },
              ],
            };
          else if (path === "/file")
            return new Response(new Uint8Array([0, 255, 42, 128, 1]));
          else if (path.endsWith("file/upload/pre"))
            data = {
              code: 0,
              data: {
                task_id: "task",
                upload_id: "upload",
                obj_key: "说明.txt",
                upload_url: "https://oss-cn-hangzhou.aliyuncs.com",
                bucket: "bucket",
                auth_info: "fixture",
                callback: {},
              },
            };
          else if (path.endsWith("file/upload/auth"))
            data = { code: 0, data: { auth_key: "OSS fixture" } };
          else if (new URL(url).hostname.endsWith("aliyuncs.com")) {
            if (state.failStorage)
              throw new Error("simulated storage interruption");
            return new Response("<CompleteMultipartUploadResult/>", {
              headers: { ETag: '"ABCDEF"' },
            });
          } else if (path.endsWith("share/mypage/detail"))
            data = { code: 0, data: { list: [] }, metadata: { _total: 0 } };
          return Response.json(data);
        },
      });
    },
  } as unknown as Page;
  const context = {
    pages: () => [page],
    cookies: async () => [{ name: "__uid", value: state.uid }],
    newPage: async () => ({
      url: () => "https://myip.ipip.net/",
      goto: async () => ({
        ok: () => true,
        text: async () => "当前 IP：203.0.113.10 来自于：中国",
      }),
      close: async () => {},
    }),
  } as unknown as BrowserContext;
  withPageLifecycleFixture(context);
  const sessions = new DriveBrowserSessions({
    repo: f.app.repo,
    environments: f.app.environments,
    bit: {
      profiles: async () => [{ id: "profile", name: "夸克窗口", seq: 10 }],
      environmentConfiguration: async () => config,
      profileDetails: async () => ({ randomFingerprint: false }),
      withDriveProfile: async (
        _id: string,
        allowHeadful: boolean,
        action: Function,
      ) => {
        state.connections++;
        if (!allowHeadful && !state.headless)
          throw new Error("visible window still open");
        return action(context, { headless: state.headless });
      },
    } as unknown as BitBrowser,
    locked: async (_id, action) => action(),
    assertIdle: () => {},
    changed: () => {},
  });
  const preview = () =>
    sessions.previewNew({
      provider: "quark",
      profileId: "profile",
      connectorKey: "http://127.0.0.1:54345",
      requireProxy: true,
    });
  const add = async () =>
    sessions.createAccount("", (await preview()).token, "quark");
  const transport: ProviderTransport = {
    json: async (id, url, init) =>
      JSON.parse((await sessions.request(id, url, init)).body),
    text: async (id, url, init) => (await sessions.request(id, url, init)).body,
    principalId: (id) => sessions.principalId(id),
    fileBytes: (id, url, limit) => sessions.fileBytes(id, url, limit),
    storageRequest: (id, url, init) => sessions.storageRequest(id, url, init),
  };
  return {
    ...f,
    sessions,
    preview,
    add,
    calls,
    config,
    state,
    provider: new QuarkProvider(transport),
  };
}

test("夸克预览绑定类型、自动用户名、同类环境占用及创建后固定方式", async () => {
  const f = await setup();
  try {
    const p = await f.preview();
    assert.equal(p.provider, "quark");
    assert.equal(p.uid, f.state.uid);
    await assert.rejects(f.sessions.createAccount("", p.token, "baidu"), {
      code: "DRIVE_PREVIEW_PROVIDER",
    });
    const a = await f.sessions.createAccount("", p.token, "quark");
    assert.equal(a.alias, "夸克测试用户");
    assert.equal(a.browserEngine, "bitbrowser");
    assert.equal(a.provider, "quark");
    assert.equal(a.status, "connected");
    assert.equal(
      f.app.environments.forAccount({ kind: "drive", id: a.id }).profileId,
      "profile",
    );
    await assert.rejects(f.preview(), { code: "DRIVE_PROFILE_EXCLUSIVE" });
    await assert.rejects(f.sessions.createAccount("", p.token, "quark"), {
      code: "DRIVE_PREVIEW_EXPIRED",
    });
    await assert.rejects(f.sessions.unbind(a.id), {
      code: "ACCOUNT_BROWSER_FIXED",
    });
  } finally {
    await f.cleanup();
  }
});

test("夸克目录、增删改、分享统计与正文读取均使用绑定浏览器，跨域及切号被拦截", async () => {
  const f = await setup();
  try {
    const a = await f.add();
    const connections = f.state.connections;
    await f.sessions.withRequestSession(a.id, async () => {
      const files = await f.provider.list(a, "0");
      assert.equal(files[0].name, "说明.txt");
      await f.provider.manageFile(a, {
        action: "mkdir",
        parentId: "0",
        path: "/",
        name: "临时",
      });
      await f.provider.manageFile(a, {
        action: "rename",
        parentId: "0",
        path: "/说明.txt",
        file: files[0],
        name: "新名.txt",
      });
      await f.provider.manageFile(a, {
        action: "delete",
        parentId: "0",
        path: "/说明.txt",
        file: files[0],
      });
      await f.provider.shareStatistics(a, 1);
      const bytes = await f.provider.readFile(a, files[0], 1024);
      assert.deepEqual([...bytes], [0, 255, 42, 128, 1]);
    });
    assert.equal(
      f.state.connections,
      connections + 1,
      "同一业务批次只连接一次环境",
    );
    const paths = f.calls.map((c) => new URL(c.url).pathname);
    for (const path of [
      "/1/clouddrive/file",
      "/1/clouddrive/file/rename",
      "/1/clouddrive/file/delete",
      "/1/clouddrive/share/mypage/detail",
    ])
      assert.ok(paths.includes(path), path);
    const sent = f.calls.length;
    await assert.rejects(
      f.sessions.request(a.id, "https://pan.baidu.com/api/list"),
      { code: "PROVIDER_URL_BLOCKED" },
    );
    await assert.rejects(
      async () => f.sessions.fileBytes(a.id, "https://evil.test/file", 1024),
      { code: "DOCUMENT_HOST_BLOCKED" },
    );
    assert.equal(f.calls.length, sent);
    f.state.uid = "different-user";
    await assert.rejects(f.provider.list(a, "0"), {
      code: "ACCOUNT_UID_MISMATCH",
    });
    assert.equal(f.calls.at(-1)?.url.includes("account/info"), true);
  } finally {
    await f.cleanup();
  }
});

test("夸克上传分片正文及存储合并走浏览器，临时存储不附带账号Cookie，失败不回退或重试", async () => {
  const f = await setup();
  try {
    const a = await f.add();
    const asset = {
      name: "说明.txt",
      mime: "text/plain",
      bytes: Buffer.from("广告素材测试"),
    };
    await f.sessions.withRequestSession(a.id, () =>
      f.provider.upload(a, "0", asset),
    );
    const storage = f.calls.filter((c) =>
      new URL(c.url).hostname.endsWith("aliyuncs.com"),
    );
    assert.equal(storage.length, 2);
    assert.deepEqual(
      [...new Uint8Array(storage[0].init.body as ArrayBuffer)],
      [...asset.bytes],
    );
    for (const c of storage) {
      assert.equal(c.init.credentials, "omit");
      assert.equal(c.init.redirect, "error");
      assert.equal(new Headers(c.init.headers).has("cookie"), false);
      assert.match(new Headers(c.init.headers).get("authorization")!, /^OSS /);
    }
    f.state.failStorage = true;
    await assert.rejects(f.provider.upload(a, "0", asset), {
      code: "UPLOAD_UNCERTAIN",
      uncertain: true,
    });
    assert.equal(
      f.calls.filter((c) => new URL(c.url).hostname.endsWith("aliyuncs.com"))
        .length,
      3,
    );
  } finally {
    await f.cleanup();
  }
});

test("夸克官方登录失败不接受残留Cookie UID，环境配置变化及可见窗口均不能发业务请求", async () => {
  const f = await setup();
  try {
    const a = await f.add();
    f.state.authenticated = false;
    await assert.rejects(f.provider.list(a, "0"), { code: "AUTH_EXPIRED" });
    f.state.authenticated = true;
    f.state.headless = false;
    await assert.rejects(f.provider.list(a, "0"), /visible window/);
    f.state.headless = true;
    f.config.signature = "changed";
    await assert.rejects(f.provider.list(a, "0"), {
      code: "DRIVE_ENVIRONMENT_CHANGED",
    });
  } finally {
    await f.cleanup();
  }
});

test("官方身份结构异常不读取UID后备来源", async () => {
  for (const result of [
    null,
    {},
    { data: [] },
    { data: {}, code: 0 },
    { data: { nickname: "残留" }, success: false },
  ]) {
    let read = false;
    await assert.rejects(
      quarkIdentity(result as any, "夸克", async () => {
        read = true;
        return "old-user";
      }),
      { code: "AUTH_EXPIRED" },
    );
    assert.equal(read, false);
  }
});
