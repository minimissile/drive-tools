import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";

const electronFixture = `
import { EventEmitter } from "node:events";
export const app = new EventEmitter();
const profiles = new Map();
export const session = {
  fromPartition(name) {
    if (!profiles.has(name)) profiles.set(name, {
      name, setPermissionRequestHandler() {}, on() {}
    });
    return profiles.get(name);
  }
};
export class BrowserWindow extends EventEmitter {
  static created = [];
  static holdTable = false;
  static waitingForTable = false;
  static holdLoad = false;
  constructor(options) {
    super();
    this.profile = options.webPreferences.session;
    this.visible = options.show;
    this.url = "";
    this.destroyed = false;
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, {
      getURL: () => this.url,
      setWindowOpenHandler: () => {},
      stop: () => this.releaseTable?.(["候选词"]),
      executeJavaScript: async script => {
        if (script.includes("/share/list")) return {errno:0,list:[{fs_id:1,server_filename:"目录资料.pdf",isdir:0,size:120}]};
        if (script.includes("SHARE_UK")) return {kind:"ready",shareId:"100",uk:"200",title:"分享资料"};
        if (script.includes("table.list-table")) {
          if (BrowserWindow.holdTable) {
            BrowserWindow.waitingForTable = true;
            return new Promise(resolve => { this.releaseTable = resolve; });
          }
          return ["候选词"];
        }
        if (script.includes("button.click()")) {
          this.url = "https://www.5118.com/seo/newwords/fixture/";
          return true;
        }
        if (script.includes("form.seo-search-box")) return true;
        throw new Error("未识别的页面操作");
      }
    });
    BrowserWindow.created.push(this);
  }
  async loadURL(url) {
    this.url = url;
    this.loads = (this.loads || 0) + 1;
    queueMicrotask(() => this.webContents.emit("dom-ready"));
    if (BrowserWindow.holdLoad) return new Promise(() => {});
  }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  restore() {}
  destroy() { this.destroyed = true; this.emit("closed"); }
  close() {
    let prevented = false;
    this.emit("close", {preventDefault: () => { prevented = true; }});
    if (!prevented) this.destroy();
  }
}
`;

test("5118检查和多次检索复用同一窗口，关闭转后台，取消保留窗口，工作空间隔离", async () => {
  const folder = await mkdtemp(join(tmpdir(), "panxu-keyword-browser-"));
  const output = join(folder, "session.mjs");
  try {
    await build({
      stdin: {
        contents: `export {createResourceKeywordWeb} from ${JSON.stringify(resolve("desktop/resource-keyword-web.ts"))}; export {createBaiduShareReader} from ${JSON.stringify(resolve("desktop/baidu-share-reader.ts"))}; export {BrowserWindow} from "electron";`,
        resolveDir: process.cwd(),
      },
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "isolated-electron",
          setup(build) {
            build.onResolve({ filter: /^electron$/ }, () => ({
              path: "electron",
              namespace: "fixture",
            }));
            build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: electronFixture,
              loader: "js",
            }));
          },
        },
      ],
    });
    const { createResourceKeywordWeb, createBaiduShareReader, BrowserWindow } =
      await import(pathToFileURL(output).href);
    let workspace = "first";
    const browser = createResourceKeywordWeb(() => workspace);
    const signal = new AbortController().signal;
    await browser.check(signal);
    await browser.read("资料", signal);
    await browser.read("练习", signal);
    assert.equal(BrowserWindow.created.length, 1);
    const first = BrowserWindow.created[0];
    assert.equal(first.destroyed, false);
    assert.equal(browser.isOpen(), false);
    await browser.open();
    assert.equal(browser.isOpen(), true);
    first.close();
    assert.equal(first.destroyed, false);
    assert.equal(browser.isOpen(), false);
    await browser.check(signal);
    assert.equal(BrowserWindow.created.length, 1);
    first.url = "https://account.5118.com/signin";
    await assert.rejects(browser.check(signal), {
      code: "KEYWORD_5118_LOGIN_REQUIRED",
    });
    first.url = "https://account.5118.com/profile";
    await browser.check(signal);
    assert.equal(BrowserWindow.created.length, 1);
    BrowserWindow.holdTable = true;
    const controller = new AbortController();
    const reading = browser.read("取消操作", controller.signal);
    await setImmediate();
    assert.equal(BrowserWindow.waitingForTable, true);
    await assert.rejects(browser.check(signal), {
      code: "KEYWORD_BROWSER_BUSY",
    });
    controller.abort();
    await assert.rejects(reading, { name: "AbortError" });
    assert.equal(first.destroyed, false);
    BrowserWindow.holdTable = false;
    await browser.read("恢复检索", signal);
    assert.equal(BrowserWindow.created.length, 1);
    workspace = "second";
    await browser.check(signal);
    assert.equal(BrowserWindow.created.length, 2);
    assert.notEqual(BrowserWindow.created[1].profile.name, first.profile.name);
    browser.close();
    assert.ok(
      BrowserWindow.created.every(
        (window: { destroyed: boolean }) => window.destroyed,
      ),
    );
    const reader = createBaiduShareReader(() => workspace);
    BrowserWindow.holdLoad = true;
    const source = {
      provider: "baidu",
      shareKey: "1fixture",
      code: "abcd",
      url: "https://pan.baidu.com/s/1fixture",
    };
    const share = await reader.inspect(source, "0", 1);
    assert.equal(share.files[0].name, "目录资料.pdf");
    const page = BrowserWindow.created.at(-1);
    assert.equal(
      page.loads,
      1,
      "目录读取从DOM就绪后继续，无需等待整页资源加载",
    );
    await reader.open(source);
    await reader.open(source);
    await reader.inspect(source, "0", 1);
    assert.equal(page.loads, 1, "打开官方分享和再次读取不重复加载页面");
    reader.close(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
