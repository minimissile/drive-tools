import test from "node:test";
import assert from "node:assert/strict";
import { CmccProvider, cmccSignature } from "../core/providers/cmcc";
import { WebTokenSession } from "../core/providers/web-token-session";
import {
  providerApiAllowed,
  providerAuthAllowed,
  providerIds,
  providerDriveName,
} from "../shared/providers";
import { parseShare } from "../core/links";
import { safeMessage } from "../core/errors";
import { fixture } from "./helpers";
import type { Account, Resource } from "../shared/types";
import type { DriveDirectory } from "../shared/drive-files";
import type { JsonObject, ProviderTransport } from "../core/providers/provider";

const account = {
  id: "cmcc-account",
  provider: "cmcc",
  alias: "",
  uid: "owner-139",
  status: "connected",
  enabled: true,
  isDefault: true,
  defaultDirectory: "/",
  lastVerifiedAt: null,
  error: null,
} satisfies Account;
const authorization =
  "Basic " + Buffer.from("pc:13800000000:fixture-token").toString("base64");
function mock() {
  const calls: { url: URL; body: JsonObject; headers: Headers }[] = [];
  const control = {
    accountId: account.id,
    modern: true,
    uid: "owner-139",
    next: null as string | null,
    route: "https://personal-kd-njs.yun.139.com/hcy",
    quota: { diskSize: "1000", freeDiskSize: "750" } as JsonObject,
    benefits: { userSubMemberList: [] } as JsonObject,
    failWrite: false,
    storage: 0,
    complete: 0,
    override: null as
      null | ((url: URL, body: JsonObject) => JsonObject | undefined),
  };
  const files: JsonObject[] = [
    { fileId: "file-1", name: "资源说明.txt", type: "file", size: 6 },
    { fileId: "folder-1", name: "资料", type: "folder" },
  ];
  const transport: ProviderTransport = {
    authHeaders: async () => ({
      authorization,
      "mcloud-version": "7.14.0",
      "x-yun-client-info": "fixture-web",
    }),
    text: async () => "",
    async storageRequest(_id, url, init) {
      control.storage++;
      assert.match(url, /\.aliyuncs.com\//);
      assert.equal(init.method, "PUT");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      assert.equal(init.credentials, "omit");
      return new Response(null, { status: 200 });
    },
    async json(id, address, init) {
      assert.equal(id, control.accountId);
      const url = new URL(address),
        body = JSON.parse(String(init?.body)),
        headers = new Headers(init?.headers);
      calls.push({ url, body, headers });
      assert.equal(headers.get("authorization"), authorization);
      assert.equal(
        headers.get("Referer"),
        url.origin === "https://yun.139.com"
          ? "https://yun.139.com/w/"
          : "https://yun.139.com/",
      );
      const [time, nonce, sign] = headers.get("mcloud-sign")!.split(",");
      assert.equal(sign, cmccSignature(String(init?.body), time, nonce));
      assert.match(time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      const override = control.override?.(url, body);
      if (override) return override;
      const ok = (data: JsonObject) => ({ success: true, code: "0000", data });
      if (url.pathname === "/user/status/query")
        return ok({
          userDomainId: control.uid,
          phoneNumber: "13800000000",
          cutoverStatus: control.modern ? 1 : 0,
        });
      if (url.pathname === "/user/route/qryRoutePolicy")
        return ok({
          routePolicyList: [{ modName: "personal", httpsUrl: control.route }],
        });
      if (url.pathname === "/user/getUser")
        return ok({
          userDomainId: control.uid,
          userProfileInfo: { userName: "云端资料归档" },
        });
      if (url.pathname === "/user/disk/quota/detail") return ok(control.quota);
      if (
        url.pathname ===
        "/orchestration/group-rebuild/member/v1.0/queryUserBenefits"
      ) {
        assert.deepEqual(body, {
          isNeedBenefit: 0,
          commonAccountInfo: { userDomainId: control.uid, accountType: 1 },
        });
        assert.equal(headers.get("mcloud-userid-flag"), "1");
        return ok(control.benefits);
      }
      if (url.pathname === "/hcy/file/list")
        return ok({
          items: body.parentFileId === "/" ? files : [],
          nextPageCursor: control.next,
        });
      if (url.pathname.endsWith("/catalog/v1.0/getDisk"))
        return ok({
          getDiskResult: {
            catalogList: [{ catalogID: "old-dir", catalogName: "旧目录" }],
            contentList: [
              {
                contentID: "old-file",
                contentName: "旧资料.txt",
                contentSize: 6,
              },
            ],
            isCompleted: 1,
            nodeCount: 2,
          },
        });
      if (control.failWrite) throw Error("connection reset");
      if (url.pathname === "/hcy/file/create") {
        if (body.type === "folder") {
          files.push({
            fileId: "created-dir",
            type: "folder",
            name: body.name,
          });
          return ok({ fileId: "created-dir", fileName: body.name });
        }
        return ok({
          fileId: "uploaded",
          fileName: body.name,
          uploadId: "up-1",
          partInfos: [
            {
              partNumber: 1,
              uploadUrl:
                "https://bucket.oss-cn-hangzhou.aliyuncs.com/material?signature=fixture",
            },
          ],
        });
      }
      if (url.pathname === "/hcy/file/complete") {
        control.complete++;
        return ok({ fileId: "uploaded" });
      }
      if (["/hcy/file/update", "/hcy/file/batchDelete"].includes(url.pathname))
        return ok({});
      throw Error(`unexpected ${url.pathname}`);
    },
  };
  return {
    provider: new CmccProvider(transport),
    transport,
    control,
    calls,
    files,
  };
}
test("139 按官方名称注册，接口与登录域名不跨渠道", () => {
  assert.ok(providerIds.includes("cmcc"));
  assert.equal(providerDriveName("cmcc"), "移动云盘");
  assert.ok(
    providerApiAllowed(
      "cmcc",
      "https://personal-kd-bj.yun.139.com/hcy/file/list",
    ),
  );
  for (const url of [
    "http://yun.139.com/",
    "https://yun.139.com.evil.test/",
    "https://yun.139.com:8443/",
    "https://user:pass@yun.139.com/",
  ])
    assert.equal(providerApiAllowed("cmcc", url), false);
  assert.equal(providerApiAllowed("baidu", "https://yun.139.com/"), false);
  assert.ok(providerAuthAllowed("cmcc", "https://www.cmpassport.com/umcsso/"));
});
test("139 中文与特殊字符签名匹配官网固定向量", () => {
  assert.equal(
    cmccSignature(
      '{"name":"资料 & 测试.txt","parentFileId":"/"}',
      "2026-11-25 09:30:00",
      "0123456789abcdef",
    ),
    "F8D0A3A7A922EEABADE7CF2E74DF835C",
  );
});
test("139 服务端 UID、用户名、容量与新版个人盘根目录", async () => {
  const m = mock();
  assert.deepEqual(await m.provider.identity(account), {
    uid: "owner-139",
    nickname: "云端资料归档",
  });
  assert.deepEqual(await m.provider.capacity(account), {
    totalBytes: 1000 * 1024 ** 2,
    usedBytes: 250 * 1024 ** 2,
  });
  const page = await m.provider.listPage(account, "0");
  assert.equal(page.files.length, 2);
  assert.equal(page.next, null);
  assert.equal(page.files[0].size, 6);
  assert.equal(page.files[1].isDirectory, true);
  assert.equal(m.calls.at(-1)?.body.parentFileId, "/");
  assert.deepEqual(await m.provider.fileCapabilities(account), {
    mkdir: true,
    rename: true,
    delete: true,
    upload: true,
  });
});
test("139 旧版目录可读，未接入的旧版维护能力关闭", async () => {
  const m = mock();
  m.control.modern = false;
  const page = await m.provider.listPage(account, "0");
  assert.equal(page.files.length, 2);
  assert.equal(page.next, null);
  assert.equal(m.calls.at(-1)?.body.catalogID, "root");
  assert.deepEqual(await m.provider.fileCapabilities(account), {
    mkdir: false,
    rename: false,
    delete: false,
    upload: false,
  });
});
test("139 错号和非官方路由在读取、写入之前停止", async () => {
  const m = mock();
  m.control.uid = "other-owner";
  await assert.rejects(m.provider.list(account, "0"), {
    code: "ACCOUNT_UID_MISMATCH",
  });
  assert.equal(
    m.calls.some((c) => c.url.pathname.includes("/file/")),
    false,
  );
  const n = mock();
  n.control.route = "https://personal-kd-njs.yun.139.com.evil.test/hcy";
  await assert.rejects(n.provider.identity(account), {
    code: "PROVIDER_URL_BLOCKED",
  });
  assert.equal(
    n.calls.some((c) => c.url.hostname.includes("evil")),
    false,
  );
});
test("139 不把坏容量、文件大小或缺失分页当作0或完整目录", async () => {
  const m = mock();
  m.control.quota = { diskSize: null, freeDiskSize: null };
  await assert.rejects(m.provider.capacity(account), {
    code: "CAPACITY_UNAVAILABLE",
  });
  m.files[0].size = null;
  await assert.rejects(m.provider.listPage(account, "0"), {
    code: "REMOTE_SCHEMA_CHANGED",
  });
  m.control.override = (url) =>
    url.pathname === "/hcy/file/list"
      ? { success: true, code: "0000", data: { items: [] } }
      : undefined;
  await assert.rejects(m.provider.listPage(account, "0"), {
    code: "INCOMPLETE_LIST",
  });
});
test("139 云空间总配额以 MiB 换算，保留小数用量；新旧个人盘使用同一官网总额", async () => {
  for (const modern of [true, false]) {
    const m = mock();
    m.control.modern = modern;
    m.control.quota = { diskSize: "4229120", freeDiskSize: "4229119.5" };
    assert.deepEqual(await m.provider.capacity(account), {
      totalBytes: 4229120 * 1024 ** 2,
      usedBytes: 512 * 1024,
    });
    assert.equal(m.calls.at(-1)?.url.pathname, "/user/disk/quota/detail");
    assert.equal(
      m.calls.some((c) => c.url.pathname.endsWith("/getPersonalDiskInfo")),
      false,
    );
  }
  for (const invalid of [
    null,
    "",
    " ",
    true,
    -1,
    "NaN",
    Infinity,
    "9999999999999999999",
  ]) {
    const m = mock();
    m.control.quota = { diskSize: invalid, freeDiskSize: "0" };
    await assert.rejects(m.provider.capacity(account), {
      code: "CAPACITY_UNAVAILABLE",
    });
  }
  const m = mock();
  m.control.quota = { diskSize: "10", freeDiskSize: "11" };
  await assert.rejects(m.provider.capacity(account), {
    code: "CAPACITY_UNAVAILABLE",
  });
});
test("139 会员通过账号内订购接口读取，不根据云空间大小判断", async () => {
  const m = mock();
  assert.deepEqual(await m.provider.membership(account), {
    status: "none",
    tier: null,
    expiresAt: null,
  });
  m.control.benefits = {
    userSubMemberList: [{ memberLevel: 2, memberLvName: "超级会员" }],
  };
  assert.deepEqual(await m.provider.membership(account), {
    status: "active",
    tier: "超级会员",
    expiresAt: null,
  });
  m.control.benefits = {};
  await assert.rejects(m.provider.membership(account), {
    code: "MEMBERSHIP_UNAVAILABLE",
  });
});
test("139 会员兼容官网旧接口成功信封，内层失败和明确失败不可冒充非会员", async () => {
  for (const envelope of [
    { code: "0000" },
    { code: "0", data: { result: { resultCode: "0" } } },
    { statusCode: 200, mcsCode: "0" },
    { resultCode: "0" },
  ]) {
    const m = mock();
    m.control.override = (url) =>
      url.pathname.endsWith("queryUserBenefits")
        ? { ...envelope, data: { ...envelope.data, userSubMemberList: [] } }
        : undefined;
    assert.equal((await m.provider.membership(account)).status, "none");
  }
  for (const envelope of [
    { success: false, code: "0000" },
    { code: "0", data: { result: { resultCode: "99" } } },
    { statusCode: 200, mcsCode: "99" },
    {},
  ]) {
    const m = mock();
    m.control.override = (url) =>
      url.pathname.endsWith("queryUserBenefits")
        ? { ...envelope, data: { ...envelope.data, userSubMemberList: [] } }
        : undefined;
    await assert.rejects(m.provider.membership(account), {
      code: "REMOTE_ERROR",
    });
  }
});
test("139 重复游标和重复文件不算同步完成", async () => {
  const m = mock();
  m.control.next = "cursor-a";
  await assert.rejects(m.provider.listPage(account, "0", "cursor-a"), {
    code: "INCOMPLETE_LIST",
  });
  await assert.rejects(m.provider.list(account, "0"), {
    code: "INCOMPLETE_LIST",
  });
});
test("139 旧版 isCompleted 不替代总数分页，超过100项继续读取", async () => {
  const m = mock();
  m.control.modern = false;
  m.control.override = (url, body) =>
    url.pathname.endsWith("/catalog/v1.0/getDisk")
      ? {
          success: true,
          code: "0",
          data: {
            getDiskResult: {
              isCompleted: 1,
              nodeCount: 101,
              catalogList: null,
              contentList: Array.from(
                { length: body.startNumber === 1 ? 100 : 1 },
                (_, i) => ({
                  contentID: `old-${body.startNumber + i}`,
                  contentName: `资料${body.startNumber + i}.txt`,
                  contentSize: 6,
                }),
              ),
            },
          },
        }
      : undefined;
  assert.equal((await m.provider.listPage(account, "0")).next, "100");
  assert.equal((await m.provider.list(account, "0")).length, 101);
});
test("139 复用目录、新建、重命名与回收站删除使用本人文件ID", async () => {
  const m = mock();
  assert.equal(await m.provider.ensureFolder(account, "/资料"), "folder-1");
  assert.equal(
    m.calls.filter((c) => c.url.pathname === "/hcy/file/create").length,
    0,
  );
  assert.equal(await m.provider.ensureFolder(account, "/课程"), "created-dir");
  const file = (await m.provider.list(account, "0"))[0];
  await m.provider.manageFile(account, {
    action: "rename",
    path: "/",
    parentId: "0",
    file,
    name: "课程说明.txt",
  });
  await m.provider.manageFile(account, {
    action: "delete",
    path: "/",
    parentId: "0",
    file,
  });
  assert.deepEqual(m.calls.at(-1)?.body, { fileIds: ["file-1"] });
  assert.equal(
    m.calls.some((c) => c.url.pathname.includes("/recyclebin/")),
    false,
  );
});
test("139 写入中断只提交一次，并标记结果待核对", async () => {
  const m = mock();
  m.control.failWrite = true;
  await assert.rejects(
    m.provider.manageFile(account, {
      action: "rename",
      path: "/",
      parentId: "0",
      file: {
        id: "f",
        name: "原名.txt",
        isDirectory: false,
        size: 6,
        parentId: "0",
      },
      name: "说明.txt",
    }),
    { code: "UNCERTAIN_REMOTE_RESULT", uncertain: true },
  );
  assert.equal(
    m.calls.filter((c) => c.url.pathname === "/hcy/file/update").length,
    1,
  );
});
test("139 小素材上传不携带账号令牌，不自动覆盖同名文件", async () => {
  const m = mock();
  await m.provider.upload(account, "0", {
    name: "使用说明.txt",
    mime: "text/plain",
    bytes: Buffer.from("hello"),
  });
  assert.equal(m.control.storage, 1);
  assert.equal(m.control.complete, 1);
  const create = m.calls.find((c) => c.url.pathname === "/hcy/file/create")!;
  assert.equal(create.body.contentHashAlgorithm, "SHA1");
  assert.equal(create.body.partInfos[0].partSize, 5);
  await assert.rejects(
    m.provider.upload(account, "0", {
      name: "资源说明.txt",
      mime: "text/plain",
      bytes: Buffer.from("hello"),
    }),
    { code: "UPLOAD_NAME_CONFLICT" },
  );
  assert.equal(m.control.storage, 1);
});
test("139 分享链接识别保留官方hash入口、ID和提取码", async () => {
  const link = parseShare(
    "https://yun.139.com/shareweb/#/w/i/abc139 提取码：a1b2",
  );
  assert.equal(link.provider, "cmcc");
  assert.equal(link.shareKey, "abc139");
  assert.equal(link.code, "a1b2");
  assert.equal(link.url, "https://yun.139.com/shareweb/#/w/i/abc139");
  assert.equal(
    parseShare("https://yun.139.com/shareweb/#/w/i/abc139?password=q1w2").code,
    "q1w2",
  );
});
test("139 Basic会话按账号加密存储，不复用其他网盘续期接口", async () => {
  const f = await fixture();
  try {
    const m = mock(),
      session = new WebTokenSession(() => f.app.secrets, m.transport, "cmcc");
    assert.equal(
      await session.capture("a", {
        Authorization: authorization,
        "mcloud-version": "7.14.0",
        Cookie: "must-not-save",
      }),
      true,
    );
    assert.equal(
      await session.capture("b", {
        Authorization:
          "Basic " + Buffer.from("user:password").toString("base64"),
      }),
      false,
    );
    const headers = await session.headers("a");
    assert.equal(headers.authorization, authorization);
    assert.equal(headers.cookie, undefined);
    await assert.rejects(session.headers("b"), { code: "AUTH_EXPIRED" });
    await assert.rejects(session.headers("a", true), { code: "AUTH_EXPIRED" });
    assert.equal(m.calls.length, 0);
    assert.equal(safeMessage(new Error(authorization)), "Basic [已隐藏]");
    await session.clear("a");
    await assert.rejects(session.headers("a"), { code: "AUTH_EXPIRED" });
  } finally {
    await f.cleanup();
  }
});
test("139 从创建账号、自动别名到整盘索引与资源登记，保留独立数据库链路", async () => {
  const m = mock(),
    f = await fixture({ cmcc: m.provider });
  try {
    const created = (await f.app.invoke("account.add", {
      provider: "cmcc",
      alias: "",
    })) as Account;
    m.control.accountId = created.id;
    const checked = (await f.app.invoke("account.check", {
      id: created.id,
    })) as Account;
    assert.equal(checked.status, "connected");
    assert.equal(checked.uid, "owner-139");
    assert.equal(checked.alias, "云端资料归档");
    const directory = (await f.app.invoke("drive.directory", {
      accountId: created.id,
      path: "/",
    })) as DriveDirectory;
    assert.equal(directory.files.length, 2);
    assert.deepEqual(directory.capabilities, {
      mkdir: true,
      rename: true,
      delete: true,
      upload: true,
    });
    f.app.driveSync.start(created.id);
    await f.app.driveSync.settled(created.id);
    assert.equal(f.app.driveSync.current(created.id)?.status, "completed");
    const index = f.app.driveSync.index({
      accountId: created.id,
      parentId: "@root",
    });
    assert.equal(index.total, 2);
    const result = await f.app.driveSync.register({
      accountId: created.id,
      entries: [{ fileId: "file-1", title: "资源使用说明" }],
    });
    assert.equal(result[0].error, undefined);
    assert.ok(result[0].resourceId);
    const resource = (await f.app.invoke("resource.get", {
      id: result[0].resourceId!,
    })) as Resource;
    assert.equal(resource.provider, "cmcc");
    assert.equal(resource.copies[0].status, "recorded");
    assert.equal(resource.copies[0].shareUrl, null);
    assert.equal(
      m.calls.filter((c) => c.url.pathname === "/hcy/file/create").length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
