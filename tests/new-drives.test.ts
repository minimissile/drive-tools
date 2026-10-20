import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { UcProvider } from "../core/providers/uc";
import { XunleiProvider } from "../core/providers/xunlei";
import { ThunderSession } from "../core/providers/thunder-session";
import type { ProviderTransport, JsonObject } from "../core/providers/provider";
import type { Account, RemoteFile, SplitRun } from "../shared/types";
import { parseShare } from "../core/links";
import { providerApiAllowed, providerAuthAllowed } from "../shared/providers";
import { AppError, ProviderHttpError, safeMessage } from "../core/errors";

test("official share handoff uses the chosen matching account and canonical URL only", async () => {
  const f = await fixture();
  try {
    const opened: { account: string; url: string }[] = [];
    f.ports.openAccountPage = async (account, url) => {
      opened.push({ account: account.id, url });
    };
    const account = (await f.app.invoke("account.add", {
      provider: "xunlei",
      alias: "迅雷本人",
    })) as Account;
    await f.app.invoke("share.open", {
      accountId: account.id,
      sourceText:
        "https://pan.xunlei.com/s/test?pwd=abcd&redirect=https://evil.invalid",
    });
    assert.deepEqual(opened, [
      { account: account.id, url: "https://pan.xunlei.com/s/test?pwd=abcd" },
    ]);
    await assert.rejects(
      f.app.invoke("share.open", {
        accountId: f.account.id,
        sourceText: "https://pan.xunlei.com/s/test",
      }),
      (e: unknown) =>
        e instanceof AppError && e.code === "CROSS_PROVIDER_UNSUPPORTED",
    );
    await assert.rejects(
      f.app.invoke("share.open", {
        accountId: account.id,
        sourceText: "https://pan.xunlei.com.evil.invalid/s/test",
      }),
    );
    assert.equal(opened.length, 1);
    const saved = await f.add(false, {
      sourceText: "https://pan.quark.cn/s/source123?pwd=keep",
    });
    await f.app.invoke("share.open", {
      accountId: f.account.id,
      sourceText: "https://pan.quark.cn/s/source123",
      resourceId: saved.resourceId,
    });
    assert.equal(opened[1].url, "https://pan.quark.cn/s/source123?pwd=keep");
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
  } finally {
    await f.cleanup();
  }
});

test("Thunder HTTP captcha rejection is actionable; HTTP 500 writes retain uncertainty", async () => {
  const f = await fixture();
  try {
    let serverError = false,
      posts = 0;
    const p = new XunleiProvider({
      text: async () => "",
      authHeaders: async () => ({ authorization: "Bearer fixture" }),
      json: async (_id, _url, init) => {
        if (init?.method === "POST") {
          posts++;
          throw new ProviderHttpError(
            serverError ? 500 : 400,
            serverError ? "" : "9",
            serverError ? "server error" : "captcha_required",
            true,
          );
        }
        return {
          files: [{ id: "src", name: "test.txt", kind: "drive#file", size: 1 }],
          share_status: "OK",
          pass_code_token: "valid-token",
        };
      },
    });
    const account = { ...f.account, provider: "xunlei" as const },
      source = parseShare("https://pan.xunlei.com/s/source"),
      selected = [
        {
          id: "src",
          name: "test.txt",
          isDirectory: false,
          parentId: "0",
          size: 1,
        },
      ];
    await assert.rejects(
      p.transfer(account, source, selected, "target"),
      (e: unknown) =>
        e instanceof AppError &&
        e.code === "USER_ACTION_REQUIRED" &&
        !e.uncertain,
    );
    serverError = true;
    await assert.rejects(
      p.transfer(account, source, selected, "target"),
      (e: unknown) => e instanceof AppError && e.uncertain,
    );
    assert.equal(posts, 2);
  } finally {
    await f.cleanup();
  }
});

test("opening an encrypted own share hands its stored code only to the matching official window", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(true);
    await f.app.queue.execute(saved.jobId);
    let opened: { account: string; url: string } | undefined;
    f.ports.openAccountPage = async (account, url) => {
      opened = { account: account.id, url };
    };
    assert.equal(await f.app.invoke("copy.open", { id: saved.copyId }), true);
    assert.deepEqual(opened, {
      account: f.account.id,
      url: "https://pan.quark.cn/s/own123?pwd=test",
    });
  } finally {
    await f.cleanup();
  }
});

