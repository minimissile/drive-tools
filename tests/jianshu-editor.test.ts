import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  fillJianshuEditor,
  jianshuEditorScript,
  jianshuNotebookId,
  jianshuCreatedDraftUrl,
  prepareJianshuDraftCreation,
  type JianshuEditorDriver,
} from "../core/jianshu/editor";
import type { JianshuFillCheckpoint, JianshuPayload } from "../shared/jianshu";

const noteUrl =
  "https://www.jianshu.com/writer#/notebooks/57443510/notes/146614893";
const remoteImage =
  "https://upload-images.jianshu.io/upload_images/12345-panxu.png";
const plain = "资料使用指南：先看目录，再按计划完成阅读与练习。";
const normalize = (value: string) =>
  value.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/g, "");
const hash = (value: string) =>
  createHash("sha256").update(normalize(value)).digest("hex");
const image = {
  sha256: "a".repeat(64),
  file: "a".repeat(64) + ".png",
  storage: "content-assets" as const,
  name: "封面",
};
const payload = (): JianshuPayload => ({
  id: "jianshu_editor_test",
  title: "资料使用指南",
  text: plain,
  html: `<p>${plain}</p>`,
  images: [],
  aiAssisted: false,
  resourceUrl: null,
  sourceUrls: [],
});
type Observation = {
  url: string;
  ready: boolean;
  canCreate: boolean;
  unpublished: boolean;
  title: string;
  text: string;
  expectedText: string;
  images: { url: string; name: string; loaded: boolean }[];
  saved: boolean;
  uploadOpen: boolean;
};
type Command = {
  action: string;
  title?: string;
  html?: string;
  name?: string;
  expectedText?: string;
  expectedRemoteImages?: string[];
};

/** Mock only the website transport, retaining the real engine's sequencing and recovery. */
function editorDriver(
  article: JianshuPayload,
  checkpoint?: JianshuFillCheckpoint,
) {
  const state = {
    commands: [] as Command[],
    events: [] as string[],
    lostUpload: false,
    ambiguousUpload: false,
    ignoreSave: false,
    server: {
      title: checkpoint ? article.title : "2026-11-24",
      text: checkpoint ? normalize(article.text) : "",
      images: [] as string[],
    },
    observation: {
      url:
        checkpoint?.editorUrl ??
        "https://www.jianshu.com/writer#/notebooks/57443510",
      ready: true,
      canCreate: true,
      unpublished: true,
      title: checkpoint ? article.title : "2026-11-24",
      text: checkpoint ? normalize(article.text) : "",
      expectedText: normalize(article.text),
      images: [] as Observation["images"],
      saved: true,
      uploadOpen: false,
    } as Observation,
  };
  const driver: JianshuEditorDriver = {
    url: () => state.observation.url,
    async createDraft() {
      await driver.evaluate(
        jianshuEditorScript({
          action: "create",
          expectedEditorUrl: driver.url(),
        }),
      );
      return noteUrl;
    },
    async evaluate<T>(script: string): Promise<T> {
      const match = script.match(/\)\((\{.*\})\);\s*\}\)\(\)$/s);
      assert.ok(match, "website transport command must have a JSON argument");
      const input = JSON.parse(match[1]) as Command;
      state.commands.push(input);
      if (input.action === "read")
        return structuredClone(state.observation) as T;
      state.events.push(input.action);
      if (input.action === "create") {
        state.observation.url = noteUrl;
      } else if (input.action === "verify") {
        return (normalize(state.server.title) ===
          normalize(input.title ?? "") &&
          state.server.text === input.expectedText &&
          JSON.stringify(state.server.images) ===
            JSON.stringify(input.expectedRemoteImages ?? [])) as T;
      } else if (input.action === "write") {
        state.observation.title = input.title!;
        state.observation.text = normalize(article.text);
        state.observation.saved = false;
      } else if (input.action === "image") {
        state.observation.uploadOpen = true;
      } else if (input.action === "upload") {
        if (state.lostUpload) throw Error("图片请求已提交，上传结果未知");
        state.observation.images.push({
          url: remoteImage,
          name: input.name!,
          loaded: true,
        });
        if (state.ambiguousUpload)
          state.observation.images.push({
            url: "https://upload-images.jianshu.io/upload_images/unrelated.png",
            name: "",
            loaded: true,
          });
        state.observation.uploadOpen = false;
      } else if (input.action === "save") {
        state.observation.saved = true;
        if (!state.ignoreSave) {
          state.server.title = state.observation.title;
          state.server.text = state.observation.text;
          state.server.images = state.observation.images.map(
            (item) => item.url,
          );
        }
      } else throw Error(`Unexpected editor command: ${input.action}`);
      return true as T;
    },
  };
  return { driver, state };
}

