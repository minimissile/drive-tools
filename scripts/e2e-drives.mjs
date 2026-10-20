import { openAccountForm } from "./e2e-account-form.mjs";
import { chooseOption } from "./e2e-select.mjs";
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// Browser plugin not available. Disposable Electron sessions and fully mocked HTTPS.
const require = createRequire(import.meta.url);
const dataPath = await mkdtemp(join(tmpdir(), "panxu-drives-e2e-"));
const evidence =
  process.env.PANXU_QA_DIR ??
  (await mkdtemp(join(tmpdir(), "panxu-drives-evidence-")));
await mkdir(evidence, { recursive: true });
const dev = process.env.PANXU_E2E_DEV === "1";
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  ...(dev
    ? { PANXU_DEV_URL: "http://127.0.0.1:5173", PANXU_DEV_ROOT: process.cwd() }
    : {}),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: process.env.PANXU_ELECTRON_PATH ?? require("electron"),
  args: [dev ? join(process.cwd(), "dist-dev") : process.cwd()],
  env,
  timeout: 45000,
});
const checks = [],
  errors = [];
let page;
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.getByRole("navigation", { name: "主导航" }).waitFor();
  await page.emulateMedia({ colorScheme: "light" });
  assert.match(await page.title(), /盘序/);
  if (dev) assert.equal(new URL(page.url()).origin, "http://127.0.0.1:5173");
  else assert.match(page.url(), /dist\/index.html/);
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true });
  for (const kind of ["uc", "xunlei"]) {
    const alias = kind === "uc" ? "UC 本人测试号" : "迅雷本人测试号";
    await nav("账号管理").click();
    await openAccountForm(page);
    await chooseOption(page.getByLabel("新增账号网盘"), kind);
    await page.getByLabel("新增账号别名").fill(alias);
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    const card = page
      .locator(".account-row")
      .filter({ has: page.getByRole("heading", { name: alias, exact: true }) });
    await card.waitFor();
    const account = await page.evaluate(
      async (kind) =>
        (await window.panxu.invoke("snapshot")).accounts.find(
          (a) => a.provider === kind,
        ),
      kind,
    );
    await app.evaluate(
      async ({ session, BrowserWindow }, { accountId, kind }) => {
        const s = session.fromPartition(`persist:panxu-${accountId}`);
        const state = { transfers: 0, shares: 0, blocked: 0 };
        (globalThis.__panxuDrivesQa ??= {})[kind] = state;
        const folders = new Map([["0", []]]),
          shares = [],
          filename = `${kind}-本人文件.txt`;
        let sequence = 0,
          headerListener;
        const registerHeaders = s.webRequest.onBeforeSendHeaders.bind(
          s.webRequest,
        );
        s.webRequest.onBeforeSendHeaders = (filter, listener) => {
          headerListener = listener;
          registerHeaders(filter, listener);
        };
        const row = (id, name = filename, directory = false) =>
          kind === "uc"
            ? {
                fid: id,
                file_name: name,
                dir: directory ? 1 : 0,
                size: directory ? 0 : 12,
                share_fid_token: `token-${id}`,
              }
            : {
                id,
                name,
                kind: directory ? "drive#folder" : "drive#file",
                size: directory ? "0" : "12",
              };
        const respond = (data) =>
          new Response(JSON.stringify(data), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "https://pan.xunlei.com",
              "Access-Control-Allow-Headers":
                "Authorization, x-device-id, x-client-id, x-captcha-token, Content-Type",
              "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            },
          });
        const ok = (data) =>
          kind === "uc" ? { code: 0, status: 200, data } : data;
        const fetchMock = async (text, init = {}) => {
          const url = new URL(String(text)),
            body = init.body ? JSON.parse(String(init.body)) : {},
            method = init.method ?? "GET";
          if (method === "OPTIONS") return respond({});
          if (url.pathname === "/capture-test") {
            // Custom HTTPS handlers do not emit native network header events.
            // Supply the same event shape for this isolated protocol fixture.
            const authWindow = BrowserWindow.getAllWindows().find(
              (w) => w.webContents.session === s,
            );
            headerListener?.(
              {
                requestHeaders: Object.fromEntries(new Headers(init.headers)),
                webContentsId: authWindow.webContents.id,
              },
              () => {},
            );
            return respond({ ok: true });
          }
          const path = url.pathname.replace(
            kind === "uc" ? "/1/clouddrive/" : "/drive/v1/",
            "",
          );
          if (path === "/account/info")
            return respond({
              success: true,
              code: "OK",
              data: { uid: `owner-${accountId}`, nickname: "测试本人" },
            });
          if (path === "/v1/user/me") {
            if (
              new Headers(init.headers).get("authorization") !==
              "Bearer fixture-access"
            )
              throw new Error("session capture missing");
            return respond({ sub: `owner-${accountId}`, name: "测试本人" });
          }
          if (path === "member" && kind === "uc")
            return respond(
              ok({ total_capacity: 10737418240, use_capacity: 1024 }),
            );
          if (path === "about" && kind === "xunlei")
            return respond({ quota: { limit: "10737418240", usage: "1024" } });
          if (path === "file/sort" || (path === "files" && method === "GET")) {
            const parent =
              url.searchParams.get(kind === "uc" ? "pdir_fid" : "parent_id") ||
              "0";
            return respond(
              ok(
                kind === "uc"
                  ? { list: folders.get(parent) ?? [] }
                  : { files: folders.get(parent) ?? [], next_page_token: "" },
              ),
            );
          }
          if (path === "file" || (path === "files" && method === "POST")) {
            const id = `folder-${++sequence}`,
              parent = body.pdir_fid || body.parent_id || "0",
              file = row(id, body.file_name || body.name, true);
            folders.set(parent, [...(folders.get(parent) ?? []), file]);
            folders.set(id, []);
            return respond(ok(kind === "uc" ? { fid: id } : file));
          }
          if (path === "share/sharepage/v2/detail")
            return respond(ok({ token_info: { stoken: "fixture-stoken" } }));
          if (
            path === "share/sharepage/detail" ||
            (path === "share" && method === "GET")
          ) {
            const key = url.searchParams.get(
                kind === "uc" ? "pwd_id" : "share_id",
              ),
              own = shares.find((share) => share.share_id === key),
              files = own?.files ?? [row("source-file")];
            return respond(
              kind === "uc"
                ? {
                    ...ok({ list: files, share: { title: "本人测试" } }),
                    metadata: { _total: files.length },
                  }
                : {
                    files,
                    share_status: "OK",
                    pass_code_token: "fixture-pass-token",
                    next_page_token: "",
                  },
            );
          }
          if (path === "share/sharepage/save" || path === "share/restore") {
            state.transfers++;
            folders.set(body.to_pdir_fid ?? body.parent_id, [row("own-file")]);
            return respond(
              ok(
                kind === "uc"
                  ? { task_id: "save-task" }
                  : { restore_task_id: "save-task" },
              ),
            );
          }
          if (path === "task") return respond(ok({ status: 2 }));
          if (path === "tasks/save-task")
            return respond({ progress: 100, phase: "PHASE_TYPE_COMPLETE" });
          if (path === "share" && method === "POST") {
            state.shares++;
            const ids = body.fid_list ?? body.file_ids;
            const shareId = `fixture-own-${state.shares}`,
              shareUrl = `https://${kind === "uc" ? "drive.uc.cn" : "pan.xunlei.com"}/s/${shareId}`;
            const share = {
              share_id: shareId,
              share_url: shareUrl,
              pass_code: "a123",
              files: [...folders.values()]
                .flat()
                .filter((f) => ids.includes(f.fid ?? f.id)),
            };
            shares.unshift(share);
            return respond(ok(share));
          }
          if (path === "share/mypage/detail")
            return respond(
              ok({
                list: shares.map((share) => ({
                  ...share,
                  status: 1,
                  file_num: share.files.length,
                })),
              }),
            );
          if (path === "share/password")
            return respond(
              ok({
                share_url: shares.find(
                  (share) => share.share_id === body.share_id,
                )?.share_url,
                pass_code: "a123",
              }),
            );
          if (path === "share/list")
            return respond({
              data: shares.map((share) => ({
                ...share,
                user_id: `owner-${accountId}`,
                share_status: "OK",
                file_num: share.files.length,
              })),
              next_page_token: "",
            });
          state.blocked++;
          throw new Error(
            `unexpected mock request ${url.hostname}${url.pathname}`,
          );
        };
        s.fetch = fetchMock;
        await s.protocol.handle("https", async (request) => {
          const url = new URL(request.url);
          if (
            url.hostname === "drive.uc.cn" ||
            url.hostname === "pan.xunlei.com"
          ) {
            const script =
              kind === "xunlei"
                ? `localStorage.setItem('credentials_fixture-client', JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh'})); fetch('https://api-pan.xunlei.com/capture-test',{headers:{Authorization:'Bearer fixture-access','x-device-id':'fixture-device','x-client-id':'fixture-client','x-captcha-token':'fixture-captcha'}}).then(()=>{document.body.textContent='模拟登录会话已准备';});`
                : `document.body.textContent='模拟登录会话已准备';`;
            return new Response(
              `<html><head><meta charset="utf-8"><title>隔离测试登录</title></head><body><script>${script}</script></body></html>`,
              { headers: { "Content-Type": "text/html; charset=utf-8" } },
            );
          }
          return fetchMock(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.method === "POST"
              ? { body: await request.text() }
              : {}),
          });
        });
      },
      { accountId: account.id, kind },
    );
    const opened = app.waitForEvent("window");
    await card
      .getByRole("button", { name: "登录本人账号", exact: true })
      .click();
    const auth = await opened;
    auth.on("console", (m) =>
      console.log("auth console", kind, m.type(), m.text().slice(0, 300)),
    );
    auth.on("pageerror", (e) => console.log("auth pageerror", kind, e.message));
    try {
      await auth
        .getByText("模拟登录会话已准备", { exact: true })
        .waitFor({ timeout: 10000 });
    } catch (error) {
      console.log(
        "auth state",
        kind,
        auth.url(),
        await auth.locator("body").textContent(),
      );
      await auth.screenshot({
        path: join(evidence, `${kind}-auth-failure.png`),
      });
      throw error;
    }
    await auth.close();
    await card.getByText("已登录", { exact: true }).waitFor();
    checks.push(
      `${kind}: official-window session isolation and UID binding (mock HTTPS)`,
    );
    await nav("录入资源").click();
    await page
      .getByLabel("网盘分享链接", { exact: true })
      .fill(
        `https://${kind === "uc" ? "drive.uc.cn" : "pan.xunlei.com"}/s/source?pwd=a123`,
      );
    await page
      .getByRole("button", { name: "解析链接与提取码", exact: true })
      .click();
    await page
      .getByLabel("资源标题", { exact: true })
      .fill(`${kind} 自主测试资源`);
    assert.equal(
      await page
        .getByLabel("转存与分享账号", { exact: true })
        .getAttribute("data-value"),
      account.id,
    );
    const handoffOpened = app.waitForEvent("window");
    await page
      .getByRole("button", { name: "在本人窗口打开分享", exact: true })
      .click();
    const handoff = await handoffOpened;
    await handoff.getByText("模拟登录会话已准备", { exact: true }).waitFor();
    assert.equal(new URL(handoff.url()).searchParams.get("pwd"), "a123");
    assert.equal(new URL(handoff.url()).pathname, "/s/source");
    await handoff.close();
    checks.push(
      `${kind}: official share handoff keeps selected account, source and code`,
    );
    await page
      .getByRole("button", { name: "读取分享内容", exact: true })
      .click();
    await page
      .getByRole("checkbox", { name: `选择${kind}-本人文件.txt`, exact: true })
      .check();
    assert.equal(
      await page
        .getByRole("checkbox", { name: "我有权保存和分享该资源", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "保存并开始转存", exact: true })
      .click();
    await page.waitForFunction(async (kind) => {
      const data = await window.panxu.invoke("resource.search", {
        query: `${kind} 自主测试资源`,
      });
      return data[0]?.copies[0]?.status === "ready";
    }, kind);
    const stats = await app.evaluate(
      (_app, kind) => globalThis.__panxuDrivesQa[kind],
      kind,
    );
    assert.equal(stats.transfers, 1);
    assert.equal(stats.shares, 1);
    assert.equal(stats.blocked, 0);
    await nav("资源库").click();
    await page.getByRole("searchbox").fill(`${kind} 自主测试资源`);
    await page
      .getByRole("button", { name: "更多资源操作", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "拆分为多个链接", exact: true })
      .click();
    await page
      .getByRole("button", { name: "读取三级目录", exact: true })
      .click();
    await page
      .getByRole("tree", { name: "资源目录树" })
      .getByRole("checkbox")
      .waitFor();
    await page
      .getByRole("checkbox", {
        name: `拆分选择${kind}-本人文件.txt`,
        exact: true,
      })
      .check();
    await page.getByLabel("拆分分享权利确认", { exact: true }).check();
    await page
      .getByRole("button", { name: "生成所选1个本人链接", exact: true })
      .click();
    await page
      .getByRole("button", { name: "导出本人链接CSV", exact: true })
      .click({ trial: true });
    assert.equal(
      await app.evaluate(
        (_app, kind) => globalThis.__panxuDrivesQa[kind].shares,
        kind,
      ),
      1,
    );
    await page.locator(".toast").waitFor({ state: "hidden", timeout: 15000 });
    await page.evaluate(() => {
      document.querySelector(".main-content").scrollTop = 0;
    });
    await page.screenshot({ path: join(evidence, `${kind}-split.png`) });
    checks.push(
      `${kind}: UI transfer, own share, archive and split reuses verified own link`,
    );
  }
  await nav("账号管理").click();
  await page.screenshot({ path: join(evidence, "four-drive-accounts.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 760),
  );
  await page.screenshot({ path: join(evidence, "accounts-compact.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  checks.push(
    "840px layout, page identity, nonblank renderer and no console errors",
  );
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, dataPath, evidence, errors },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "failure.png") });
  console.error(
    "Drive QA failed",
    evidence,
    errors,
    page ? await page.locator(".toast").allTextContents() : [],
  );
  throw error;
} finally {
  await app.close();
}
