import test from "node:test";
import assert from "node:assert/strict";
import type { Page, Response } from "playwright-core";
import { createBitJianshuDraft } from "../core/jianshu/browser-create";
import { AppError } from "../core/errors";

const endpoint = "https://www.jianshu.com/author/notes";
const oldNote = "https://www.jianshu.com/writer#/notebooks/10/notes/20";
const newNote = "https://www.jianshu.com/writer#/notebooks/10/notes/30";
const created = () => ({
  id: 30,
  notebook_id: 10,
  shared: false,
  last_compiled_at: 0,
});
type Reply = {
  url?: string;
  requestUrl?: string;
  method?: string;
  postData?: unknown;
  brokenPostData?: boolean;
  otherFrame?: boolean;
  ok?: boolean;
  contentType?: string;
  text?: string;
};

/** Mock only the page transport; readiness, matching, response parsing and errors
 * are the production implementation. No shared browser or network is replaced. */
function fixture(replies: Reply[]) {
  const events: string[] = [];
  const matched: Reply[] = [];
  const frame = {};
  let waiter:
    | {
        predicate: (response: Response) => boolean;
        resolve(response: Response): void;
        reject(error: Error): void;
      }
    | undefined;
  let clicked = 0;
  let route = oldNote;
  let clickError = false;
  let readyChecks = 0;
  let delayedReady = false;
  const page = {
    url: () => route,
    mainFrame: () => frame,
    async evaluate(script: string) {
      const match = script.match(/\)\((\{.*\})\);\s*\}\)\(\)$/s);
      assert.ok(match);
      const input = JSON.parse(match[1]);
      if (input.action === "prepareCreate") {
        events.push("prepare");
        readyChecks++;
        return delayedReady && readyChecks === 1
          ? null
          : { editorUrl: oldNote, notebookId: "10" };
      }
      assert.equal(input.action, "create");
      assert.equal(input.expectedEditorUrl, oldNote);
      assert.equal(input.expectedNotebookId, "10");
      clicked++;
      events.push("click");
      assert.ok(waiter, "必须在点击前监听创建响应");
      if (clickError) {
        waiter.reject(Error("page changed"));
        throw Error("页面已切换，未点击新建");
      }
      // The SPA can restore the old note while creation is in flight. A route
      // observation must not replace the correlated create response.
      route = oldNote;
      let settled = false;
      for (const reply of replies) {
        const response = {
          url: () => reply.url ?? endpoint,
          request: () => ({
            url: () => reply.requestUrl ?? endpoint,
            method: () => reply.method ?? "POST",
            frame: () => (reply.otherFrame ? {} : frame),
            postDataJSON: () => {
              if (reply.brokenPostData) throw Error("not json");
              return reply.postData === undefined
                ? { notebook_id: "10", title: "2026-11-24", at_bottom: false }
                : reply.postData;
            },
          }),
          ok: () => reply.ok ?? true,
          headers: () => ({
            "content-type":
              reply.contentType ?? "application/json; charset=utf-8",
          }),
          text: async () => reply.text ?? JSON.stringify(created()),
        } as unknown as Response;
        if (waiter.predicate(response) && !settled) {
          matched.push(reply);
          settled = true;
          waiter.resolve(response);
        }
      }
      if (!settled) waiter.reject(Error("Timeout waiting for create response"));
      return true;
    },
    waitForResponse(
      predicate: (response: Response) => boolean,
      options: { timeout: number },
    ) {
      events.push("observe");
      assert.equal(options.timeout, 30000);
      return new Promise<Response>((resolve, reject) => {
        waiter = { predicate, resolve, reject };
      });
    },
  } as unknown as Page;
  return {
    page,
    events,
    matched,
    get clicked() {
      return clicked;
    },
    set delayedReady(value: boolean) {
      delayedReady = value;
    },
    set clickError(value: boolean) {
      clickError = value;
    },
  };
}

const uncertain = (error: unknown) =>
  error instanceof AppError &&
  error.code === "JIANSHU_CREATE_UNCERTAIN" &&
  error.uncertain;

test("指纹新建先准备再旁听本页POST，返回创建回执的准确note而非恢复的旧路由", async () => {
  const valid: Reply = {};
  const f = fixture([
    { method: "GET" },
    { postData: { notebook_id: "11" } },
    { otherFrame: true },
    { url: "https://www.jianshu.com/author/notes/20" },
    { requestUrl: "https://www.jianshu.com/author/notes?other=1" },
    { brokenPostData: true },
    valid,
  ]);
  assert.equal(await createBitJianshuDraft(f.page), newNote);
  assert.equal(f.page.url(), oldNote, "即使路由仍是旧稿，也只认创建回执");
  assert.deepEqual(f.events, ["prepare", "observe", "click"]);
  assert.deepEqual(f.matched, [valid]);
  assert.equal(f.clicked, 1);
});

test("初始页面未准备好时只读等待，准备完成前不监听或点击创建", async () => {
  const f = fixture([{}]);
  f.delayedReady = true;
  assert.equal(await createBitJianshuDraft(f.page), newNote);
  assert.deepEqual(f.events, ["prepare", "prepare", "observe", "click"]);
  assert.equal(f.clicked, 1);
});

test("没有本次文集的创建响应时保持结果未知，不因旧note路由存在而重试", async () => {
  const f = fixture([
    { method: "GET" },
    { postData: { notebook_id: "11" } },
    { postData: null },
    { postData: [] },
    { postData: { notebook_id: "10" }, otherFrame: true },
    { url: "https://www.jianshu.com.evil.test/author/notes" },
  ]);
  await assert.rejects(() => createBitJianshuDraft(f.page), uncertain);
  assert.equal(f.clicked, 1, "未知结果不自动再次创建");
  assert.equal(f.page.url(), oldNote);
  assert.deepEqual(f.matched, []);
});

test("错误状态、验证码或损坏JSON回执不认定创建成功，不再次点击", async () => {
  for (const reply of [
    { ok: false },
    { contentType: "text/html", text: "<p>安全验证</p>" },
    { text: "not-json" },
    { text: "x".repeat(512001) },
  ]) {
    const f = fixture([reply]);
    await assert.rejects(() => createBitJianshuDraft(f.page), uncertain);
    assert.equal(f.clicked, 1);
  }
});

test("已发布、其他文集或缺失身份的创建回执不成为草稿关联", async () => {
  for (const note of [
    { ...created(), shared: true },
    { ...created(), notebook_id: 11 },
    { ...created(), id: null },
    { ...created(), last_compiled_at: 123 },
    { ...created(), schedule_publish_at: "2026-11-25" },
    { id: 30, notebook_id: 10 },
    [created()],
  ]) {
    const f = fixture([{ text: JSON.stringify(note) }]);
    await assert.rejects(() => createBitJianshuDraft(f.page), uncertain);
    assert.equal(f.clicked, 1);
  }
});

test("新建前页面变更导致点击失败时捕获等待器错误，仍不再次点击", async () => {
  const f = fixture([]);
  f.clickError = true;
  await assert.rejects(() => createBitJianshuDraft(f.page), uncertain);
  assert.equal(f.clicked, 1);
  assert.deepEqual(f.events, ["prepare", "observe", "click"]);
});