test("创建具体草稿后必须先持久化检查点，再填写正文与图片", async () => {
  const article = payload();
  article.images = [image];
  const f = editorDriver(article);
  const checkpoints: JianshuFillCheckpoint[] = [];
  const result = await fillJianshuEditor(
    f.driver,
    article,
    async (checkpoint) => {
      f.state.events.push("checkpoint");
      checkpoints.push(structuredClone(checkpoint));
      if (checkpoints.length === 1) {
        assert.equal(checkpoint.editorUrl, noteUrl);
        assert.ok(!f.state.events.includes("write"));
        assert.ok(!f.state.events.includes("upload"));
      }
    },
    async () => Buffer.from("local image"),
  );
  assert.equal(result.filled, true);
  assert.deepEqual(f.state.events.slice(0, 4), [
    "create",
    "checkpoint",
    "verify",
    "write",
  ]);
  assert.equal(checkpoints.at(-1)?.filled, true);
  assert.equal(checkpoints.at(-1)?.uploadedImageRefs?.[0].sha256, image.sha256);
  assert.equal(checkpoints.at(-1)?.uploadedImages, 1);
  assert.ok(
    !f.state.commands.some((command) =>
      /publish|publicize/.test(command.action),
    ),
  );
});

test("初始化先恢复旧稿也不能冒充本次创建回执，先记录精确新稿再等其加载", async () => {
  const article = payload();
  article.images = [image];
  const f = editorDriver(article);
  const oldUrl = "https://www.jianshu.com/writer#/notebooks/57443510/notes/99";
  const evaluate = f.driver.evaluate.bind(f.driver);
  let clicked = false,
    restoredReads = 0;
  f.driver.evaluate = async <T>(script: string): Promise<T> => {
    const action = JSON.parse(
      script.match(/\)\((\{.*\})\);\s*\}\)\(\)$/s)![1],
    ).action;
    if (action === "create") {
      clicked = true;
      f.state.events.push("create");
      Object.assign(f.state.observation, {
        url: oldUrl,
        title: "官网原稿",
        text: "用户旧稿内容",
        images: [
          {
            url: "https://upload-images.jianshu.io/upload_images/old.png",
            name: "旧图",
            loaded: true,
          },
        ],
      });
      return true as T;
    }
    if (action === "read" && clicked && ++restoredReads === 3)
      Object.assign(f.state.observation, {
        url: noteUrl,
        title: "2026-11-24",
        text: "",
        images: [],
      });
    else if (action === "read" && clicked && restoredReads === 2)
      f.state.observation.url = noteUrl; // SPA route changed while the old editor is still visible.
    if (["write", "image", "upload", "save", "verify"].includes(action))
      assert.equal(
        f.state.observation.url,
        noteUrl,
        "任何填写或核验都不能落在自动恢复的旧稿",
      );
    return evaluate<T>(script);
  };
  const checkpoints: JianshuFillCheckpoint[] = [];
  const result = await fillJianshuEditor(
    f.driver,
    article,
    async (value) => {
      checkpoints.push(structuredClone(value));
      if (checkpoints.length === 1) {
        assert.equal(
          value.editorUrl,
          noteUrl,
          "创建响应确定的地址优先于当前仍显示的旧路由",
        );
        assert.equal(f.state.observation.url, oldUrl);
        assert.ok(!f.state.events.includes("write"));
      }
    },
    async () => Buffer.from("image"),
  );
  assert.equal(result.editorUrl, noteUrl);
  assert.equal(result.filled, true);
  assert.equal(f.state.events.filter((event) => event === "create").length, 1);
  assert.ok(restoredReads >= 3);
});

test("没有可靠创建能力时不点击官网按钮，也不根据旧路由建立检查点", async () => {
  const f = editorDriver(payload());
  f.driver.createDraft = undefined;
  let checkpoints = 0;
  await assert.rejects(
    fillJianshuEditor(f.driver, payload(), async () => {
      checkpoints++;
    }),
    /可靠识别新建草稿/,
  );
  assert.equal(checkpoints, 0);
  assert.deepEqual(f.state.events, []);
});

test("创建回执未知或不可信时只尝试一次，不猜路由、不写入、不上传", async () => {
  for (const receipt of [
    null,
    "https://evil.test/writer#/notebooks/1/notes/2",
    "https://www.jianshu.com/writer#/notebooks/57443510",
  ]) {
    const article = payload();
    const f = editorDriver(article);
    let attempts = 0,
      checkpoints = 0;
    f.driver.createDraft = async () => {
      attempts++;
      f.state.observation.url = noteUrl;
      return receipt as unknown as string;
    };
    await assert.rejects(
      fillJianshuEditor(f.driver, article, async () => {
        checkpoints++;
      }),
      /回执尚未确认/,
    );
    assert.equal(attempts, 1);
    assert.equal(checkpoints, 0);
    assert.deepEqual(f.state.events, []);
  }
});

