import { providerRequestReferer } from "../core/providers/request-context";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { GuangyaProvider } from "../core/providers/guangya";
import { PikPakProvider } from "../core/providers/pikpak";
import { WebTokenSession } from "../core/providers/web-token-session";
import { parseShare, validateOutgoingLinks } from "../core/links";
import { providerApiAllowed, providerAuthAllowed } from "../shared/providers";
import { normalizeShareStatistic } from "../core/providers/share-statistics";
import { AppError, ProviderHttpError } from "../core/errors";
import type { Account, RemoteFile } from "../shared/types";
import type { JsonObject, ProviderTransport } from "../core/providers/provider";

function drive(kind: "guangya" | "pikpak") {
  const guangya = kind === "guangya",
    host = guangya ? "www.guangyapan.com" : "mypikpak.com";
  const state = {
    uid: "owner-new",
    transfers: 0,
    shares: 0,
    lostShare: false,
    foreign: false,
    lostRestore: false,
    calls: [] as string[],
  };
  const folders = new Map<string, JsonObject[]>([["0", []]]),
    shares: JsonObject[] = [];
  const sourceFile: RemoteFile = {
    id: "src",
    name: "自主资料.txt",
    isDirectory: false,
    size: 1,
    parentId: "0",
  };
  const row = (id: string, name = sourceFile.name, dir = false) =>
    guangya
      ? {
          fileId: id,
          fileName: name,
          resType: dir ? 2 : 1,
          fileSize: dir ? 0 : 1,
        }
      : {
          id,
          name,
          kind: dir ? "drive#folder" : "drive#file",
          size: dir ? 0 : 1,
        };
  let seq = 0;
  const ok = (data: JsonObject) => (guangya ? { code: 0, data } : data);
  const transport: ProviderTransport = {
    text: async () => "",
    authHeaders: async () => ({ authorization: "Bearer fixture-token" }),
    json: async (_id, text, init) => {
      const u = new URL(text),
        body = JSON.parse(String(init?.body ?? "{}")),
        path = u.pathname;
      state.calls.push(path);
      assert.equal(providerApiAllowed(kind, text), true);
      assert.equal(u.hostname.includes("xunlei"), false);
      if (path === "/v1/user/me") return { sub: state.uid, name: "测试本人" };
      if (path.endsWith("get_assets"))
        return ok({ totalSpaceSize: 1000, usedSpaceSize: 1 });
      if (path.endsWith("/about"))
        return { quota: { limit: "1000", usage: "1" } };
      if (path.endsWith("get_share_summary"))
        return ok({
          title: sourceFile.name,
          shareStatus: 1,
          userId: state.foreign ? "foreign" : state.uid,
        });
      if (path.endsWith("get_share_access_token"))
        return ok({ accessToken: body.shareId });
      if (
        path.endsWith("get_share_page_files_list") ||
        (path.endsWith("/share") && init?.method === "GET")
      ) {
        const key = guangya ? body.accessToken : u.searchParams.get("share_id"),
          own = shares.find((s) => (s.shareId ?? s.share_id) === key);
        const files = own ? own.files : [row("src")];
        return ok(
          guangya
            ? { list: files, hasMore: false }
            : {
                files,
                pass_code_token: "share-access",
                share_status: "OK",
                next_page_token: "",
              },
        );
      }
      if (
        path.endsWith("get_file_list") ||
        (path.endsWith("/files") && init?.method === "GET")
      ) {
        const parent =
          (guangya ? body.parentId : u.searchParams.get("parent_id")) || "0";
        return ok(
          guangya
            ? { list: body.page ? [] : (folders.get(parent) ?? []) }
            : { files: folders.get(parent) ?? [], next_page_token: "" },
        );
      }
      if (
        path.endsWith("create_dir") ||
        (path.endsWith("/files") && init?.method === "POST")
      ) {
        const parent = (body.parentId ?? body.parent_id) || "0",
          id = `folder-${++seq}`,
          f = row(id, body.dirName ?? body.name, true);
        folders.set(parent, [...(folders.get(parent) ?? []), f]);
        folders.set(id, []);
        return ok(guangya ? { fileId: id } : f);
      }
      if (path.endsWith("restore_share") || path.endsWith("share/restore")) {
        state.transfers++;
        const parent = body.parentId ?? body.parent_id;
        assert.deepEqual(body.fileIds ?? body.file_ids, ["src"]);
        folders.set(parent, [row("own-file")]);
        if (state.lostRestore)
          throw new ProviderHttpError(500, "", "response lost", true);
        return ok(
          guangya ? { taskId: "save-task" } : { restore_task_id: "save-task" },
        );
      }
      if (path.endsWith("get_task_status")) return ok({ status: 2 });
      if (path.endsWith("tasks/save-task"))
        return { progress: 100, phase: "PHASE_TYPE_COMPLETE" };
      if (path.endsWith("get_share_list") || path.endsWith("share/list")) {
        const rows =
          guangya && body.page
            ? []
            : shares.map((s) => ({
                ...s,
                ...(guangya
                  ? {
                      shareStatus: 1,
                      userId: state.foreign ? "foreign" : state.uid,
                    }
                  : {
                      share_status: "OK",
                      user_id: state.foreign ? "foreign" : state.uid,
                      file_ids: s.files.map((f: JsonObject) => f.id),
                      view_count: "12",
                      restore_count: "3",
                      expiration_at: "-1",
                    }),
              }));
        return ok(
          guangya ? { list: rows } : { data: rows, next_page_token: "" },
        );
      }
      if (
        path.endsWith("share_file") ||
        (path.endsWith("/share") && init?.method === "POST")
      ) {
        state.shares++;
        const ids = body.fileIds ?? body.file_ids,
          id = `mine-${state.shares}`,
          url = `https://${host}/s/${id}`;
        if (!guangya) {
          assert.equal(body.share_to, "publiclink");
          assert.equal(body.pass_code_option, "NOT_REQUIRED");
        }
        const files = [...folders.values()]
          .flat()
          .filter((f) => ids.includes(f.fileId ?? f.id));
        const share = guangya
          ? { shareId: id, shareUrl: url, code: "a123", files }
          : { share_id: id, share_url: url, pass_code: "a123", files };
        shares.push(share);
        if (state.lostShare)
          throw new ProviderHttpError(500, "", "response lost", true);
        return ok(share);
      }
      throw new Error(`Unhandled ${path}`);
    },
  };
  return {
    state,
    transport,
    sourceFile,
    provider: guangya
      ? new GuangyaProvider(transport)
      : new PikPakProvider(transport),
    source: `https://${host}/s/source?${guangya ? "code" : "pwd"}=a123`,
  };
}

