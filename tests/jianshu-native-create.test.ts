import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { createNativeJianshuDraft } from "../desktop/jianshu-create-draft";

const notebook = "57443510";
const oldUrl = `https://www.jianshu.com/writer#/notebooks/${notebook}/notes/146614893`;
const createdUrl = `https://www.jianshu.com/writer#/notebooks/${notebook}/notes/146622674`;
const endpoint = "https://www.jianshu.com/author/notes";
const rawNote = () => ({ id: 146622674, notebook_id: Number(notebook), shared: false, last_compiled_at: 0 });

class DebuggerFixture extends EventEmitter {
  attached = false;
  attachCalls = 0;
  detachCalls = 0;
  commands: { method: string; params?: Record<string, unknown> }[] = [];
  bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  failEnable = false;
  failRead = false;
  beforeEnable?: () => void;
  isAttached() { return this.attached; }
  attach() {
    if (this.attached) throw Error("Another debugger owns this target");
    this.attached = true;
    this.attachCalls++;
  }
  detach() {
    this.attached = false;
    this.detachCalls++;
    this.emit("detach", {}, "target closed");
  }
  async sendCommand(method: string, params?: Record<string, unknown>) {
    this.commands.push({ method, params });
    if (method === "Network.enable") {
      this.beforeEnable?.();
      if (this.failEnable) throw Error("Network setup failed");
      return {};
    }
    if (method === "Network.getResponseBody") {
      if (this.failRead) throw Error("Response no longer retained");
      const value = this.bodies.get(String(params?.requestId));
      if (!value) throw Error("Unknown response id");
      return value;
    }
    throw Error("Unexpected debugger command");
  }
  observe(method: string, params: unknown, sessionId?: string) {
    this.emit("message", {}, method, params, sessionId);
  }
  request(id: string, body: unknown = { notebook_id: Number(notebook), title: "2026-11-24", at_bottom: false }, url = endpoint, method = "POST") {
    this.observe("Network.requestWillBeSent", { requestId: id, request: { method, url, postData: typeof body === "string" ? body : JSON.stringify(body) } });
  }
  respond(id: string, value: unknown = rawNote(), status = 201, url = endpoint, base64 = false) {
    const body = JSON.stringify(value);
    this.bodies.set(id, { body: base64 ? Buffer.from(body).toString("base64") : body, base64Encoded: base64 });
    this.observe("Network.responseReceived", { requestId: id, response: { url, status } });
    this.observe("Network.loadingFinished", { requestId: id });
  }
}
class ContentsFixture extends EventEmitter {
  url = oldUrl;
  debugger = new DebuggerFixture();
  clicked = 0;
  destroyed = false;
  onCreate?: () => void;
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  async executeJavaScript(script: string) {
    const match = script.match(/\)\((\{.*\})\);\s*\}\)\(\)$/s);
    assert.ok(match, "native adapter uses shared official page command");
    const input = JSON.parse(match[1]);
    if (input.action === "prepareCreate") return { editorUrl: this.url, notebookId: notebook };
    assert.equal(input.action, "create");
    assert.equal(input.expectedEditorUrl, this.url);
    assert.equal(input.expectedNotebookId, notebook);
    assert.ok(this.debugger.listenerCount("message") > 0, "response listener precedes the click");
    assert.ok(this.debugger.commands.some((call) => call.method === "Network.enable"));
    this.clicked++;
    this.onCreate?.();
    return true;
  }
  asContents() { return this as unknown as WebContents; }
}
function assertClean(contents: ContentsFixture) {
  assert.equal(contents.debugger.listenerCount("message"), 0);
  assert.equal(contents.debugger.listenerCount("detach"), 0);
  assert.equal(contents.listenerCount("destroyed"), 0);
}

test("native简书只取此次官方POST的文集回执，初始化恢复旧稿和其他请求不能替代", async () => {
  const contents = new ContentsFixture();
  const debug = contents.debugger;
  contents.onCreate = () => {
    // Writer initialization may move back to an old note while creation is in flight.
    contents.url = oldUrl;
    debug.request("read-old", {}, `/author/notebooks/${notebook}/notes`, "GET");
    debug.respond("read-old", { id: 146614893, notebook_id: notebook, shared: false });
    debug.request("other-book", { notebook_id: 1234 });
    debug.respond("other-book");
    debug.request("other-origin", { notebook_id: notebook }, "https://www.jianshu.com.evil.test/author/notes");
    debug.respond("other-origin");
    debug.request("correct");
    debug.respond("wrong-request-id", { id: 146614893, notebook_id: notebook, shared: false });
    debug.respond("correct");
  };
  assert.equal(await createNativeJianshuDraft(contents.asContents(), 100), createdUrl);
  assert.equal(contents.url, oldUrl, "新稿身份来自回执而不是route差异");
  assert.equal(contents.clicked, 1);
  assert.deepEqual(debug.commands.filter((call) => call.method === "Network.getResponseBody").map((call) => call.params?.requestId), ["correct"]);
  assert.equal(debug.detachCalls, 1);
  assertClean(contents);
});

test("native简书兼容官方表单文集ID和base64回执，并忽略子目标会话", async () => {
  const contents = new ContentsFixture();
  contents.onCreate = () => {
    contents.debugger.observe("Network.requestWillBeSent", { requestId: "child", request: { method: "POST", url: endpoint, postData: JSON.stringify({ notebook_id: notebook }) } }, "another-session");
    contents.debugger.request("form", `notebook_id=${notebook}&title=test`);
    contents.debugger.respond("form", rawNote(), 200, endpoint, true);
  };
  assert.equal(await createNativeJianshuDraft(contents.asContents(), 100), createdUrl);
  assert.equal(contents.clicked, 1);
  assertClean(contents);
});