test("创建回执只接受本次文集的完整未发布笔记，拒绝缺字段、跨文集和曾发布数据", () => {
  const value = {
    id: 146614893,
    notebook_id: 57443510,
    shared: false,
    last_compiled_at: 0,
  };
  assert.equal(jianshuCreatedDraftUrl(value, "57443510"), noteUrl);
  assert.equal(
    jianshuCreatedDraftUrl(
      {
        ...value,
        id: "146614893",
        notebook_id: "57443510",
        schedule_publish_at: null,
      },
      "57443510",
    ),
    noteUrl,
  );
  for (const invalid of [
    null,
    [],
    { id: 146614893, notebook_id: 57443510 },
    { ...value, shared: true },
    { ...value, notebook_id: 1 },
    { ...value, last_compiled_at: 1 },
    { ...value, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...value, id: "../2" },
    { ...value, schedule_publish_at: "2026-12-01" },
  ])
    assert.equal(jianshuCreatedDraftUrl(invalid, "57443510"), null);
  assert.equal(jianshuNotebookId(noteUrl), "57443510");
  assert.equal(
    jianshuNotebookId("https://www.jianshu.com/writer#/notebooks/57443510"),
    "57443510",
  );
  for (const url of [
    "https://www.jianshu.com/writer#/",
    "https://evil.test/writer#/notebooks/1",
    "http://www.jianshu.com/writer#/notebooks/1",
    "https://www.jianshu.com/writer?x=1#/notebooks/1",
  ])
    assert.equal(jianshuNotebookId(url), null);
});

test("新建前快照只接受已加载原稿或服务端明确空文集，路由恢复期间只读等待", async () => {
  const notebookUrl = "https://www.jianshu.com/writer#/notebooks/57443510";
  const variants = [
    {
      url: noteUrl,
      ready: true,
      notes: [{ id: 146614893, notebook_id: 57443510 }],
      ok: true,
    },
    {
      url: notebookUrl,
      ready: false,
      notes: [{ id: 146614893, notebook_id: 57443510 }],
      ok: false,
    },
    { url: notebookUrl, ready: false, notes: [], ok: true },
    {
      url: noteUrl,
      ready: false,
      notes: [{ id: 146614893, notebook_id: 57443510 }],
      ok: false,
    },
    {
      url: noteUrl,
      ready: true,
      notes: [{ id: 99, notebook_id: 57443510 }],
      ok: false,
    },
    {
      url: noteUrl,
      ready: true,
      notes: [{ id: 146614893, notebook_id: 57443510 }],
      routeChange: true,
      ok: false,
    },
  ];
  for (const variant of variants) {
    const parsed = new URL(variant.url);
    const location = {
      origin: parsed.origin,
      pathname: parsed.pathname,
      href: parsed.href,
      hash: parsed.hash,
    };
    let clicks = 0,
      requests = 0;
    const document = {
      querySelectorAll: () => [],
      querySelector(selector: string) {
        if (selector === "div._1GsW5")
          return {
            textContent: " 新建文章",
            getClientRects: () => [{}],
            click() {
              clicks++;
            },
          };
        if (selector === "input._24i7u")
          return variant.ready ? { value: "原稿" } : null;
        if (selector.startsWith("#editor "))
          return variant.ready ? { getClientRects: () => [{}] } : null;
        if (selector.includes('data-action="publicize"'))
          return variant.ready ? { textContent: "发布文章" } : null;
        return null;
      },
    };
    const result = await runInNewContext(
      jianshuEditorScript({ action: "prepareCreate" }),
      {
        location,
        document,
        URL,
        AbortSignal,
        async fetch(
          url: string,
          options: {
            credentials: string;
            cache: string;
            redirect: string;
            method?: string;
            body?: unknown;
          },
        ) {
          requests++;
          assert.equal(options.method, undefined);
          assert.equal(options.body, undefined);
          assert.equal(options.cache, "no-store");
          assert.equal(options.credentials, "same-origin");
          assert.equal(options.redirect, "error");
          assert.match(
            url,
            /^https:\/\/www\.jianshu\.com\/author\/notebooks\/57443510\/notes\?/,
          );
          if (variant.routeChange) location.href = notebookUrl;
          return {
            ok: true,
            url,
            headers: { get: () => "application/json" },
            json: async () => variant.notes,
          };
        },
      },
    );
    assert.equal(!!result, variant.ok, JSON.stringify(variant));
    if (result) {
      assert.equal(result.notebookId, "57443510");
      assert.equal(result.editorUrl, variant.url);
    }
    assert.equal(clicks, 0, "准备动作不能触发新建");
    assert.equal(requests, 1);
  }
});