for (const kind of ["guangya", "pikpak"] as const) {
  test(`${kind}: isolated adapter completes queue, owned link, archive, split reuse and bulk import`, async () => {
    const d = drive(kind),
      f = await fixture({ [kind]: d.provider });
    try {
      const account = (await f.app.invoke("account.add", {
        provider: kind,
        alias: kind,
      })) as Account;
      await f.app.invoke("account.check", { id: account.id });
      assert.equal(
        f.app.repo.getAccount(account.id).capacity?.value?.totalBytes,
        1000,
      );
      const saved = await f.add(true, {
        accountId: account.id,
        sourceText: d.source,
        selectedFiles: [d.sourceFile],
      });
      await f.app.queue.execute(saved.jobId);
      const job = f.app.repo.getJob(saved.jobId);
      assert.equal(job.stage, "completed", job.error ?? "");
      const copy = f.app.repo.getCopy(saved.copyId);
      assert.equal(copy.ownerUid, "owner-new");
      assert.match(copy.shareUrl!, /\/s\/mine-1$/);
      assert.equal(d.state.transfers, 1);
      assert.equal(d.state.shares, 1);
      const run = (await f.app.invoke("split.preview", {
        copyId: copy.id,
        depth: 1,
      })) as { id: string; jobId: string };
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
      assert.equal(d.state.shares, 1);
      const preview = (await f.app.invoke("resource.importPreview", {
        text: `标题,链接,分类\n第二份,${d.source.replace("source", "another")},测试`,
        targets: { [kind]: account.id },
      })) as { rows: { account: string; status: string }[] };
      assert.equal(preview.rows[0].account, account.alias);
      assert.equal(preview.rows[0].status, "new");
      const stats = (await f.app.invoke("shareStats.refresh", {
        accountIds: [account.id],
      })) as { status: string }[];
      assert.equal(stats[0].status, kind === "guangya" ? "skipped" : "success");
    } finally {
      await f.cleanup();
    }
  });
  test(`${kind}: lost share response recovers authenticated history without duplicate share/restore`, async () => {
    const d = drive(kind),
      f = await fixture({ [kind]: d.provider });
    try {
      const account = (await f.app.invoke("account.add", {
        provider: kind,
        alias: kind,
      })) as Account;
      await f.app.invoke("account.check", { id: account.id });
      const saved = await f.add(true, {
        accountId: account.id,
        sourceText: d.source,
        selectedFiles: [d.sourceFile],
      });
      d.state.lostShare = true;
      await f.app.queue.execute(saved.jobId);
      assert.equal(f.app.repo.getJob(saved.jobId).stage, "needs_review");
      d.state.lostShare = false;
      await f.app.invoke("job.retry", { id: saved.jobId });
      await f.app.queue.execute(saved.jobId);
      assert.equal(f.app.repo.getJob(saved.jobId).stage, "completed");
      assert.equal(d.state.transfers, 1);
      assert.equal(d.state.shares, 1);
      d.state.foreign = true;
      assert.equal(
        await d.provider.verifyShare(
          f.app.repo.getAccount(account.id),
          "mine-1",
          f.app.repo.getCopy(saved.copyId).files,
          "a123",
        ),
        false,
      );
    } finally {
      await f.cleanup();
    }
  });
  test(`${kind}: uncertain transfer is not replayed and never publishes a source link`, async () => {
    const d = drive(kind),
      f = await fixture({ [kind]: d.provider });
    try {
      const account = (await f.app.invoke("account.add", {
        provider: kind,
        alias: kind,
      })) as Account;
      await f.app.invoke("account.check", { id: account.id });
      const saved = await f.add(true, {
        accountId: account.id,
        sourceText: d.source,
        selectedFiles: [d.sourceFile],
      });
      d.state.lostRestore = true;
      await f.app.queue.execute(saved.jobId);
      assert.equal(f.app.repo.getJob(saved.jobId).stage, "needs_review");
      assert.equal(d.state.transfers, 1);
      assert.equal(d.state.shares, 0);
      assert.equal(f.app.repo.getCopy(saved.copyId).shareUrl, null);
    } finally {
      await f.cleanup();
    }
  });
}

