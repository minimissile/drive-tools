import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { createJianshuSession } from "../desktop/jianshu-session";
import type { JianshuFillCheckpoint, JianshuPayload } from "../shared/jianshu";
import type { WebsiteAccount } from "../shared/website-accounts";
import type { WebsiteIdentityContext } from "../desktop/website-identity-session";

// This fixture verifies native window ownership and the editor adapter boundary.
// Real DOM typing/uploading is covered separately by the shared editor tests.
const electronFixture = `
import { EventEmitter } from 'node:events';
let sequence = 0;
export class BrowserWindow extends EventEmitter {
  static created = [];
  static redirectNextLoad = null;
  constructor(options) {
    super(); this.options = options; this.url = ''; this.loads = []; this.destroyed = false;
    this.shown = 0; this.focused = 0;
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, {
      getURL: () => this.url,
      setWindowOpenHandler: handler => { this.openHandler = handler; },
      executeJavaScript: async script => {
        if (script !== 'fixture:fill') throw Error('Unexpected native page script');
        if (!/\\/notes\\/[1-9]\\d*$/.test(this.url)) this.url = 'https://www.jianshu.com/writer#/notebooks/1/notes/' + ++sequence;
        return this.url;
      }
    });
    BrowserWindow.created.push(this);
  }
  async loadURL(url) {
    this.loads.push(url);
    this.url = BrowserWindow.redirectNextLoad || url;
    BrowserWindow.redirectNextLoad = null;
  }
  show() { this.shown++; }
  focus() { this.focused++; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
`;
const editorFixture = `
export {jianshuCreatedDraftUrl,jianshuEditorScript,prepareJianshuDraftCreation} from ${JSON.stringify(resolve("core/jianshu/editor.ts"))};
export const fillCalls = [];
export async function fillJianshuEditor(driver, payload, onCheckpoint, readImage) {
  fillCalls.push({driver, payload, onCheckpoint, readImage});
  const editorUrl = await driver.evaluate('fixture:fill');
  if (driver.url() !== editorUrl) throw Error('Driver URL is stale');
  if (onCheckpoint) await onCheckpoint({editorUrl});
  for (const image of payload.images) {
    if (!readImage) throw Error('No validated image reader');
    await readImage(image);
  }
  return {opened:true,filled:true,editorUrl,message:'fixture:filled',uploadedImages:payload.images.length,totalImages:payload.images.length};
}
`;
type FixtureWindow = {
  options: { webPreferences: { session: unknown; sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean } };
  url: string;
  loads: string[];
  shown: number;
  focused: number;
  destroyed: boolean;
  destroy(): void;
  openHandler(): { action: string };
  webContents: { emit(name: string, details: {url: string; isMainFrame?: boolean; preventDefault(): void}): void };
};
let folder: string;
let create: typeof createJianshuSession;
let FixtureBrowserWindow: { created: FixtureWindow[]; redirectNextLoad: string | null; new(options: unknown): FixtureWindow };
let fillCalls: { payload: JianshuPayload; onCheckpoint?: unknown; readImage?: unknown; driver: { createDraft?: () => Promise<string> } }[];

before(async () => {
  folder = await mkdtemp(join(tmpdir(), "panxu-jianshu-native-"));
  const output = join(folder, "session.mjs");
  await build({
    stdin: {
      contents: `export {createJianshuSession} from ${JSON.stringify(resolve("desktop/jianshu-session.ts"))}; export {BrowserWindow} from 'electron'; export {fillCalls} from ${JSON.stringify(resolve("core/jianshu/editor"))};`,
      resolveDir: process.cwd(),
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [{
      name: "native-jianshu-boundary",
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({path: "electron", namespace: "fixture"}));
        builder.onResolve({ filter: /[/\\]jianshu[/\\]editor$/ }, () => ({path: "editor", namespace: "fixture"}));
        builder.onLoad({filter: /.*/, namespace: "fixture"}, args => ({contents: args.path === "electron" ? electronFixture : editorFixture, loader: "js", resolveDir: process.cwd()}));
      },
    }],
  });
  const module = await import(pathToFileURL(output).href);
  create = module.createJianshuSession;
  FixtureBrowserWindow = module.BrowserWindow;
  fillCalls = module.fillCalls;
});
after(async () => {
  if (folder) await rm(folder, {recursive: true, force: true});
});
const account: WebsiteAccount = {
  id: "web_jianshu_native", provider: "jianshu", uid: "fixtureuid",
  alias: "测试账号", status: "connected", createdAt: "2026-11-24", updatedAt: "2026-11-24",
};
const draft = (id = "jianshu_first"): JianshuPayload => ({
  id, title: "本地文章", text: "正文", html: "<p>正文</p>", images: [],
  aiAssisted: false, resourceUrl: null, sourceUrls: [],
});
function context(profileName: string): WebsiteIdentityContext {
  return { profile: { name: profileName, cookies: { on() {} } } as unknown as WebsiteIdentityContext["profile"] };
}
const latest = () => FixtureBrowserWindow.created.at(-1)!;