test("快照准备在旧路由自动恢复期间可重读，未取得同一瞬间的快照前不能点击", async () => {
  let reads = 0;
  const value = await prepareJianshuDraftCreation({
    url: () => noteUrl,
    async evaluate<T>() {
      reads++;
      return (
        reads === 1 ? null : { editorUrl: noteUrl, notebookId: "57443510" }
      ) as T;
    },
  });
  assert.equal(reads, 2);
  assert.deepEqual(value, { editorUrl: noteUrl, notebookId: "57443510" });
});

test("新路由仍显示旧编辑器的加载遮罩时不能视为ready", () => {
  for (const shown of [true, false]) {
    const body = htmlNode("<p>原稿正文</p>");
    const document = {
      createElement: () => htmlNode(""),
      querySelectorAll: (selector: string) =>
        selector === ".ZKQHD"
          ? [
              {
                textContent: "内容加载中",
                getClientRects: () => (shown ? [{}] : []),
              },
            ]
          : [],
      querySelector(selector: string) {
        if (selector === "input._24i7u") return { value: "原稿标题" };
        if (selector.startsWith("#editor ")) return body;
        if (selector.includes('data-action="publicize"'))
          return { textContent: "发布文章" };
        if (selector === "div._1GsW5") return { getClientRects: () => [{}] };
        return null;
      },
    };
    const value = runInNewContext(
      jianshuEditorScript({ action: "read", html: payload().html }),
      {
        document,
        location: {
          origin: "https://www.jianshu.com",
          pathname: "/writer",
          href: noteUrl,
          hash: "#/notebooks/57443510/notes/146614893",
        },
      },
    );
    assert.equal(value.ready, !shown);
  }
});

test("新建按钮点击前原子检查文集和页面地址，不跟随正在变化的官网路由", () => {
  let clicks = 0;
  const document = {
    querySelector(selector: string) {
      return selector === "div._1GsW5"
        ? {
            textContent: "新建文章",
            getClientRects: () => [{}],
            click() {
              clicks++;
            },
          }
        : null;
    },
  };
  for (const input of [
    {
      action: "create" as const,
      expectedEditorUrl: "https://www.jianshu.com/writer#/notebooks/1",
      expectedNotebookId: "1",
    },
    {
      action: "create" as const,
      expectedEditorUrl: noteUrl,
      expectedNotebookId: "1",
    },
  ])
    assert.throws(
      () =>
        runInNewContext(jianshuEditorScript(input), {
          document,
          location: {
            origin: "https://www.jianshu.com",
            pathname: "/writer",
            href: noteUrl,
            hash: "#/notebooks/57443510/notes/146614893",
          },
        }),
      /已切换/,
    );
  assert.equal(clicks, 0);
});

test("检查点保存失败时停止，不向未关联草稿写入内容", async () => {
  const article = payload();
  const f = editorDriver(article);
  await assert.rejects(
    fillJianshuEditor(f.driver, article, async () => {
      throw Error("检查点未保存");
    }),
    /检查点未保存/,
  );
  assert.deepEqual(f.state.events, ["create"]);
});

test("已上传配图的同稿重试只读核对，不再创建、写入、上传或保存", async () => {
  const article = payload();
  article.images = [image];
  const checkpoint: JianshuFillCheckpoint = {
    editorUrl: noteUrl,
    filled: false,
    titleHash: hash(article.title),
    textHash: hash(plain),
    uploadedImages: 1,
    totalImages: 1,
    uploadedImageRefs: [{ sha256: image.sha256, url: remoteImage }],
  };
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: checkpoint });
  const f = editorDriver(article, checkpoint);
  f.state.observation.images = [
    { url: remoteImage, name: "封面", loaded: true },
  ];
  f.state.server.images = [remoteImage];
  const result = await fillJianshuEditor(
    f.driver,
    article,
    undefined,
    async () => Buffer.from("local image"),
  );
  assert.equal(result.filled, true);
  assert.deepEqual(f.state.events, ["verify", "verify"]);
});