test("new drive hosts/codes are strict, outgoing ownership checks cover both providers", () => {
  assert.equal(
    parseShare("https://guangyapan.com/s/source?code=a123").code,
    "a123",
  );
  assert.equal(
    parseShare("https://mypikpak.com/s/source?pwd=b234").provider,
    "pikpak",
  );
  for (const provider of ["guangya", "pikpak"] as const) {
    const host = provider === "guangya" ? "www.guangyapan.com" : "mypikpak.com";
    assert.throws(() => parseShare(`https://${host}.evil.test/s/x`));
    assert.equal(
      providerApiAllowed(provider, "https://api-pan.xunlei.com/drive/v1/files"),
      false,
    );
    assert.equal(
      providerAuthAllowed(provider, "https://evil.test/login"),
      false,
    );
    assert.throws(
      () =>
        validateOutgoingLinks(
          `https://${host}/s/source`,
          `https://${host}/s/own`,
          true,
        ),
      { code: "FOREIGN_SHARE_BLOCKED" },
    );
  }
});

test("PikPak saves zero is exact; missing, overflow and negative metrics stay unknown", () => {
  const base = {
    share_id: "mine",
    share_status: "OK",
    share_url: "https://mypikpak.com/s/mine",
    expiration_at: "-1",
  };
  const zero = normalizeShareStatistic(
    { ...base, view_count: "0", restore_count: "0", download_count: "999" },
    "pikpak",
  );
  assert.equal(zero.metrics.saves.value, 0);
  assert.equal(zero.metrics.downloads.value, null);
  for (const n of [undefined, -1, "-1", "9007199254740993", "", false]) {
    const row = normalizeShareStatistic(
      { ...base, view_count: n, restore_count: n },
      "pikpak",
    );
    assert.equal(row.metrics.saves.value, null);
    assert.equal(row.metrics.views.value, null);
  }
});