test("简书内置编辑与登录窗口互不挤占，同本地稿复用且不同稿独立", async () => {
  const login = new FixtureBrowserWindow({});
  login.url = "https://www.jianshu.com/sign_in";
  const ctx = context("first");
  ctx.window = login as unknown as WebsiteIdentityContext["window"];
  const session = create(() => ctx);
  const first = await session.port.prepare(account, draft());
  const firstWindow = latest();
  assert.notEqual(firstWindow, login);
  assert.equal(ctx.window, login, "已有登录窗口保持原归属");
  assert.equal(login.url, "https://www.jianshu.com/sign_in");
  assert.equal(login.destroyed, false);
  const count = FixtureBrowserWindow.created.length;
  const repeated = await session.port.prepare(account, { ...draft(), editorUrl: first.editorUrl });
  assert.equal(FixtureBrowserWindow.created.length, count, "相同本地稿和远端稿复用同窗");
  assert.equal(repeated.editorUrl, first.editorUrl);
  assert.equal(firstWindow.loads.length, 1, "重试不重复导航");
  const second = await session.port.prepare(account, draft("jianshu_second"));
  assert.notEqual(second.editorUrl, first.editorUrl);
  assert.notEqual(latest(), firstWindow);
  assert.equal(firstWindow.destroyed, false);
  assert.equal(session.isOpen(), true);
  firstWindow.destroy();
  assert.equal(session.isOpen(), true, "另一篇稿件窗口仍受跟踪");
  latest().destroy();
  assert.equal(session.isOpen(), false);
  assert.equal(login.destroyed, false);
});

test("简书重开准确草稿，保留用户切换到其他稿件的旧窗口，关闭旧窗不破坏新映射", async () => {
  const ctx = context("resume");
  const session = create(() => ctx);
  const prepared = await session.port.prepare(account, draft());
  const old = latest();
  const otherNote = "https://www.jianshu.com/writer#/notebooks/1/notes/999999";
  old.url = otherNote;
  const resumed = await session.port.prepare(account, { ...draft(), editorUrl: prepared.editorUrl });
  const active = latest();
  assert.notEqual(active, old);
  assert.equal(active.loads[0], prepared.editorUrl);
  assert.equal(resumed.editorUrl, prepared.editorUrl);
  assert.equal(old.url, otherNote, "不导航覆盖用户正在查看的其他稿件");
  assert.equal(old.destroyed, false);
  old.destroy();
  const count = FixtureBrowserWindow.created.length;
  await session.port.prepare(account, { ...draft(), editorUrl: prepared.editorUrl });
  assert.equal(FixtureBrowserWindow.created.length, count, "旧窗口关闭不能清除新窗口映射");
  active.destroy();
  assert.equal(session.isOpen(), false);
  await session.port.prepare(account, { ...draft(), fillCheckpoint: { editorUrl: prepared.editorUrl } });
  assert.equal(latest().loads[0], prepared.editorUrl, "已关闭窗口从准确 checkpoint 重开");
  latest().destroy();
});