test("官网UI保存失败但后台全文与图片完整一致时可完成，不重复提交保存", async () => {
  const article = payload();
  article.images = [image];
  const checkpoint: JianshuFillCheckpoint = {
    editorUrl: noteUrl,
    filled: true,
    titleHash: hash(article.title),
    textHash: hash(plain),
    uploadedImages: 1,
    totalImages: 1,
    uploadedImageRefs: [{ sha256: image.sha256, url: remoteImage }],
  };
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: checkpoint });
  const f = editorDriver(article, checkpoint);
  f.state.observation.saved = false;
  f.state.observation.images = [{ url: remoteImage, name: "", loaded: true }];
  f.state.server.images = [remoteImage];
  let latest: JianshuFillCheckpoint | undefined;
  const result = await fillJianshuEditor(
    f.driver,
    article,
    async (value) => {
      latest = value;
    },
    async () => Buffer.from("local image"),
  );
  assert.equal(result.filled, true);
  assert.equal(latest?.filled, true);
  assert.deepEqual(f.state.events, ["verify", "verify"]);
  assert.equal(
    f.state.observation.saved,
    false,
    "完成依据是后台保存内容，不能反复触发PUT等待过时UI状态",
  );
});

test("官网手动改过正文时拒绝自动覆盖，连图片上传和保存也不触发", async () => {
  const article = payload();
  const checkpoint = {
    editorUrl: noteUrl,
    titleHash: hash(article.title),
    textHash: hash(plain),
  };
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: checkpoint });
  const f = editorDriver(article, checkpoint);
  f.state.observation.text = normalize(plain + "官网补充的重要说明");
  await assert.rejects(fillJianshuEditor(f.driver, article), /手动修改/);
  assert.deepEqual(f.state.events, []);
});

test("官网手动清空曾保存的正文，也不能被自动填回旧稿", async () => {
  const article = payload();
  const checkpoint = {
    editorUrl: noteUrl,
    filled: true,
    titleHash: hash(article.title),
    textHash: hash(plain),
  };
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: checkpoint });
  const f = editorDriver(article, checkpoint);
  f.state.observation.text = "";
  await assert.rejects(fillJianshuEditor(f.driver, article), /手动修改/);
  assert.deepEqual(f.state.events, []);
});

test("上传插入成功但检查点中断后，精确文件名可恢复原图片而不再上传", async () => {
  const article = payload();
  article.images = [image];
  const checkpoint: JianshuFillCheckpoint = {
    editorUrl: noteUrl,
    titleHash: hash(article.title),
    textHash: hash(plain),
    pendingImageSha256: image.sha256,
  };
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: checkpoint });
  const f = editorDriver(article, checkpoint);
  f.state.observation.images = [
    { url: remoteImage, name: `panxu-${image.sha256}.png`, loaded: true },
  ];
  f.state.server.images = [remoteImage];
  let latest: JianshuFillCheckpoint | undefined;
  await fillJianshuEditor(
    f.driver,
    article,
    async (value) => {
      latest = value;
    },
    async () => Buffer.from("local image"),
  );
  assert.deepEqual(f.state.events, ["verify", "verify"]);
  assert.equal(latest?.pendingImageSha256, null);
  assert.equal(latest?.uploadedImageRefs?.[0].url, remoteImage);
});

test("官网脚本对每次变更原子校验具体草稿及刚观察的正文，避免导航空档误写", () => {
  const body = {
    cloneNode: () => ({ querySelectorAll: () => [], textContent: plain }),
  };
  const location = {
    origin: "https://www.jianshu.com",
    pathname: "/writer",
    href: noteUrl.replace("146614893", "146614894"),
  };
  const actualTitle = { value: "当前官网标题" };
  const document = {
    querySelector(selector: string) {
      if (selector === "input._24i7u") return actualTitle;
      if (selector.startsWith("#editor ")) return body;
      if (selector.includes('data-action="publicize"'))
        return { textContent: "发布文章" };
      throw Error("原子安全校验前不应进入实际变更");
    },
  };
  for (const action of ["write", "image", "upload", "save"] as const) {
    const script = jianshuEditorScript({
      action,
      expectedEditorUrl: noteUrl,
      expectedTitle: actualTitle.value,
      expectedText: normalize(plain),
      title: "新标题",
      html: "<p>新正文</p>",
    });
    assert.throws(
      () => runInNewContext(script, { location, document }),
      /切换文章/,
    );
    location.href = noteUrl;
    const stale = jianshuEditorScript({
      action,
      expectedEditorUrl: noteUrl,
      expectedTitle: "此前标题",
      expectedText: normalize(plain),
      title: "新标题",
      html: "<p>新正文</p>",
    });
    assert.throws(
      () => runInNewContext(stale, { location, document }),
      /填写期间有修改/,
    );
    location.href = noteUrl.replace("146614893", "146614894");
  }
});