function drive(kind: "uc" | "xunlei") {
  const folders = new Map<string, JsonObject[]>([["0", []]]),
    shares: JsonObject[] = [];
  const state = {
    uid: "owner-new",
    transfers: 0,
    creates: 0,
    lostShare: false,
    authRejected: false,
    badUid: false,
    rejectShare: false,
    rejectHistory: false,
    hideCodes: false,
    wrappedFolderResponse: false,
    folderCreates: 0,
  };
  let sequence = 0;
  const sourceFile = {
    id: "src",
    name: "本人测试.txt",
    isDirectory: false,
    size: 12,
    parentId: "0",
  };
  const remote = (id: string, name = sourceFile.name, dir = false) =>
    kind === "uc"
      ? {
          fid: id,
          file_name: name,
          dir: dir ? "1" : "0",
          size: dir ? 0 : 12,
          share_fid_token: `token-${id}`,
        }
      : {
          id,
          name,
          kind: dir ? "drive#folder" : "drive#file",
          size: dir ? "0" : "12",
        };
  const transport: ProviderTransport = {
    async text() {
      return "";
    },
    async authHeaders(id) {
      return {
        authorization: `Bearer access-${id}`,
        "x-device-id": `device-${id}`,
        "x-client-id": "captured-current-client",
        "x-captcha-token": "current-verified-token",
      };
    },
    async json(_id, text, init) {
      const u = new URL(text),
        body = init?.body ? JSON.parse(String(init.body)) : {};
      assert.ok(providerApiAllowed(kind, u.href));
      const path = u.pathname.replace(
        kind === "uc" ? "/1/clouddrive/" : "/drive/v1/",
        "",
      );
      const ok = (data: JsonObject) =>
        kind === "uc" ? { code: 0, status: 200, data } : data;
      if (kind === "uc")
        assert.equal(
          u.hostname === "pc-api.uc.cn"
            ? u.searchParams.get("pr")
            : "UCBrowser",
          "UCBrowser",
        );
      if (path === "/account/info" || path === "/v1/user/me")
        return kind === "uc"
          ? {
              success: true,
              code: "OK",
              data: { uid: state.uid, nickname: "本人" },
            }
          : { sub: state.uid, name: "本人" };
      if (
        path === "file/sort" ||
        (path === "files" && init?.method === "GET")
      ) {
        const parent =
          u.searchParams.get(kind === "uc" ? "pdir_fid" : "parent_id") || "0";
        return ok(
          kind === "uc"
            ? { list: folders.get(parent) ?? [] }
            : { files: folders.get(parent) ?? [], next_page_token: "" },
        );
      }
      if (path === "file" || (path === "files" && init?.method === "POST")) {
        state.folderCreates++;
        const parent = body.pdir_fid || body.parent_id || "0",
          name = body.file_name || body.name,
          fid = `folder-${++sequence}`;
        const row = remote(fid, name, true);
        folders.set(fid, []);
        folders.set(parent, [...(folders.get(parent) ?? []), row]);
        return ok(
          kind === "uc"
            ? { fid }
            : state.wrappedFolderResponse
              ? { file: row }
              : row,
        );
      }
      if (path === "share/sharepage/v2/detail") {
        assert.equal(body.passcode, "a123");
        return ok({ token_info: { stoken: "uc-token" } });
      }
      if (
        path === "share/sharepage/detail" ||
        (path === "share" && init?.method === "GET") ||
        path === "share/detail"
      ) {
        const key = u.searchParams.get(kind === "uc" ? "pwd_id" : "share_id"),
          own = shares.find((s) => s.share_id === key);
        const rows = own ? own.files : [remote("src")];
        if (
          kind === "xunlei" &&
          own &&
          u.searchParams.get("pass_code") !== "a123"
        )
          return { error_code: 4002, error: "pass_code_error" };
        return kind === "uc"
          ? {
              ...ok({ list: rows, share: { title: "本人资料" } }),
              metadata: { _total: rows.length },
            }
          : {
              files: rows,
              pass_code_token: "valid-pass-token",
              share_status: "OK",
              next_page_token: "",
              title: "本人资料",
            };
      }
      if (path === "share/sharepage/save" || path === "share/restore") {
        if (state.authRejected)
          throw new AppError("USER_ACTION_REQUIRED", "需要人工验证");
        state.transfers++;
        assert.deepEqual(body.fid_list ?? body.file_ids, ["src"]);
        folders.set(body.to_pdir_fid ?? body.parent_id, [remote("own-file")]);
        return ok(
          kind === "uc"
            ? { task_id: "save-task" }
            : { restore_task_id: "save-task" },
        );
      }
      if (path === "task") return ok({ status: 2 });
      if (path === "tasks/save-task")
        return { progress: 100, phase: "PHASE_TYPE_COMPLETE" };
      if (
        (path === "share/mypage/detail" || path === "share/list") &&
        state.rejectHistory
      )
        throw new AppError("USER_ACTION_REQUIRED", "历史记录要求人工验证");
      if (path === "share/mypage/detail")
        return ok({
          list: shares.map((s) => ({
            ...s,
            status: 1,
            file_num: s.files.length,
            fid_list: s.files.map((f: JsonObject) => f.fid),
          })),
        });
      if (path === "share/list")
        return {
          data: shares.map((s) => ({
            ...s,
            user_id: state.badUid ? "foreign" : state.uid,
            share_status: "OK",
            file_num: s.files.length,
            file_ids: s.files.map((f: JsonObject) => f.id),
            pass_code: state.hideCodes ? undefined : s.pass_code,
          })),
          next_page_token: "",
        };
      if (path === "share/password") {
        const row = shares.find((s) => s.share_id === body.share_id);
        return ok({ share_url: row?.share_url, pass_code: "a123" });
      }
      if (path === "share" && init?.method === "POST") {
        if (state.rejectShare)
          throw new AppError("USER_ACTION_REQUIRED", "建链被明确拒绝");
        state.creates++;
        const ids = body.fid_list ?? body.file_ids;
        const shareId = `mine${state.creates}`,
          url = `https://${kind === "uc" ? "drive.uc.cn" : "pan.xunlei.com"}/s/${shareId}`;
        const files = [...folders.values()]
          .flat()
          .filter((r) => ids.includes(r.fid ?? r.id));
        const row = {
          share_id: shareId,
          share_url: url,
          pass_code: "a123",
          files,
        };
        shares.unshift(row);
        if (state.lostShare) throw new Error("response lost");
        return ok(row);
      }
      throw new Error(`unhandled mock endpoint ${path}`);
    },
  };
  const provider =
    kind === "uc" ? new UcProvider(transport) : new XunleiProvider(transport);
  return { provider, transport, state, sourceFile, folders, shares };
}