test("简书编辑窗口按真实工作空间 profile 隔离，返回原工作空间继续原窗", async () => {
  const contexts = [context("space-a"), context("space-b")];
  let current = 0;
  const session = create(() => contexts[current]);
  const first = await session.port.prepare(account, draft());
  const firstWindow = latest();
  current = 1;
  await session.port.prepare(account, draft());
  const secondWindow = latest();
  assert.notEqual(secondWindow, firstWindow);
  assert.notEqual(secondWindow.options.webPreferences.session, firstWindow.options.webPreferences.session);
  assert.equal(firstWindow.destroyed, false);
  current = 0;
  const count = FixtureBrowserWindow.created.length;
  await session.port.prepare(account, { ...draft(), editorUrl: first.editorUrl });
  assert.equal(FixtureBrowserWindow.created.length, count);
  assert.equal(firstWindow.focused, 2);
  firstWindow.destroy();
  secondWindow.destroy();
});

test("简书只在显式填写时透传 checkpoint 与受控图片读取，错误平台不打开窗口", async () => {
  const ctx = context("images");
  const checkpoints: JianshuFillCheckpoint[] = [];
  const read: unknown[] = [];
  const reader = async (image: unknown) => { read.push(image); return Buffer.from("test"); };
  const session = create(() => ctx, reader);
  const count = FixtureBrowserWindow.created.length;
  const calls = fillCalls.length;
  assert.equal(session.status(account).hasSession, false);
  assert.equal(read.length, 0, "读取账号状态不触发图片读取");
  assert.equal(fillCalls.length, calls);
  await assert.rejects(session.port.prepare({ ...account, provider: "weibo" }, draft()), { code: "JIANSHU_ACCOUNT" });
  assert.equal(FixtureBrowserWindow.created.length, count);
  assert.equal(read.length, 0);
  const payload = draft();
  payload.images = [{ name: "配图.png", file: `${"a".repeat(64)}.png`, sha256: "a".repeat(64), storage: "content-assets" }];
  const checkpoint = async (value: JianshuFillCheckpoint) => { checkpoints.push(value); };
  const result = await session.port.prepare(account, payload, checkpoint);
  assert.equal(typeof fillCalls.at(-1)!.driver.createDraft, "function", "新稿填写由本窗口的创建回执驱动，不回退猜测route");
  assert.equal(fillCalls.at(-1)!.onCheckpoint, checkpoint, "服务的持久化回调未经替换传给共用填稿引擎");
  assert.equal(fillCalls.at(-1)!.readImage, reader);
  assert.deepEqual(read, payload.images);
  assert.equal(checkpoints[0].editorUrl, result.editorUrl);
  assert.equal(result.uploadedImages, 1);
  const native = latest();
  assert.deepEqual(native.openHandler(), { action: "deny" });
  const prefs = native.options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  let prevented = false;
  native.webContents.emit("will-navigate", {url: "https://www.jianshu.com.evil.test/writer", preventDefault() { prevented = true; }});
  assert.equal(prevented, true, "编辑窗不允许离开准确官方域名");
  native.destroy();
});

test("查看已填写简书草稿只聚焦准确原窗，不调用填稿引擎或读取图片", async () => {
  const ctx = context("readonly-existing");
  let reads = 0;
  const session = create(() => ctx, async () => {
    reads++;
    throw Error("只读打开不应读取配图");
  });
  const prepared = await session.port.prepare(account, draft());
  const existing = latest();
  const created = FixtureBrowserWindow.created.length;
  const calls = fillCalls.length;
  const opened = await session.port.openEditor!(account, prepared.editorUrl);
  assert.deepEqual(opened, { opened: true, editorUrl: prepared.editorUrl });
  assert.equal(FixtureBrowserWindow.created.length, created);
  assert.equal(existing.loads.length, 1, "查看原稿不重新加载，保留官网正在编辑的内容");
  assert.equal(existing.focused, 2);
  assert.equal(fillCalls.length, calls, "查看原稿不经过 prepare 或 fill");
  assert.equal(reads, 0);
  assert.equal(session.isOpen(), true);
  existing.destroy();
  assert.equal(session.isOpen(), false);
});