test("上传结果未知时保留原稿且再次继续不会盲目重传同图", async () => {
  const article = payload();
  article.images = [image];
  const f = editorDriver(article);
  let checkpoint: JianshuFillCheckpoint | undefined;
  f.state.lostUpload = true;
  const persist = async (value: JianshuFillCheckpoint) => {
    checkpoint = structuredClone(value);
  };
  await assert.rejects(
    fillJianshuEditor(f.driver, article, persist, async () =>
      Buffer.from("local image"),
    ),
    /上传结果未知/,
  );
  assert.equal(checkpoint?.editorUrl, noteUrl);
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: checkpoint });
  f.state.lostUpload = false;
  await assert.rejects(
    fillJianshuEditor(f.driver, article, persist, async () =>
      Buffer.from("local image"),
    ),
    /上传|检查|确认/,
  );
  assert.equal(f.state.events.filter((event) => event === "create").length, 1);
  assert.equal(
    f.state.events.filter((event) => event === "upload").length,
    1,
    "首次上传仍可能完成，未知结果不能再次提交",
  );
});

test("官网更换已登记图片的src但保留文件名时，应识别为手动修改", async () => {
  const article = payload();
  article.images = [image];
  const checkpoint: JianshuFillCheckpoint = {
    editorUrl: noteUrl,
    titleHash: hash(article.title),
    textHash: hash(plain),
    uploadedImages: 1,
    totalImages: 1,
    uploadedImageRefs: [{ sha256: image.sha256, url: remoteImage }],
  };
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: checkpoint });
  const f = editorDriver(article, checkpoint);
  f.state.observation.images = [
    {
      url: "https://upload-images.jianshu.io/upload_images/manual-replacement.png",
      name: `panxu-${image.sha256}.png`,
      loaded: true,
    },
  ];
  await assert.rejects(
    fillJianshuEditor(f.driver, article, undefined, async () =>
      Buffer.from("local image"),
    ),
    /图片|手动|修改/,
  );
  assert.deepEqual(f.state.events, []);
});

test("成功保存后官网手动删除已登记图片，不会静默重新上传", async () => {
  const article = payload();
  article.images = [image];
  const checkpoint: JianshuFillCheckpoint = {
    editorUrl: noteUrl,
    filled: true,
    titleHash: hash(article.title),
    textHash: hash(plain),
    uploadedImages: 1,
    totalImages: 1,
    uploadedImageRefs: [{ sha256: image.sha256, url: remoteImage }],
  };
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: checkpoint });
  const f = editorDriver(article, checkpoint);
  await assert.rejects(
    fillJianshuEditor(f.driver, article, undefined, async () =>
      Buffer.from("local image"),
    ),
    /图片|手动|修改/,
  );
  assert.deepEqual(f.state.events, []);
});

test("一次上传出现多张新图片时保留待确认状态，不误认图片或记录填写成功", async () => {
  const article = payload();
  article.images = [image];
  const f = editorDriver(article);
  f.state.ambiguousUpload = true;
  let latest: JianshuFillCheckpoint | undefined;
  await assert.rejects(
    fillJianshuEditor(
      f.driver,
      article,
      async (value) => {
        latest = structuredClone(value);
      },
      async () => Buffer.from("local image"),
    ),
    /图片|上传|核对|确认/,
  );
  assert.equal(latest?.filled, false);
  assert.equal(latest?.pendingImageSha256, image.sha256);
  assert.ok(!f.state.events.includes("save"));
});

test("图片在观察与变更之间被官网插入时，原子guard先阻止正文覆盖与后续上传", () => {
  const image = {
    src: remoteImage,
    currentSrc: remoteImage,
    complete: true,
    naturalWidth: 1,
    getAttribute: () => null,
  };
  const body = {
    cloneNode: () => ({ querySelectorAll: () => [], textContent: plain }),
    querySelectorAll: () => [image],
  };
  const location = {
    origin: "https://www.jianshu.com",
    pathname: "/writer",
    href: noteUrl,
  };
  const document = {
    querySelector(selector: string) {
      if (selector === "input._24i7u") return { value: "标题" };
      if (selector.startsWith("#editor ")) return body;
      if (selector.includes('data-action="publicize"'))
        return { textContent: "发布文章" };
      throw Error("原子图片校验前不应进入实际变更");
    },
  };
  for (const action of ["write", "image", "upload", "save"] as const) {
    const script = jianshuEditorScript({
      action,
      expectedEditorUrl: noteUrl,
      expectedTitle: "标题",
      expectedText: normalize(plain),
      expectedImages: [],
      title: "新标题",
      html: "<p>新正文</p>",
    });
    assert.throws(
      () => runInNewContext(script, { location, document }),
      /填写期间有修改/,
    );
  }
});