test("Thunder confirms wrapped folder creation and carries share cursors through queue preflight", async () => {
  const d = drive("xunlei");
  d.state.wrappedFolderResponse = true;
  const json = d.transport.json.bind(d.transport);
  let secondPages = 0;
  d.transport.json = async (id, text, init) => {
    const url = new URL(text);
    const data = await json(id, text, init);
    if (
      url.pathname === "/drive/v1/share" &&
      init?.method === "GET" &&
      url.searchParams.get("share_id") === "source"
    ) {
      if (!url.searchParams.get("page_token"))
        return { ...data, files: [], next_page_token: "second-page" };
      assert.equal(url.searchParams.get("page_token"), "second-page");
      secondPages++;
    }
    return data;
  };
  const f = await fixture({ xunlei: d.provider });
  try {
    const a = (await f.app.invoke("account.add", {
      provider: "xunlei",
      alias: "迅雷本人",
    })) as Account;
    await f.app.invoke("account.check", { id: a.id });
    const saved = await f.add(true, {
      accountId: a.id,
      sourceText: "https://pan.xunlei.com/s/source?pwd=a123",
      selectedFiles: [d.sourceFile],
    });
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.app.repo.getJob(saved.jobId).stage, "completed");
    assert.ok(secondPages >= 2);
    assert.equal(d.state.folderCreates, 2);
    assert.equal(d.state.transfers, 1);
    await d.provider.ensureFolder(
      a,
      f.app.repo.getCopy(saved.copyId).directory,
    );
    assert.equal(d.state.folderCreates, 2);
  } finally {
    await f.cleanup();
  }
});