test("只读打开简书草稿后填写复用同一账号和准确URL窗口，关闭清理全部归属", async () => {
  const login = new FixtureBrowserWindow({});
  login.url = "https://www.jianshu.com/sign_in";
  const ctx = context("readonly-first");
  ctx.window = login as unknown as WebsiteIdentityContext["window"];
  const session = create(() => ctx);
  const noteUrl = "https://www.jianshu.com/writer#/notebooks/2/notes/121212";
  const calls = fillCalls.length;
  await session.port.openEditor!(account, noteUrl);
  const readonly = latest();
  assert.equal(fillCalls.length, calls);
  assert.equal(readonly.loads[0], noteUrl);
  assert.equal(ctx.window, login);
  assert.equal(login.url, "https://www.jianshu.com/sign_in");
  const created = FixtureBrowserWindow.created.length;
  await session.port.prepare(account, { ...draft(), editorUrl: noteUrl });
  assert.equal(FixtureBrowserWindow.created.length, created, "填稿复用同账号的只读原稿窗口");
  assert.equal(readonly.loads.length, 1);
  assert.equal(fillCalls.length, calls + 1);
  readonly.destroy();
  assert.equal(session.isOpen(), false, "关闭同时清除本地稿件键和note键");
  await session.port.openEditor!(account, noteUrl);
  assert.equal(FixtureBrowserWindow.created.length, created + 1);
  latest().destroy();
  assert.equal(login.destroyed, false);
});

test("只读简书原稿按工作空间隔离，保留已切换稿件窗口并拒绝非准确地址", async () => {
  const contexts = [context("readonly-space-a"), context("readonly-space-b")];
  let current = 0;
  const session = create(() => contexts[current]);
  const url = "https://www.jianshu.com/writer#/notebooks/3/notes/131313";
  const calls = fillCalls.length;
  await session.port.openEditor!(account, url);
  const first = latest();
  first.url = "https://www.jianshu.com/writer#/notebooks/3/notes/141414";
  await session.port.openEditor!(account, url);
  const reopened = latest();
  assert.notEqual(reopened, first);
  assert.equal(first.destroyed, false);
  assert.equal(first.loads.length, 1, "用户切到其他原稿后不导航覆盖");
  current = 1;
  await session.port.openEditor!(account, url);
  const otherSpace = latest();
  assert.notEqual(otherSpace, reopened);
  assert.notEqual(otherSpace.options.webPreferences.session, reopened.options.webPreferences.session);
  const created = FixtureBrowserWindow.created.length;
  for (const invalid of [
    "https://www.jianshu.com/writer#/notebooks/3",
    `${url}?redirect=other`,
    "https://www.jianshu.com.evil.test/writer#/notebooks/3/notes/131313",
  ])
    await assert.rejects(session.port.openEditor!(account, invalid), { code: "JIANSHU_EDITOR_INPUT" });
  await assert.rejects(session.port.openEditor!({ ...account, provider: "weibo" }, url), { code: "JIANSHU_EDITOR_INPUT" });
  await assert.rejects(session.port.openEditor!({ ...account, uid: null }, url), { code: "JIANSHU_EDITOR_INPUT" });
  assert.equal(FixtureBrowserWindow.created.length, created);
  assert.equal(fillCalls.length, calls, "任何只读打开都不进入填稿流程");
  first.destroy();
  reopened.destroy();
  assert.equal(session.isOpen(), true, "另一空间打开的原稿仍被跟踪");
  otherSpace.destroy();
  assert.equal(session.isOpen(), false);
});

test("简书只读打开遇到官网登录跳转时不误报原稿已打开或调用填稿", async () => {
  const ctx = context("readonly-redirect");
  const session = create(() => ctx);
  const calls = fillCalls.length;
  FixtureBrowserWindow.redirectNextLoad = "https://www.jianshu.com/sign_in";
  await assert.rejects(
    session.port.openEditor!(account, "https://www.jianshu.com/writer#/notebooks/4/notes/151515"),
    { code: "JIANSHU_EDITOR_ORIGIN" },
  );
  assert.equal(fillCalls.length, calls);
  assert.equal(session.isOpen(), true, "保留已打开的官网登录现场");
  latest().destroy();
  assert.equal(session.isOpen(), false);
});