test("后台稿件与页面不一致时，预写核验失败，不触发写入或记录完成", async () => {
  const article = payload();
  const checkpoint = {
    editorUrl: noteUrl,
    titleHash: hash(article.title),
    textHash: hash(plain),
  };
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: checkpoint });
  const f = editorDriver(article, checkpoint);
  f.state.server.title = "后台仍是另一份标题";
  const checkpoints: JianshuFillCheckpoint[] = [];
  await assert.rejects(
    fillJianshuEditor(f.driver, article, async (value) => {
      checkpoints.push(value);
    }),
    { code: "JIANSHU_DRAFT_UNSAVED" },
  );
  assert.deepEqual(f.state.events, ["verify", "verify"]);
  assert.equal(checkpoints.length, 0);
});

test("页面保存但后台仍是旧正文时不记完成，保留原hash以便刷新后继续同稿", async () => {
  const article = payload();
  article.text = plain + "补充校准后的学习建议。";
  article.html = `<p>${article.text}</p>`;
  const baseline: JianshuFillCheckpoint = {
    editorUrl: noteUrl,
    titleHash: hash(article.title),
    textHash: hash(plain),
    uploadedImages: 0,
    totalImages: 0,
    filled: false,
  };
  Object.assign(article, { editorUrl: noteUrl, fillCheckpoint: baseline });
  const f = editorDriver(article, baseline);
  f.state.observation.text = normalize(plain);
  f.state.server.text = normalize(plain);
  f.state.ignoreSave = true;
  const checkpoints: JianshuFillCheckpoint[] = [];
  const persist = async (value: JianshuFillCheckpoint) => {
    checkpoints.push(structuredClone(value));
  };
  await assert.rejects(
    fillJianshuEditor(f.driver, article, persist),
    /保存结果尚未核实/,
  );
  assert.equal(f.state.observation.saved, true, "页面显示保存不能代替后台核验");
  assert.ok(checkpoints.length > 0);
  assert.ok(
    checkpoints.every(
      (value) => !value.filled && value.textHash === baseline.textHash,
    ),
  );
  assert.equal(f.state.server.text, normalize(plain));

  Object.assign(article, { fillCheckpoint: checkpoints.at(-1) });
  f.state.observation.text = f.state.server.text; // Reload reads the still-persisted old content.
  f.state.ignoreSave = false;
  const completed = await fillJianshuEditor(f.driver, article, persist);
  assert.equal(completed.filled, true);
  assert.equal(checkpoints.at(-1)?.textHash, hash(article.text));
  assert.equal(checkpoints.at(-1)?.filled, true);
  assert.equal(f.state.server.text, normalize(article.text));
  assert.equal(f.state.events.filter((event) => event === "create").length, 0);
});

/** A tiny DOM for the observed plain paragraphs/images, not a replacement browser. */
function htmlNode(initial: string) {
  let html = initial;
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    get textContent() {
      return html.replace(/<[^>]*>/g, "");
    },
    cloneNode() {
      return htmlNode(html);
    },
    querySelectorAll(selector: string) {
      if (selector === "a[href]")
        return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/g)].map(
          (match) => ({
            src: "",
            currentSrc: "",
            complete: false,
            naturalWidth: 0,
            getAttribute(name: string) {
              return name === "href" ? match[1] : null;
            },
          }),
        );
      if (selector !== "img") return [];
      return [...html.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/g)].map(
        (match) => ({
          src: match[1],
          currentSrc: match[1],
          complete: true,
          naturalWidth: 1,
          getAttribute(name: string) {
            return name === "data-original-src" ? match[1] : null;
          },
        }),
      );
    },
    getClientRects: () => [{}],
  };
}