test("four-drive links canonicalize known hosts, preserve passwords and reject lookalike hosts", () => {
  for (const host of ["drive.uc.cn", "fast.uc.cn", "pan.uc.cn"])
    assert.deepEqual(parseShare(`https://${host}/s/testUC?pwd=a123`), {
      provider: "uc",
      shareKey: "testUC",
      url: "https://drive.uc.cn/s/testUC",
      code: "a123",
    });
  assert.equal(
    parseShare("https://pan.xunlei.com/s/VO_a-1?pwd=b456").provider,
    "xunlei",
  );
  for (const text of [
    "https://drive.uc.cn.evil.test/s/x",
    "https://pan.xunlei.com.evil.test/s/x",
  ])
    assert.throws(() => parseShare(text), { code: "INVALID_LINK" });
  assert.equal(
    providerApiAllowed("uc", "https://api-pan.xunlei.com/drive/v1/files"),
    false,
  );
  assert.equal(
    providerApiAllowed(
      "xunlei",
      "https://api-pan.xunlei.com:8443/drive/v1/files",
    ),
    false,
  );
  assert.equal(providerAuthAllowed("uc", "https://passport.uc.cn/login"), true);
  assert.equal(
    providerAuthAllowed("xunlei", "https://i.xunlei.com/login"),
    true,
  );
  assert.equal(providerAuthAllowed("uc", "https://i.xunlei.com/login"), false);
});

for (const kind of ["uc", "xunlei"] as const) {
  test(`${kind}: known rejection may resume, but a post-create verification failure only recovers history`, async () => {
    for (const afterWrite of [false, true]) {
      const d = drive(kind),
        f = await fixture({ [kind]: d.provider });
      try {
        const a = (await f.app.invoke("account.add", {
          provider: kind,
          alias: kind,
        })) as Account;
        await f.app.invoke("account.check", { id: a.id });
        const added = (await f.app.invoke("resource.save", {
          title: "恢复测试",
          sourceText: `https://${kind === "uc" ? "drive.uc.cn" : "pan.xunlei.com"}/s/source?pwd=a123`,
          category: "测试",
          tags: [],
          summary: "本人",
          accountId: a.id,
          directory: "/盘序资源",
          rightsConfirmed: true,
          selectedFiles: [d.sourceFile],
          enqueue: true,
        })) as { jobId: string };
        if (afterWrite) d.state.rejectHistory = true;
        else d.state.rejectShare = true;
        await f.app.queue.execute(added.jobId);
        const job = f.app.repo.getJob(added.jobId);
        assert.equal(
          job.checkpoint,
          afterWrite ? "share_requested" : "verified",
        );
        assert.equal(d.state.creates, afterWrite ? 1 : 0);
        d.state.rejectHistory = d.state.rejectShare = false;
        await f.app.invoke("job.retry", { id: added.jobId });
        await f.app.queue.execute(added.jobId);
        assert.equal(f.app.repo.getJob(added.jobId).stage, "completed");
        assert.equal(d.state.creates, 1);
        assert.equal(d.state.transfers, 1);
      } finally {
        await f.cleanup();
      }
    }
  });
  test(`${kind}: real adapter completes queued transfer, own-share verification, archive, split reuse and CSV import`, async () => {
    const d = drive(kind),
      f = await fixture({ [kind]: d.provider });
    try {
      const account = (await f.app.invoke("account.add", {
        provider: kind,
        alias: `${kind}本人`,
      })) as Account;
      await f.app.invoke("account.check", { id: account.id });
      const source = `https://${kind === "uc" ? "drive.uc.cn" : "pan.xunlei.com"}/s/source?pwd=a123`;
      const record = (await f.app.invoke("resource.save", {
        title: "自制测试资料",
        sourceText: source,
        category: "测试",
        tags: [],
        summary: "自主文件",
        accountId: account.id,
        directory: "/盘序资源",
        rightsConfirmed: true,
        selectedFiles: [d.sourceFile],
        enqueue: true,
      })) as { copyId: string; jobId: string };
      await f.app.queue.execute(record.jobId);
      assert.equal(f.app.repo.getJob(record.jobId).stage, "completed");
      const copy = f.app.repo.getCopy(record.copyId);
      assert.equal(copy.status, "ready");
      assert.equal(copy.ownerUid, "owner-new");
      assert.match(copy.shareUrl!, /\/s\/mine1$/);
      assert.equal(d.state.transfers, 1);
      assert.equal(d.state.creates, 1);
      const run = (await f.app.invoke("split.preview", {
        copyId: copy.id,
        depth: 3,
        mode: "all",
      })) as SplitRun;
      await f.app.queue.execute(run.jobId);
      const ready = f.app.operations.split(run.id);
      assert.equal(ready.items.length, 1);
      await f.app.invoke("split.start", {
        id: run.id,
        itemIds: [ready.items[0].id],
        rightsConfirmed: true,
      });
      await f.app.queue.execute(f.app.operations.split(run.id).items[0].jobId!);
      assert.equal(f.app.operations.split(run.id).items[0].status, "ready");
      assert.equal(d.state.creates, 1);
      const bundle = (await f.app.invoke("split.package", {
        id: run.id,
        itemIds: [ready.items[0].id],
      })) as { text: string };
      assert.match(bundle.text, /mine1/);
      assert.doesNotMatch(bundle.text, /source|a123/);
      const imported = (await f.app.invoke("resource.importPreview", {
        text: `标题,链接,分类\n另一份,${source.replace("/source", "/another")},测试`,
        targets: { [kind]: account.id },
      })) as { rows: { status: string }[] };
      assert.equal(imported.rows[0].status, "new");
      const accountAgain = f.app.repo.getAccount(account.id);
      d.state.uid = "other-user";
      await assert.rejects(f.app.invoke("account.check", { id: account.id }), {
        code: "ACCOUNT_UID_MISMATCH",
      });
      assert.equal(accountAgain.uid, "owner-new");
    } finally {
      await f.cleanup();
    }
  });
  test(`${kind}: a lost share response recovers from authenticated history without a second creation`, async () => {
    const d = drive(kind),
      f = await fixture({ [kind]: d.provider });
    try {
      const a = (await f.app.invoke("account.add", {
        provider: kind,
        alias: kind,
      })) as Account;
      const files: RemoteFile[] = [{ ...d.sourceFile, id: "own-file" }];
      d.folders.set("target", [
        kind === "uc"
          ? { fid: "own-file", file_name: files[0].name, dir: 0, size: 12 }
          : {
              id: "own-file",
              name: files[0].name,
              kind: "drive#file",
              size: "12",
            },
      ]);
      d.state.lostShare = true;
      await assert.rejects(d.provider.createShare(a, files, "测试"));
      const recovered = await d.provider.findOwnShare(a, files);
      assert.equal(recovered?.id, "mine1");
      assert.equal(d.state.creates, 1);
      assert.equal(
        await d.provider.verifyShare(a, "mine1", [
          { ...files[0], id: "foreign" },
        ]),
        false,
      );
      if (kind === "xunlei") {
        d.state.badUid = true;
        assert.equal(await d.provider.verifyShare(a, "mine1", files), false);
      }
    } finally {
      await f.cleanup();
    }
  });
}