test("native简书没有准确POST回执时不会以跳转URL当成功，超时不重复点击且清理监听", async () => {
  const contents = new ContentsFixture();
  contents.onCreate = () => { contents.url = createdUrl; };
  await assert.rejects(createNativeJianshuDraft(contents.asContents(), 10), { code: "JIANSHU_CREATE_UNCERTAIN", uncertain: true });
  assert.equal(contents.clicked, 1);
  assert.equal(contents.debugger.detachCalls, 1);
  assertClean(contents);
});

test("native简书拒绝已发布、错误文集、不完整、错误HTTP与无法读取的创建回执", async (t) => {
  const cases = [
    { name: "已发布", value: { ...rawNote(), shared: true } },
    { name: "错误文集", value: { ...rawNote(), notebook_id: 1234 } },
    { name: "缺少ID", value: { notebook_id: notebook, shared: false } },
    { name: "缺少未公开状态", value: { id: 146622674, notebook_id: notebook, last_compiled_at: 0 } },
    { name: "已设定时发布", value: { ...rawNote(), schedule_publish_at: "2026-11-25T10:00:00.000Z" } },
    { name: "HTTP失败", value: rawNote(), status: 500 },
    { name: "回执读取失败", value: rawNote(), failRead: true },
    { name: "回执跳转", value: rawNote(), url: `${endpoint}?redirect=true` },
  ];
  for (const spec of cases) await t.test(spec.name, async () => {
    const contents = new ContentsFixture();
    contents.debugger.failRead = !!spec.failRead;
    contents.onCreate = () => {
      contents.debugger.request("create");
      contents.debugger.respond("create", spec.value, spec.status, spec.url);
    };
    await assert.rejects(createNativeJianshuDraft(contents.asContents(), 100), { code: "JIANSHU_CREATE_UNCERTAIN", uncertain: true });
    assert.equal(contents.clicked, 1);
    assertClean(contents);
  });
});

test("native简书调试器已有拥有者时不点击、不接管、不detach其他监听", async () => {
  const contents = new ContentsFixture();
  const existing = () => {};
  contents.debugger.attached = true;
  contents.debugger.on("message", existing);
  await assert.rejects(createNativeJianshuDraft(contents.asContents(), 100), { code: "JIANSHU_CREATE_INSPECTOR_BUSY", uncertain: false });
  assert.equal(contents.clicked, 0);
  assert.equal(contents.debugger.attachCalls, 0);
  assert.equal(contents.debugger.detachCalls, 0);
  assert.equal(contents.debugger.isAttached(), true);
  assert.deepEqual(contents.debugger.listeners("message"), [existing]);
});

test("native简书准备监听失败或页面切换时未点击，并清理自己创建的调试会话", async (t) => {
  await t.test("Network初始化失败", async () => {
    const contents = new ContentsFixture();
    contents.debugger.failEnable = true;
    await assert.rejects(createNativeJianshuDraft(contents.asContents(), 100), { code: "JIANSHU_CREATE_OBSERVER", uncertain: false });
    assert.equal(contents.clicked, 0);
    assert.equal(contents.debugger.detachCalls, 1);
    assertClean(contents);
  });
  await t.test("准备期间路由变化", async () => {
    const contents = new ContentsFixture();
    contents.debugger.beforeEnable = () => { contents.url = createdUrl; };
    await assert.rejects(createNativeJianshuDraft(contents.asContents(), 100), { code: "JIANSHU_CREATE_CHANGED", uncertain: false });
    assert.equal(contents.clicked, 0);
    assertClean(contents);
  });
});

test("native简书外部替换调试器或窗口关闭时结果未知，不拆除后续拥有者", async (t) => {
  await t.test("调试器被替换", async () => {
    const contents = new ContentsFixture();
    contents.onCreate = () => {
      contents.debugger.attached = false;
      contents.debugger.emit("detach", {}, "replaced");
      contents.debugger.attached = true;
    };
    await assert.rejects(createNativeJianshuDraft(contents.asContents(), 100), { code: "JIANSHU_CREATE_UNCERTAIN", uncertain: true });
    assert.equal(contents.debugger.detachCalls, 0);
    assert.equal(contents.debugger.isAttached(), true);
    assertClean(contents);
  });
  await t.test("窗口关闭", async () => {
    const contents = new ContentsFixture();
    contents.onCreate = () => { contents.destroyed = true; contents.emit("destroyed"); };
    await assert.rejects(createNativeJianshuDraft(contents.asContents(), 100), { code: "JIANSHU_CREATE_UNCERTAIN", uncertain: true });
    assert.equal(contents.clicked, 1);
    assertClean(contents);
  });
});

test("native简书同次点击出现重复新建请求或原请求跳转时拒绝猜测", async (t) => {
  await t.test("重复新建请求", async () => {
    const contents = new ContentsFixture();
    contents.onCreate = () => {
      contents.debugger.request("first");
      contents.debugger.request("second");
      contents.debugger.respond("first");
    };
    await assert.rejects(createNativeJianshuDraft(contents.asContents(), 100), { code: "JIANSHU_CREATE_UNCERTAIN", uncertain: true });
    assert.equal(contents.clicked, 1);
    assertClean(contents);
  });
  await t.test("原请求redirect", async () => {
    const contents = new ContentsFixture();
    contents.onCreate = () => {
      contents.debugger.request("first");
      contents.debugger.observe("Network.requestWillBeSent", { requestId: "first", redirectResponse: { status: 302 }, request: { method: "GET", url: "https://www.jianshu.com/sign_in" } });
    };
    await assert.rejects(createNativeJianshuDraft(contents.asContents(), 100), { code: "JIANSHU_CREATE_UNCERTAIN", uncertain: true });
    assertClean(contents);
  });
});