test("官网verify只读核实后台全文与配图，并拒绝标题错、少图、已发布和定时稿", async () => {
  const article = payload();
  const currentHtml = `${article.html}<p><img src="${remoteImage}"></p>`;
  const makeNote = () => ({
    id: 146614893,
    title: article.title,
    shared: false,
    schedule_publish_at: null as string | null,
    last_compiled_at: 0,
  });
  const variants = [
    { name: "正确未发布草稿", html: currentHtml, note: makeNote(), ok: true },
    {
      name: "标题不符",
      html: currentHtml,
      note: { ...makeNote(), title: "其他标题" },
      ok: false,
    },
    {
      name: "正文不完整",
      html: `<p>只有开头</p><img src="${remoteImage}">`,
      note: makeNote(),
      ok: false,
    },
    { name: "缺少配图", html: article.html, note: makeNote(), ok: false },
    {
      name: "已公开发布",
      html: currentHtml,
      note: { ...makeNote(), shared: true },
      ok: false,
    },
    {
      name: "已定时发布",
      html: currentHtml,
      note: { ...makeNote(), schedule_publish_at: "2026-11-25" },
      ok: false,
    },
    {
      name: "曾经发布后转为私密",
      html: currentHtml,
      note: { ...makeNote(), last_compiled_at: 1795461000 },
      ok: false,
    },
    {
      name: "不是对应note",
      html: currentHtml,
      note: { ...makeNote(), id: 146614894 },
      ok: false,
    },
  ];
  for (const variant of variants) {
    const body = htmlNode(currentHtml);
    const paths: string[] = [];
    const document = {
      querySelector(selector: string) {
        if (selector === "input._24i7u") return { value: article.title };
        if (selector.startsWith("#editor ")) return body;
        if (selector.includes('data-action="publicize"'))
          return { textContent: "发布文章" };
        throw Error("核验不应触发保存或发布按钮");
      },
      createElement() {
        return htmlNode("");
      },
    };
    const script = jianshuEditorScript({
      action: "verify",
      title: article.title,
      expectedEditorUrl: noteUrl,
      expectedTitle: article.title,
      expectedText: normalize(plain),
      expectedImages: [{ url: remoteImage, name: "" }],
      expectedRemoteImages: [remoteImage],
    });
    const result = await runInNewContext(script, {
      document,
      URL,
      AbortSignal,
      location: {
        origin: "https://www.jianshu.com",
        pathname: "/writer",
        href: noteUrl,
        hash: "#/notebooks/57443510/notes/146614893",
      },
      async fetch(
        path: string,
        options: { method?: string; body?: unknown; credentials?: string },
      ) {
        paths.push(path);
        assert.ok(options.method === undefined || options.method === "GET");
        assert.equal(options.body, undefined);
        assert.equal(options.credentials, "same-origin");
        if (path === "/author/notes/146614893/content")
          return { ok: true, json: async () => ({ content: variant.html }) };
        assert.equal(
          path,
          "/author/notebooks/57443510/notes?page=1&count=10&nid=146614893",
        );
        return { ok: true, json: async () => [variant.note] };
      },
    });
    assert.equal(result, variant.ok, variant.name);
    assert.equal(paths.length, 2);
  }
});

test("资料入口核验比较真实href，拒绝同名假链接和漏链接，接受简书官方转跳", async () => {
  const article = payload();
  const target = "https://pan.baidu.com/s/1ownshare?pwd=a1b2";
  const link = (href: string) => `<p><a href="${href}">获取资料</a></p>`;
  const desired = article.html + link(target);
  const variants = [
    { name: "原始资料入口", html: desired, ok: true },
    {
      name: "可见文字相同但href错误",
      html: article.html + link("https://example.com/incorrect"),
      ok: false,
    },
    {
      name: "可见文字还在但链接丢失",
      html: article.html + "<p>获取资料</p>",
      ok: false,
    },
    {
      name: "简书官方跳转保留原目标",
      html:
        article.html +
        link(`https://links.jianshu.com/go?to=${encodeURIComponent(target)}`),
      ok: true,
    },
    {
      name: "仿冒官方跳转域名",
      html:
        article.html +
        link(
          `https://links.jianshu.com.evil.example/go?to=${encodeURIComponent(target)}`,
        ),
      ok: false,
    },
  ];
  for (const variant of variants) {
    const body = htmlNode(desired);
    const document = {
      querySelector(selector: string) {
        if (selector === "input._24i7u") return { value: article.title };
        if (selector.startsWith("#editor ")) return body;
        if (selector.includes('data-action="publicize"'))
          return { textContent: "发布文章" };
        throw Error("资料入口核验不能提交文章");
      },
      createElement() {
        return htmlNode("");
      },
    };
    const script = jianshuEditorScript({
      action: "verify",
      title: article.title,
      html: desired,
      expectedEditorUrl: noteUrl,
      expectedTitle: article.title,
      expectedText: normalize(plain + "获取资料"),
      expectedImages: [],
      expectedRemoteImages: [],
    });
    const result = await runInNewContext(script, {
      document,
      URL,
      AbortSignal,
      location: {
        origin: "https://www.jianshu.com",
        pathname: "/writer",
        href: noteUrl,
        hash: "#/notebooks/57443510/notes/146614893",
      },
      async fetch(path: string, options: { method?: string; body?: unknown }) {
        assert.ok(options.method === undefined || options.method === "GET");
        assert.equal(options.body, undefined);
        return {
          ok: true,
          json: async () =>
            path === "/author/notes/146614893/content"
              ? { content: variant.html }
              : [
                  {
                    id: 146614893,
                    title: article.title,
                    shared: false,
                    schedule_publish_at: null,
                    last_compiled_at: 0,
                  },
                ],
        };
      },
    });
    assert.equal(result, variant.ok, variant.name);
  }
});