test("UC empty login response cannot bind a leftover cookie UID", async () => {
  const f = await fixture();
  try {
    const p = new UcProvider({
      json: async () => ({ success: true, code: "OK", data: {} }),
      text: async () => "",
      principalId: async () => "stale-uid",
    });
    await assert.rejects(p.identity({ ...f.account, provider: "uc" }), {
      code: "AUTH_EXPIRED",
    });
  } finally {
    await f.cleanup();
  }
});

test("Thunder can verify and reuse a private own share when history omits its code", async () => {
  const d = drive("xunlei"),
    f = await fixture();
  try {
    const account = {
        ...f.account,
        provider: "xunlei" as const,
        uid: d.state.uid,
      },
      files = [{ ...d.sourceFile, id: "own-file" }];
    d.folders.set("target", [
      { id: "own-file", name: files[0].name, kind: "drive#file", size: "12" },
    ]);
    const share = await d.provider.createShare(account, files, "测试");
    d.state.hideCodes = true;
    await f.app.secrets.set("share:test-code", "a123");
    d.transport.ownShareCode = async (id, shareId) =>
      id === account.id && shareId === share.id
        ? f.app.secrets.get("share:test-code")
        : null;
    assert.equal(await d.provider.verifyShare(account, share.id, files), true);
    assert.equal((await d.provider.findOwnShare(account, files))?.code, "a123");
    assert.equal(d.state.creates, 1);
  } finally {
    await f.cleanup();
  }
});

test("Thunder share cursors and directory pages remain complete; repeated cursors fail closed", async () => {
  const f = await fixture(),
    account = { ...f.account, provider: "xunlei" as const };
  const requests: string[] = [];
  let repeat = false;
  const p = new XunleiProvider({
    text: async () => "",
    authHeaders: async () => ({ authorization: "Bearer fake" }),
    json: async (_id, text) => {
      const url = new URL(text),
        cursor = url.searchParams.get("page_token") ?? "";
      requests.push(cursor);
      const file = {
        id: cursor ? "second" : "first",
        name: cursor ? "第二.txt" : "第一.txt",
        kind: "drive#file",
        size: 1,
      };
      if (url.pathname.endsWith("/files"))
        return {
          files: [file],
          next_page_token: repeat ? "loop" : cursor ? "" : "next-opaque",
        };
      return {
        files: [file],
        share_status: "OK",
        pass_code_token: "pass",
        next_page_token: cursor ? "" : "next-opaque",
      };
    },
  });
  try {
    const source = parseShare("https://pan.xunlei.com/s/source");
    const first = await p.inspect(account, source);
    assert.equal(first.nextCursor, "next-opaque");
    await assert.rejects(p.inspect(account, source, "0", 2), {
      code: "CURSOR_REQUIRED",
    });
    assert.equal(
      (await p.inspect(account, source, "0", 2, first.nextCursor)).files[0].id,
      "second",
    );
    assert.equal((await p.list(account, "0")).length, 2);
    repeat = true;
    await assert.rejects(p.list(account, "0"), { code: "INCOMPLETE_LIST" });
  } finally {
    await f.cleanup();
  }
});

