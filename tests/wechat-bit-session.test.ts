import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { saveContentImage } from "../core/content-assets";
import type { createWechatBitSession } from "../desktop/wechat-bit-session";
import type { WebsiteAccount } from "../shared/website-accounts";
import type { WechatDraftPayload } from "../shared/wechat";

let browser: Browser, root: string;
let create: typeof createWechatBitSession;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZfQAAAAASUVORK5CYII=",
  "base64",
);
const account: WebsiteAccount = {
  id: "web_bit_wechat",
  provider: "wechat",
  alias: "离线公众号",
  uid: "gh_fixture123",
  status: "connected",
  createdAt: "2026-11-10",
  updatedAt: "2026-11-10",
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), "panxu-wechat-bit-"));
  const output = join(root, "session.mjs");
  await build({
    entryPoints: [
      fileURLToPath(
        new URL("../desktop/wechat-bit-session.ts", import.meta.url),
      ),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    plugins: [
      {
        name: "isolated-image-codec",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron",
            namespace: "fixture",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `
        export class BrowserWindow { constructor(){ throw Error('Bit flow must not create an Electron window'); } }
        export const nativeImage={createFromBuffer(bytes){return {isEmpty:()=>!bytes.length,getSize:()=>({width:1,height:1}),toPNG:()=>bytes,toBitmap:()=>bytes};}};
      `,
            loader: "js",
          }));
        },
      },
    ],
  });
  create = (await import(pathToFileURL(output).href)).createWechatBitSession;
  browser = await chromium.launch({
    executablePath:
      process.env.PANXU_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
});
after(async () => {
  await browser?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const workspace = await mkdtemp(join(root, "workspace-"));
  const calls: { path: string; method: string; fields?: URLSearchParams }[] =
    [];
  let uid = account.uid,
    multi = false,
    badReceipt = false,
    loggedIn = true;
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.hostname === "mmbiz.qpic.cn")
      return route.fulfill({ contentType: "image/png", body: png });
    if (url.origin !== "https://mp.weixin.qq.com") return route.abort();
    const fields =
      request.method() === "POST" && url.pathname === "/cgi-bin/operate_appmsg"
        ? new URLSearchParams(request.postData() ?? "")
        : undefined;
    calls.push({ path: url.pathname, method: request.method(), fields });
    if (url.pathname === "/" && loggedIn)
      return route.fulfill({
        status: 302,
        headers: { location: "/cgi-bin/home?token=123456" },
      });
    if (url.pathname === "/cgi-bin/filetransfer")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          base_resp: { ret: 0 },
          cdn_url: "https://mmbiz.qpic.cn/fixture/0",
          file_id: "300001",
        }),
      });
    if (url.pathname === "/cgi-bin/operate_appmsg")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          badReceipt
            ? { base_resp: { ret: 0 } }
            : {
                base_resp: { ret: 0 },
                appMsgId: fields?.get("appmsgid") || "100001",
              },
        ),
      });
    const html = `<!doctype html><meta charset="utf-8"><script>${loggedIn ? `window.wx={data:{user_name:${JSON.stringify(uid)},nick_name:'离线公众号',token:'123456'}};` : ""}window.appmsgData={app_id:'100001',multi_item:${JSON.stringify(multi ? [{}, {}] : [{}])}};</script><p>公众号离线页面</p>`;
    await route.fulfill({ contentType: "text/html", body: html });
  });
  const image = await saveContentImage(workspace, png, "插图.png");
  const imageUrl = `panxu-media://wechat/${image.file}`;
  const payload: WechatDraftPayload = {
    key: "fixture",
    aiAssisted: false,
    body: "资料说明",
    uid: account.uid!,
    title: "资源说明",
    author: "",
    digest: "资料介绍",
    html: `<p>资料</p><img src="${imageUrl}">`,
    coverUrl: imageUrl,
    sourceUrl: "https://pan.baidu.com/s/example",
  };
  const session = create(
    () => workspace,
    async () => {
      throw Error("Article reader not used");
    },
  )(context, account);
  return {
    context,
    calls,
    payload,
    session,
    setUid(value: string) {
      uid = value;
    },
    setMulti() {
      multi = true;
    },
    setBad() {
      badReceipt = true;
    },
    setLoggedOut() {
      loggedIn = false;
    },
    async close() {
      await context.close();
    },
  };
}

test("比特公众号读取原始ID，图片上传与草稿新建/更新在同一上下文，临时页关闭且无额外回读", async () => {
  const f = await fixture();
  try {
    const unrelated = await f.context.newPage();
    const state = await f.session.verify();
    assert.equal(state.uid, account.uid);
    assert.equal(state.hasSession, true);
    let before = 0,
      receipts = 0;
    const saved = await f.session.port.saveDraft(
      account,
      f.payload,
      async () => {
        before++;
      },
      async () => {
        receipts++;
      },
    );
    assert.equal(saved.draftId, "100001");
    assert.equal(saved.url.includes("token="), false);
    assert.equal(
      f.calls.filter((c) => c.path === "/cgi-bin/filetransfer").length,
      1,
    );
    assert.equal(f.calls.filter((c) => c.path === "/cgi-bin/appmsg").length, 0);
    const posted = f.calls.find((c) => c.fields)?.fields!;
    assert.equal(posted.get("sourceurl0"), f.payload.sourceUrl);
    assert.match(posted.get("content0")!, /mmbiz.qpic.cn/);
    await f.session.port.saveDraft(
      account,
      { ...f.payload, draftId: saved.draftId },
      async () => {
        before++;
      },
    );
    assert.equal(
      f.calls.filter((c) => c.path === "/cgi-bin/filetransfer").length,
      1,
      "更新及封面复用素材",
    );
    assert.equal(before, 2);
    assert.equal(receipts, 1);
    assert.deepEqual(f.context.pages(), [unrelated]);
    await f.session.port.open(account, saved.url);
    const editor = f.context.pages().find((p) => p !== unrelated)!;
    assert.equal(new URL(editor.url()).searchParams.get("appmsgid"), "100001");
    assert.equal(unrelated.isClosed(), false);
  } finally {
    await f.close();
  }
});

test("错号与退出不上传草稿，多篇旧稿禁止覆盖，无有效回执不报成功且不重发", async () => {
  const f = await fixture();
  try {
    f.setUid("gh_other123");
    await assert.rejects(
      f.session.port.saveDraft(account, f.payload, async () => {}),
      { code: "WECHAT_ACCOUNT_MISMATCH" },
    );
    assert.equal(
      f.calls.some((c) => c.method === "POST"),
      false,
    );
    f.setUid(account.uid!);
    f.setMulti();
    await assert.rejects(
      f.session.port.saveDraft(
        account,
        { ...f.payload, draftId: "100001" },
        async () => {},
      ),
      /单篇/,
    );
    assert.equal(
      f.calls.some((c) => c.method === "POST"),
      false,
    );
    f.setBad();
    await assert.rejects(
      f.session.port.saveDraft(account, f.payload, async () => {}),
      { code: "WECHAT_DRAFT_UNCERTAIN" },
    );
    assert.equal(
      f.calls.filter((c) => c.path === "/cgi-bin/operate_appmsg").length,
      1,
    );
    f.setLoggedOut();
    assert.equal((await f.session.verify()).hasSession, false);
    assert.equal(f.context.pages().length, 0);
  } finally {
    await f.close();
  }
});
