import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { weiboPublisherPage } from "../desktop/weibo-publisher-page";

/** Minimal production Vue tree: deliberately has no development-only DOM component marker. */
function pageFixture(existingText = "") {
  let publisher: any;
  let clicked = 0;
  class Textarea {
    private text = existingText;
    placeholder = "有什么新鲜事想分享给大家？";
    parentElement: any = null;
    get value() {
      return this.text;
    }
    set value(value: string) {
      this.text = value;
    }
    getBoundingClientRect() {
      return { width: 600 };
    }
    dispatchEvent() {
      publisher.content = this.text;
    }
    querySelectorAll() {
      return [button];
    }
  }
  const textarea = new Textarea();
  const button = {
    textContent: "发送",
    disabled: false,
    getBoundingClientRect: () => ({ width: 50 }),
    click: () => clicked++,
  };
  const visibilityControl = {
    visible: 0,
    visibleChange(_event: unknown, visible: number) {
      this.visible = visible;
      publisher.visible = visible;
    },
  };
  publisher = {
    content: existingText,
    pic_id: [],
    visible: 0,
    toolAction: "",
    media: {},
    vote: {},
    pri: 0,
    formCount: { count: 12, maxcount: 2000 },
    $el: { contains: (node: unknown) => node === textarea },
    $refs: {
      image: { uploading: false, upload_list: [] },
      tools: { $refs: { visible: visibilityControl } },
    },
    $nextTick: async () => {},
    toolbarPublish: () => {},
    pasteImg: () => {
      publisher.pic_id.push({ pid: "mock-picture-id", status: 3 });
    },
  };
  const root = {
    _vnode: {
      component: {
        subTree: { children: [{ component: { proxy: publisher } }] },
      },
    },
  };
  const context = {
    window: { $CONFIG: { uid: "1234567890" } } as any,
    location: { protocol: "https:", hostname: "weibo.com", pathname: "/" },
    document: {
      querySelectorAll: (selector: string) =>
        selector === "textarea"
          ? [textarea]
          : selector === "[data-v-app]"
            ? [root]
            : [],
    },
    HTMLTextAreaElement: Textarea,
    Event: class {},
    File: class {},
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    setTimeout,
    __name: (fn: unknown) => fn,
  };
  const input = {
    action: "fill",
    taskId: "test-task",
    uid: "1234567890",
    text: "测试图文",
    visibility: "self",
    aiAssisted: false,
    hashes: ["mock-hash"],
    images: [
      {
        name: "01.png",
        mime: "image/png",
        base64: "aGVsbG8=",
        sha256: "mock-hash",
      },
    ],
  };
  const action = (patch: Record<string, unknown> = {}) =>
    runInNewContext(
      `(${weiboPublisherPage.toString()})(${JSON.stringify({ ...input, ...patch })})`,
      context,
    ) as Promise<any>;
  return {
    action,
    publisher,
    visibilityControl,
    textarea,
    context,
    get clicked() {
      return clicked;
    },
  };
}

test("微博生产页面定位发布器、上传图文，并同步实际可见范围控件", async () => {
  const f = pageFixture();
  const filled = await f.action();
  assert.equal(filled.imageCount, 1);
  assert.equal(f.publisher.content, "测试图文");
  assert.equal(f.textarea.value, "测试图文");
  assert.equal(f.publisher.visible, 1);
  assert.equal(f.visibilityControl.visible, 1);
  await f.action({ action: "submit" });
  assert.equal(f.clicked, 1);
});

test("微博手工草稿不会被覆盖，手工改动文案和可见范围后不能自动提交", async () => {
  const existing = pageFixture("用户未保存的网页草稿");
  await assert.rejects(existing.action(), /已有内容/);
  assert.equal(existing.publisher.content, "用户未保存的网页草稿");
  const changed = pageFixture();
  await changed.action();
  changed.textarea.value = "网页手工修改";
  changed.publisher.content = "网页手工修改";
  await assert.rejects(changed.action({ action: "submit" }), /内容已变化/);
  assert.equal(changed.clicked, 0);
  const visibility = pageFixture();
  await visibility.action();
  visibility.visibilityControl.visible = 0;
  await assert.rejects(
    visibility.action({ action: "submit" }),
    /控件与提交设置不一致/,
  );
  assert.equal(visibility.clicked, 0);
});

test("微博网页身份不一致或无发布器时，既不填写也不点击", async () => {
  const f = pageFixture();
  await assert.rejects(f.action({ uid: "9999999999" }), /账号与任务不一致/);
  assert.equal(f.publisher.content, "");
  f.context.document.querySelectorAll = () => [];
  await assert.rejects(f.action(), /未找到微博首页/);
  assert.equal(f.clicked, 0);
});