test("Thunder read authentication can refresh once; rejected or uncertain writes are never retried", async () => {
  const f = await fixture();
  let calls = 0,
    refreshes = 0;
  const p = new XunleiProvider({
    text: async () => "",
    authHeaders: async (_id, refresh) => {
      if (refresh) refreshes++;
      return { authorization: "Bearer session" };
    },
    json: async (_id, url, init) => {
      calls++;
      if (url.includes("/user/me")) {
        if (calls === 1) return { error_code: 16, error: "unauthenticated" };
        return { sub: "owner" };
      }
      if (init?.method === "POST")
        return { error_code: 9, error: "captcha_required" };
      return {
        files: [{ id: "src", name: "test.txt", kind: "drive#file", size: 1 }],
        share_status: "OK",
        pass_code_token: "pass",
      };
    },
  });
  try {
    const a = { ...f.account, provider: "xunlei" as const };
    await p.identity(a);
    assert.equal(refreshes, 1);
    assert.equal(calls, 2);
    const before = calls;
    await assert.rejects(
      p.transfer(
        a,
        parseShare("https://pan.xunlei.com/s/source"),
        [
          {
            id: "src",
            name: "test.txt",
            isDirectory: false,
            parentId: "0",
            size: 1,
          },
        ],
        "target",
      ),
      { code: "USER_ACTION_REQUIRED" },
    );
    assert.equal(calls - before, 2);
    assert.equal(refreshes, 1);
  } finally {
    await f.cleanup();
  }
});

test("Thunder credentials stay encrypted per account, rotate refresh tokens, clear cleanly and redact logs", async () => {
  const f = await fixture();
  let refreshCalls = 0;
  const sessions = new ThunderSession(() => f.app.secrets, {
    text: async () => "",
    json: async (id, _url, init) => {
      assert.equal(id, "a");
      assert.equal(JSON.parse(String(init?.body)).refresh_token, "refresh-a");
      refreshCalls++;
      return { access_token: "rotated-a", refresh_token: "refresh-a-2" };
    },
  });
  try {
    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "x-device-id": `device-${token}`,
      "x-client-id": "current-client",
      "x-captcha-token": "current-captcha",
      Cookie: "do-not-copy",
    });
    await Promise.all([
      sessions.capture("a", headers("access-a")),
      sessions.capture("b", headers("access-b")),
    ]);
    await sessions.captureRefresh("a", [
      { access_token: "other", refresh_token: "wrong" },
      { access_token: "access-a", refresh_token: "refresh-a" },
    ]);
    assert.equal(
      (await sessions.headers("a", true)).authorization,
      "Bearer rotated-a",
    );
    assert.equal(refreshCalls, 1);
    assert.equal(
      (await sessions.headers("b")).authorization,
      "Bearer access-b",
    );
    assert.equal((await sessions.headers("a")).cookie, undefined);
    const cipher = f.app.db.get<{ value: string }>(
      "SELECT value FROM secrets WHERE key=?",
      "drive-auth:xunlei:a",
    )!.value;
    assert.doesNotMatch(cipher, /refresh-a|rotated-a/);
    await sessions.capture("a", headers("different-user"));
    await assert.rejects(sessions.headers("a", true), { code: "AUTH_EXPIRED" });
    await sessions.clear("b");
    await assert.rejects(sessions.headers("b"), { code: "AUTH_EXPIRED" });
    const log = safeMessage(
      new Error(
        'Authorization: Bearer access-secret refresh_token="refresh-secret" {"captcha_token":"captcha-secret"}',
      ),
    );
    assert.doesNotMatch(log, /access-secret|refresh-secret|captcha-secret/);
  } finally {
    await f.cleanup();
  }
});