test("token sessions isolate provider/account, reject header injection and coalesce rotating refresh", async () => {
  const f = await fixture();
  try {
    let refreshes = 0;
    const transport: ProviderTransport = {
      text: async () => "",
      json: async (_id, url) => {
        assert.equal(new URL(url).hostname, "user.mypikpak.com");
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return { access_token: "new-token", refresh_token: "new-refresh" };
      },
    };
    const a = new WebTokenSession(() => f.app.secrets, transport, "pikpak"),
      b = new WebTokenSession(() => f.app.secrets, transport, "guangya");
    assert.equal(
      await a.capture("same", {
        authorization: "Bearer test",
        "x-client-id": "own-client",
        "x-device-id": "own-device",
        cookie: "never-save",
        "x-captcha-token": "bad\nheader",
      }),
      true,
    );
    await a.captureRefresh("same", [
      { access_token: "test", refresh_token: "refresh" },
    ]);
    await assert.rejects(b.headers("same"), { code: "AUTH_EXPIRED" });
    await assert.rejects(a.headers("another"), { code: "AUTH_EXPIRED" });
    const result = await Promise.all([
      a.headers("same", true),
      a.headers("same", true),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(result[0].authorization, "Bearer new-token");
    assert.equal(result[0].cookie, undefined);
    assert.equal(result[0]["x-captcha-token"], undefined);
    await a.clear("same");
    await assert.rejects(a.headers("same"), { code: "AUTH_EXPIRED" });
    assert.equal(
      await b.capture("same", {
        authorization: "Bearer guangya",
        did: "own-device",
      }),
      true,
    );
    assert.equal((await b.headers("same")).did, "own-device");
  } finally {
    await f.cleanup();
  }
});

test("Guangya reads refresh once, read POSTs do not create uncertainty, write POSTs never repeat", async () => {
  const account = { id: "g", provider: "guangya", uid: "owner" } as Account;
  const refresh: boolean[] = [];
  let calls = 0;
  const p = new GuangyaProvider({
    text: async () => "",
    authHeaders: async (_id, next) => {
      refresh.push(!!next);
      return { authorization: "Bearer fixture" };
    },
    json: async () => {
      if (++calls === 1) throw new ProviderHttpError(401, "", "expired");
      return { sub: "owner" };
    },
  });
  assert.equal((await p.identity(account)).uid, "owner");
  assert.deepEqual(refresh, [false, true]);
  assert.equal(calls, 2);
  const d = drive("guangya"),
    original = d.transport.json;
  let writes = 0;
  d.transport.json = async (id, url, init) => {
    if (url.endsWith("get_assets"))
      throw new ProviderHttpError(500, "", "read failed", true);
    if (url.endsWith("restore_share")) {
      writes++;
      throw new ProviderHttpError(500, "", "write result unknown", true);
    }
    return original(id, url, init);
  };
  await assert.rejects(
    d.provider.capacity(account),
    (e: unknown) => e instanceof AppError && !e.uncertain,
  );
  await assert.rejects(
    d.provider.transfer(
      account,
      parseShare(d.source),
      [d.sourceFile],
      "target",
    ),
    (e: unknown) => e instanceof AppError && e.uncertain,
  );
  assert.equal(writes, 1);
});

test("Guangya rejects repeated share cursors, unsafe IDs, bad passcodes and changed manifests before writes", async () => {
  const a = { id: "g", provider: "guangya", uid: "owner-new" } as Account;
  for (const scenario of ["cursor", "id", "code", "changed"] as const) {
    const d = drive("guangya"),
      original = d.transport.json;
    let writes = 0;
    d.transport.json = async (id, url, init) => {
      if (url.endsWith("restore_share")) writes++;
      if (url.endsWith("get_share_access_token") && scenario === "code")
        return { code: 209, msg: "invalid code" };
      const data = await original(id, url, init);
      if (url.endsWith("get_share_page_files_list")) {
        if (scenario === "cursor") {
          data.data.list = [];
          data.data.hasMore = true;
          data.data.cursor = "repeat";
        }
        if (scenario === "id") data.data.list[0].fileId = 9007199254740992;
        if (scenario === "changed") data.data.list[0].fileName = "已更名.txt";
      }
      return data;
    };
    await assert.rejects(
      d.provider.transfer(a, parseShare(d.source), [d.sourceFile], "target"),
      {
        code:
          scenario === "cursor"
            ? "INCOMPLETE_LIST"
            : scenario === "id"
              ? "REMOTE_SCHEMA_CHANGED"
              : scenario === "code"
                ? "BAD_CODE"
                : "SOURCE_CHANGED",
      },
    );
    assert.equal(writes, 0);
  }
});

test("Guangya account and drive requests follow distinct official CORS contracts", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const provider = new GuangyaProvider({
    text: async () => "",
    authHeaders: async () => ({
      authorization: "Bearer test",
      did: "drive-device",
      dt: "4",
      smid: "drive-smid",
      "x-device-id": "account-device",
      "x-client-id": "account-client",
    }),
    json: async (_id, url, init) => {
      seen.push({ url, init });
      return url.includes("account.guangyapan.com")
        ? { sub: "owner" }
        : { code: 0, data: { totalSpaceSize: "100", usedSpaceSize: "1" } };
    },
  });
  const account = { id: "g", provider: "guangya" } as Account;
  await provider.identity(account);
  await provider.capacity(account);
  const identity = seen[0].init!,
    drive = seen[1].init!;
  assert.equal(identity.credentials, "include");
  assert.equal(drive.credentials, "omit");
  const auth = new Headers(identity.headers),
    business = new Headers(drive.headers);
  for (const key of ["did", "dt", "smid"]) assert.equal(auth.has(key), false);
  assert.equal(auth.get("authorization"), "Bearer test");
  assert.equal(auth.get("x-device-id"), "account-device");
  assert.equal(auth.get("x-client-id"), "account-client");
  for (const key of ["x-client-id", "x-device-id", "x-captcha-token"])
    assert.equal(business.has(key), false);
  assert.equal(business.get("authorization"), "Bearer test");
  assert.equal(business.get("did"), "drive-device");
  assert.equal(business.get("dt"), "4");
});

test("Guangya invalid-token response uses authentication recovery rather than generic remote failure", async () => {
  for (const result of [
    { code: 117, msg: "无效token" },
    {
      error_code: 16,
      error: "unauthenticated",
      error_description: "Authorize failed",
    },
  ]) {
    let calls = 0;
    const provider = new GuangyaProvider({
      text: async () => "",
      authHeaders: async (_id, refresh) => {
        if (refresh) throw new AppError("AUTH_EXPIRED", "请重新登录");
        return { authorization: "Bearer fixture" };
      },
      json: async () => {
        calls++;
        return result;
      },
    });
    await assert.rejects(
      provider.identity({ id: "g", provider: "guangya" } as Account),
      { code: "AUTH_EXPIRED" },
    );
    assert.equal(calls, 1);
  }
});

test("PikPak native requests use an origin-only cross-origin Referer for identity and capacity", async () => {
  const seen: { url: URL; init?: RequestInit }[] = [];
  const provider = new PikPakProvider({
    text: async () => "",
    authHeaders: async () => ({ authorization: "Bearer fixture" }),
    json: async (_id, text, init) => {
      const url = new URL(text);
      seen.push({ url, init });
      return url.pathname === "/v1/user/me"
        ? { sub: "owner" }
        : { quota: { limit: "100", usage: "1" } };
    },
  });
  const account = { id: "p", provider: "pikpak" } as Account;
  await provider.identity(account);
  await provider.capacity(account);
  assert.equal(seen.length, 2);
  for (const r of seen) {
    const h = new Headers(r.init?.headers);
    assert.equal(h.get("Referer"), "https://mypikpak.com/");
    assert.equal(h.get("Origin"), "https://mypikpak.com");
    assert.notEqual(r.url.origin, h.get("Origin"));
  }
  assert.equal(
    providerRequestReferer(
      "baidu",
      new URL("https://pan.baidu.com/api/gettemplatevariable"),
    ),
    "https://pan.baidu.com/disk/main",
  );
  assert.equal(
    providerRequestReferer("baidu", new URL("https://different.example/api")),
    "https://pan.baidu.com/",
  );
  assert.equal(
    providerRequestReferer(
      "xunlei",
      new URL("https://api-pan.xunlei.com/drive/v1/about"),
    ),
    "https://pan.xunlei.com/",
  );
});
