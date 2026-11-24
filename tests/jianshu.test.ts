import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../core/database";
import {
  JianshuArticles,
  jianshuSourceSchema,
  type JianshuDependencies,
} from "../core/jianshu/service";
import type {
  JianshuArticle,
  JianshuDetail,
  JianshuSaveInput,
  JianshuSource,
  JianshuPayload,
} from "../shared/jianshu";
import type { ResourceCopy, Resource } from "../shared/types";
import type { WebsiteAccount } from "../shared/website-accounts";
import { jianshuHtml } from "../core/jianshu/content";
import { JianshuSourceCollector } from "../core/jianshu/sources";
import { AppError } from "../core/errors";
import { jianshuDraftUrl } from "../shared/jianshu";

const text =
  "这是一份英语词汇学习资料，包含基础词汇和阅读练习。使用时先根据资料目录安排每日学习目标，再结合练习进行复习。";
const source = (): JianshuSource => ({
  id: "source_sample",
  provider: "rss",
  title: "学习资料整理方法",
  body: text,
  summary: text,
  url: "https://example.com/articles/english",
  sourceName: "示例作者",
  author: "资料作者",
  publishedAt: null,
  collectedAt: new Date().toISOString(),
  images: [],
  externalShares: [],
  warnings: [],
});
function fixture() {
  const db = new Database(":memory:");
  const copy: ResourceCopy = {
    id: "copy_test",
    resourceId: "resource_test",
    accountId: "account_test",
    directory: "/资料",
    folderId: "folder",
    files: [
      {
        id: "file",
        parentId: "folder",
        name: "词汇.pdf",
        size: 100,
        isDirectory: false,
      },
    ],
    status: "ready",
    ownerUid: "owner",
    verifiedAt: "2026-11-23",
    shareId: "share",
    shareUrl: "https://pan.quark.cn/s/ownshare1234",
    shareOwnerUid: "owner",
    shareVersion: 1,
    shareVerifiedAt: "2026-11-23",
    noteStatus: "none",
    error: null,
  } satisfies ResourceCopy;
  const resource = {
    id: "resource_test",
    sourceKind: "owned",
    title: "英语词汇资料",
    provider: "quark",
    sourceUrl: "https://pan.quark.cn/s/ownshare1234",
    category: "英语",
    tags: [],
    summary: text,
    coverId: null,
    revision: 1,
    createdAt: "2026-11-23",
    updatedAt: "2026-11-23",
    copies: [copy],
  } satisfies Resource;
  const account: WebsiteAccount = {
    id: "web_test",
    provider: "jianshu",
    uid: "03f80ba6b743",
    alias: "简书测试",
    status: "connected",
    createdAt: "2026-11-23",
    updatedAt: "2026-11-23",
  };
  const state = {
    calls: 0,
    prepares: 0,
    checks: 0,
    fail: false,
    result: true,
    hold: false,
    release: null as (() => void) | null,
    prepared: null as JianshuPayload | null,
    checked: null as JianshuPayload | null,
    imageValidation: null as (() => Promise<void>) | null,
    items: [source()],
  };
  const deps: JianshuDependencies = {
    repo: {
      db,
      getCopy(id) {
        assert.equal(id, copy.id);
        return structuredClone(copy);
      },
      getResource(id) {
        assert.equal(id, resource.id);
        return structuredClone(resource);
      },
    },
    accounts: {
      get() {
        return { ...account, environmentId: undefined };
      },
      async use(_id, _provider, action) {
        return action({ ...account });
      },
    },
    assertOwnCopy(value) {
      if (value.ownerUid !== "owner") throw Error("未核验本人资料");
    },
    assertTarget() {
      if (copy.status !== "ready" || !copy.shareVerifiedAt)
        throw Error("本人分享未核验");
    },
    environmentStamp() {
      return { environmentId: "env_test", revision: 1 };
    },
    async generateText(input) {
      state.calls++;
      if (state.hold)
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      if (state.fail) throw Error("模拟模型请求失败");
      return {
        title: "英语资料使用建议",
        body: `${text}\n\n补充要求：${input.instruction || "按目录循序练习。"}`,
      };
    },
    collector: {
      async collect() {
        return {
          items: structuredClone(state.items),
          sourceName: "样例RSS",
          url: "https://example.com/feed",
          collectedAt: new Date().toISOString(),
          truncated: false,
          warnings: [],
        };
      },
    },
    port: {
      async prepare(_account, payload) {
        state.prepares++;
        state.prepared = payload;
        return {
          opened: true,
          filled: false,
          editorUrl: "https://www.jianshu.com/writer#/",
          message: "请复制到简书，尚未发布。",
        };
      },
      async checkResult(_account, url, payload) {
        state.checks++;
        state.checked = payload;
        return {
          verified: state.result,
          url,
          reason: state.result ? "核对通过" : "作者或内容待核实",
        };
      },
    },
    async validateImage() {
      await state.imageValidation?.();
    },
    changed() {},
  };
  const service = new JianshuArticles(deps);
  return {
    db,
    service,
    deps,
    state,
    copy,
    account,
    close() {
      service.close();
      db.close();
    },
  };
}
const create = (
  f: ReturnType<typeof fixture>,
  input: Record<string, unknown> = {},
) => f.service.create({ requestId: randomUUID(), body: text, ...input });
const save = (
  f: ReturnType<typeof fixture>,
  detail: JianshuDetail,
  changes: Partial<JianshuSaveInput> = {},
) => {
  const a = detail.article;
  return f.service.save({
    id: a.id,
    revision: a.revision,
    title: a.title,
    body: a.body,
    template: a.template,
    accountId: a.accountId,
    copyId: a.copyId,
    sourceIds: a.sourceIds,
    images: a.images,
    ...changes,
  });
};

test("公开HTTP出处可归档引用，原文与图片线索均拒绝内网、凭据或异常端口", async () => {
  const f = fixture();
  try {
    f.state.items[0].url =
      "http://www.ruanyifeng.com/blog/2026/11/weekly-issue.html";
    f.state.items[0].images = [
      { url: "http://cdn.example.com/cover.jpg", alt: "原文配图线索" },
    ];
    const [item] = await f.service.collect({
      provider: "rss",
      url: "https://www.ruanyifeng.com/blog/atom.xml",
    });
    assert.equal(item.url, f.state.items[0].url);
    const draft = create(f, { sourceIds: [item.id] });
    assert.ok(draft.delivery.text.includes(item.url));
    const invalid = [
      "http://127.0.0.1/item",
      "https://[::1]/item",
      "http://localhost/item",
      "http://dashboard.internal/item",
      "https://example.com:444/item",
      "https://user:password@example.com/item",
    ];
    for (const url of invalid) {
      assert.equal(
        jianshuSourceSchema.safeParse({ ...source(), url }).success,
        false,
        `原文: ${url}`,
      );
      assert.equal(
        jianshuSourceSchema.safeParse({
          ...source(),
          images: [{ url, alt: "" }],
        }).success,
        false,
        `图片: ${url}`,
      );
      assert.equal(
        jianshuSourceSchema.safeParse({
          ...source(),
          externalShares: [{ url, code: "" }],
        }).success,
        false,
        `外部线索: ${url}`,
      );
    }
    assert.equal(f.service.sources().length, 1);
  } finally {
    f.close();
  }
});

test("采集归档、去重和原素材修订不会覆盖旧稿依据", async () => {
  const f = fixture();
  try {
    const [first] = await f.service.collect({
      provider: "rss",
      url: "https://example.com/feed",
    });
    await f.service.collect({
      provider: "rss",
      url: "https://example.com/feed",
    });
    assert.equal(f.service.sources().length, 1);
    const draft = create(f, { sourceIds: [first.id] });
    f.state.items[0].body += "\n原页后来更新。";
    const [updated] = await f.service.collect({
      provider: "rss",
      url: "https://example.com/feed",
    });
    assert.notEqual(updated.id, first.id);
    assert.equal(f.service.sources().length, 2);
    assert.equal(f.service.get(draft.article.id).sources[0].body, text);
    assert.match(draft.delivery.text, /参考来源/);
    assert.match(
      draft.delivery.text,
      /https:\/\/example.com\/articles\/english/,
    );
  } finally {
    f.close();
  }
});

test("本人资源入口进入准确交付；第三方分享不会自动成为本人资源", () => {
  const f = fixture();
  try {
    const draft = create(f, { copyId: f.copy.id });
    assert.equal(draft.delivery.resourceUrl, f.copy.shareUrl);
    assert.match(draft.delivery.text, /资料获取/);
    assert.ok(draft.delivery.text.includes(f.copy.shareUrl!));
    const dirty = save(f, draft, {
      body: text + "\nhttps://pan.quark.cn/s/othershare1234",
    });
    assert.ok(
      dirty.issues.some((issue) => /未关联的网盘分享/.test(issue.text)),
    );
    f.copy.shareVerifiedAt = null;
    assert.throws(() => create(f, { copyId: f.copy.id }), /分享未核验/);
    assert.ok(
      f.service
        .get(draft.article.id)
        .issues.some((issue) => issue.severity === "error"),
    );
  } finally {
    f.close();
  }
});

test("贴吧同帖归档保留旧稿，首楼线索和图片不成为交付物", async () => {
  const f = fixture();
  const tid = "9063569462";
  const url = `https://tieba.baidu.com/p/${tid}`;
  const share = "https://www.123pan.com/s/example12";
  const image = "https://tiebapic.baidu.com/forum/example.jpg";
  const original = `${text}\n${share}\n提取码：ABCD`;
  const thread = {
    id: tid,
    url,
    title: "公开工具教程",
    forum: "windows11",
    author: "楼主",
    publishedAt: null,
    firstFloor: {
      text: original,
      hrefs: [share],
      images: [image],
      truncated: false,
    },
  };
  let fail = false;
  f.deps.collector = new JianshuSourceCollector({
    async readTiebaThread() {
      if (fail) throw new Error("offline");
      return thread;
    },
  });
  try {
    const collect = (target = url) =>
      f.service.collect({ provider: "tieba", url: target });
    const [post] = await collect();
    const [duplicate] = await collect(`${url}?pn=2#floor`);
    assert.equal(duplicate.id, post.id);
    assert.equal(f.service.sources().length, 1);
    const draft = create(f, { body: "", sourceIds: [post.id] });
    assert.equal(draft.sources[0].body, original);
    assert.equal(draft.delivery.resourceUrl, null);
    assert.deepEqual(draft.delivery.sourceUrls, [url]);
    assert.match(draft.delivery.text, /参考来源/);
    assert.doesNotMatch(draft.delivery.text, /123pan|ABCD|tiebapic/);
    assert.deepEqual(draft.article.images, []);

    thread.firstFloor.text += "\n作者补充了新步骤。";
    const [updated] = await collect();
    assert.notEqual(updated.id, post.id);
    assert.equal(f.service.get(draft.article.id).sources[0].body, original);
    const combined = create(f, {
      body: "",
      sourceIds: [post.id, updated.id],
      copyId: f.copy.id,
    });
    assert.equal(combined.delivery.text.split(url).length - 1, 1);
    assert.equal(combined.delivery.resourceUrl, f.copy.shareUrl);
    assert.doesNotMatch(combined.delivery.text, /123pan|ABCD|tiebapic/);

    f.deps.generateText = async () => ({
      title: "公开工具教程",
      body: `${text}\n${share}`,
    });
    await assert.rejects(
      f.service.generate({
        id: draft.article.id,
        revision: draft.article.revision,
        requestId: randomUUID(),
      }),
      /未关联的网盘分享/,
    );
    assert.equal(
      f.service.get(draft.article.id).article.body,
      draft.article.body,
    );

    fail = true;
    await assert.rejects(collect(), /暂时无法读取/);
    assert.equal(f.service.sources().length, 2);
  } finally {
    f.close();
  }
});

test("手写无资源稿件、请求去重、版本冲突和历史记录持久化", () => {
  const f = fixture();
  try {
    const request = { requestId: randomUUID(), title: "手写文章", body: text };
    const draft = f.service.create(request);
    assert.equal(f.service.create(request).article.id, draft.article.id);
    assert.throws(
      () => f.service.create({ ...request, title: "另一篇" }),
      /同一新建请求/,
    );
    assert.equal(draft.article.copyId, null);
    assert.equal(draft.article.accountId, null);
    const edited = save(f, draft, { title: "编辑后的文章" });
    assert.equal(edited.article.revision, 2);
    assert.equal(edited.article.versions[0].title, "手写文章");
    assert.equal(save(f, edited).article.revision, 2);
    assert.throws(() => save(f, draft), /文章已在其他窗口修改/);
    const reopened = new JianshuArticles(f.deps);
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.get(draft.article.id).article.title, "编辑后的文章");
    assert.equal(f.state.calls, 0);
    reopened.close();
  } finally {
    f.close();
  }
});

test("AI重复请求仅生成一次，校准保留原稿版本，不覆盖同时编辑", async () => {
  const f = fixture();
  try {
    const draft = create(f, { title: "原稿" });
    f.state.hold = true;
    const req = {
      id: draft.article.id,
      revision: 1,
      requestId: randomUUID(),
      instruction: "更适合初学者",
    };
    const a = f.service.generate(req),
      b = f.service.generate(req);
    assert.equal(f.state.calls, 1);
    assert.equal(f.service.isBusy, true);
    assert.throws(() => save(f, draft), /正在处理/);
    f.state.release!();
    const [one, two] = await Promise.all([a, b]);
    assert.equal(one.article.revision, 2);
    assert.equal(one.busy, false);
    assert.deepEqual(one.article, two.article);
    assert.equal(one.article.versions[0].title, "原稿");
    assert.match(one.article.body, /更适合初学者/);
    await f.service.generate(req);
    assert.equal(f.state.calls, 1);
    await assert.rejects(
      f.service.generate({ ...req, instruction: "内容变更" }),
      /同一生成请求/,
    );
  } finally {
    f.state.release?.();
    f.close();
  }
});

test("AI失败和异常回复保留旧稿，失败请求不自动重放", async () => {
  const f = fixture();
  try {
    const draft = create(f, { title: "原稿" });
    const req = {
      id: draft.article.id,
      revision: 1,
      requestId: randomUUID(),
      instruction: "缩短",
    };
    f.state.fail = true;
    await assert.rejects(f.service.generate(req), /模拟模型/);
    assert.equal(f.service.get(draft.article.id).article.body, text);
    await assert.rejects(f.service.generate(req), /模拟模型/);
    assert.equal(f.state.calls, 1);
    f.state.fail = false;
    f.deps.generateText = async () => ({
      title: "模型回复",
      body: "作为一个AI，我无法为您提供相关创作服务，请补充其他信息。".repeat(
        3,
      ),
    });
    await assert.rejects(
      f.service.generate({ ...req, requestId: randomUUID() }),
      /模型异常/,
    );
    assert.equal(f.service.get(draft.article.id).article.revision, 1);
  } finally {
    f.close();
  }
});

test("官网准备不记作发布，并发准备不会重复开窗；确认未发布后可改稿", async () => {
  const f = fixture();
  try {
    const draft = create(f, { title: "待发布文章", accountId: f.account.id });
    let release!: () => void;
    let entered!: () => void;
    const enteredValidation = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.state.imageValidation = () => {
      entered();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const image = {
      file: "a".repeat(64) + ".png",
      sha256: "a".repeat(64),
      storage: "content-assets" as const,
      name: "封面",
    };
    const withImage = save(f, draft, { images: [image] });
    const req = {
      id: withImage.article.id,
      revision: withImage.article.revision,
    };
    const pending = f.service.prepare(req);
    await enteredValidation;
    save(f, withImage, { title: "等待中已修改" });
    release();
    await assert.rejects(pending, /文章已在其他窗口修改/);
    assert.equal(f.state.prepares, 0);
    f.state.imageValidation = null;
    const latest = f.service.get(draft.article.id);
    const prepared = await f.service.prepare({
      id: latest.article.id,
      revision: latest.article.revision,
    });
    assert.equal(prepared.article.stage, "prepared");
    assert.equal(prepared.article.receiptUrl, null);
    assert.equal(prepared.busy, false);
    assert.throws(() => save(f, prepared), /请先核对结果/);
    const editing = f.service.resolve({
      id: prepared.article.id,
      revision: prepared.article.revision,
      notPublished: true,
    });
    assert.equal(
      save(f, editing, { title: "继续修改" }).article.title,
      "继续修改",
    );
  } finally {
    f.close();
  }
});

test("只有明确回执可记发布；不匹配、读取失败和非法地址均不记成功", async () => {
  const f = fixture();
  try {
    const draft = create(f, { title: "核对文章", accountId: f.account.id });
    const req = {
      id: draft.article.id,
      revision: 1,
      url: "https://www.jianshu.com/p/123456abcdef",
    };
    await assert.rejects(
      f.service.checkResult({
        ...req,
        url: "https://evil.example/p/123456abcdef",
      }),
      /公开文章/,
    );
    assert.equal(f.state.checks, 0);
    f.state.result = false;
    assert.equal((await f.service.checkResult(req)).article.stage, "uncertain");
    f.state.result = true;
    const confirmed = await f.service.checkResult(req);
    assert.equal(confirmed.article.stage, "published");
    assert.equal(confirmed.article.receiptUrl, req.url);
    await f.service.checkResult(req);
    assert.equal(f.state.checks, 2);
    assert.throws(
      () =>
        f.service.resolve({
          id: draft.article.id,
          revision: 1,
          notPublished: true,
        }),
      /已核实发布/,
    );
  } finally {
    f.close();
  }
});

test("交接快照保留原入口，资源后来改链不会改写原发布核对", async () => {
  const f = fixture();
  try {
    const draft = create(f, {
      title: "带资料的文章",
      accountId: f.account.id,
      copyId: f.copy.id,
    });
    await f.service.prepare({ id: draft.article.id, revision: 1 });
    const original = f.copy.shareUrl;
    f.copy.shareUrl = "https://pan.quark.cn/s/newshare1234";
    await f.service.checkResult({
      id: draft.article.id,
      revision: 1,
      url: "https://www.jianshu.com/p/123456abcdef",
    });
    assert.equal(f.state.checked!.resourceUrl, original);
    assert.ok(f.state.checked!.text.includes(original!));
    assert.ok(!f.state.checked!.text.includes(f.copy.shareUrl));
  } finally {
    f.close();
  }
});

test("重启中断不会自动重复生成或官网交接；关闭后异步结果不写入", async () => {
  const f = fixture();
  try {
    const draft = create(f, { title: "中断稿件" });
    const stored = {
      ...draft.article,
      stage: "preparing",
    } satisfies JianshuArticle;
    f.db.setSetting(`jianshu:article:v1:${stored.id}`, stored);
    const requestId = randomUUID();
    f.db.setSetting("jianshu:generations:v1", [requestId]);
    f.db.setSetting(`jianshu:generation:v1:${requestId}`, {
      articleId: stored.id,
      inputHash: "old",
      status: "running",
    });
    const reopened = new JianshuArticles(f.deps);
    assert.equal(reopened.get(stored.id).article.stage, "uncertain");
    assert.equal(
      f.db.setting<any>(`jianshu:generation:v1:${requestId}`, null).status,
      "interrupted",
    );
    assert.equal(f.state.calls, 0);
    assert.equal(f.state.prepares, 0);
    reopened.close();
    const plain = create(f, { title: "关闭中的生成" });
    f.state.hold = true;
    const pending = f.service.generate({
      id: plain.article.id,
      revision: 1,
      requestId: randomUUID(),
    });
    f.service.close();
    f.state.release!();
    await assert.rejects(pending, /工作空间已关闭/);
    assert.equal(
      f.db.setting<JianshuArticle>(
        `jianshu:article:v1:${plain.article.id}`,
        plain.article,
      ).revision,
      1,
    );
  } finally {
    f.state.release?.();
    f.close();
  }
});

test("交付HTML只呈现文字，不执行脚本或插入不可信HTML", () => {
  const html = jianshuHtml(
    "<script>标题</script>",
    "<img src=x onerror=alert(1)>\n\n## 小节",
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img src="));
  assert.match(html, /&lt;img/);
  assert.match(html, /<h3>小节<\/h3>/);
});

test("默认封面与第一版同事务创建，并发新建只读取一次封面", async () => {
  const f = fixture();
  try {
    let release!: (
      value: import("../shared/content-sources").ContentImage,
    ) => void;
    let covers = 0;
    f.deps.resourceCover = async () => {
      covers++;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const req = {
      requestId: randomUUID(),
      copyId: f.copy.id,
      title: "带原封面",
      body: text,
    };
    const a = f.service.createWithCover(req),
      b = f.service.createWithCover(req);
    assert.equal(covers, 1);
    assert.equal(f.service.list().length, 0);
    assert.equal(f.service.isBusy, true);
    const image = {
      file: "a".repeat(64) + ".png",
      sha256: "a".repeat(64),
      name: "原封面",
      storage: "content-assets" as const,
    };
    release(image);
    const [one, two] = await Promise.all([a, b]);
    assert.equal(one.article.id, two.article.id);
    assert.deepEqual(one.article.images, [image]);
    assert.deepEqual(one.article.versions[0].images, [image]);
    await f.service.createWithCover(req);
    assert.equal(covers, 1);
    assert.equal(f.service.isBusy, false);
  } finally {
    f.close();
  }
});

test("可选封面缺失或损坏时保留无图草稿和补图提示，不重复创建", async () => {
  for (const stage of ["read", "validate"] as const) {
    const f = fixture();
    try {
      let reads = 0;
      f.deps.resourceCover = async () => {
        reads++;
        if (stage === "read") throw Error("封面文件不存在");
        return {
          file: "a".repeat(64) + ".png",
          sha256: "a".repeat(64),
          name: "损坏封面",
          storage: "content-assets",
        };
      };
      f.deps.validateImage = async () => {
        throw Error("封面校验失败");
      };
      const input = {
        requestId: randomUUID(),
        copyId: f.copy.id,
        title: "封面暂不可用",
        body: text,
      };
      const draft = await f.service.createWithCover(input);
      assert.deepEqual(draft.article.images, []);
      assert.deepEqual(draft.article.versions[0].images, []);
      assert.match(draft.article.message, /草稿已保存.*稍后添加本地配图/);
      assert.equal(draft.delivery.resourceUrl, f.copy.shareUrl);
      assert.equal(
        (await f.service.createWithCover(input)).article.id,
        draft.article.id,
      );
      assert.equal(reads, 1);
      assert.equal(f.service.list().length, 1);
      assert.equal(f.service.isBusy, false);
    } finally {
      f.close();
    }
  }
});

test("可选封面回退不会绕过本人资源核验或工作空间关闭", async () => {
  const ownership = fixture();
  try {
    let reads = 0;
    ownership.copy.ownerUid = "another-owner";
    ownership.deps.resourceCover = async () => {
      reads++;
      throw Error("封面缺失");
    };
    await assert.rejects(
      ownership.service.createWithCover({
        requestId: randomUUID(),
        copyId: ownership.copy.id,
        body: text,
      }),
      /未核验本人/,
    );
    assert.equal(reads, 0);
    assert.equal(ownership.service.list().length, 0);
  } finally {
    ownership.close();
  }
  const f = fixture();
  try {
    let rejectCover!: (reason: Error) => void;
    f.deps.resourceCover = async () =>
      new Promise((_, reject) => {
        rejectCover = reject;
      });
    const pending = f.service.createWithCover({
      requestId: randomUUID(),
      copyId: f.copy.id,
      body: text,
    });
    f.service.close();
    rejectCover(Error("封面读取已中断"));
    await assert.rejects(pending, /工作空间已关闭/);
    assert.equal(f.db.setting<string[]>("jianshu:articles:v1", []).length, 0);
    assert.equal(f.service.isBusy, false);
  } finally {
    f.close();
  }
});

test("自动填写必须先通过 fresh 身份核验，未知身份不会修改官网", async () => {
  const f = fixture();
  try {
    f.account.uid = null;
    let leases = 0;
    f.deps.runInEnvironment = async (_id, action) => {
      leases++;
      return action();
    };
    f.deps.accounts.use = async () => {
      throw Error("必须先核实登录身份");
    };
    const draft = create(f, { title: "手工交接", accountId: f.account.id });
    await assert.rejects(
      f.service.prepare({
        id: draft.article.id,
        revision: 1,
      }),
      /核实登录/,
    );
    assert.equal(f.service.get(draft.article.id).article.stage, "editing");
    assert.equal(f.state.prepares, 0);
    assert.equal(leases, 0, "不能以环境锁替代 fresh 身份核验");
    await assert.rejects(
      f.service.checkResult({
        id: draft.article.id,
        revision: 1,
        url: "https://www.jianshu.com/p/123456abcdef",
      }),
      /核实登录/,
    );
    assert.equal(f.state.checks, 0);
  } finally {
    f.close();
  }
});

const noteUrl =
  "https://www.jianshu.com/writer#/notebooks/57443510/notes/146614893";

test("草稿检查点仅接受具体官方 note，文集、外站和异常URL均不能恢复填写", () => {
  assert.equal(jianshuDraftUrl(noteUrl), noteUrl);
  assert.equal(
    jianshuDraftUrl(noteUrl.replace("www.jianshu.com", "jianshu.com")),
    noteUrl,
  );
  for (const url of [
    "https://www.jianshu.com/writer#/",
    "https://www.jianshu.com/writer#/notebooks/57443510",
    noteUrl.replace("www.jianshu.com", "evil.example"),
    noteUrl.replace("https:", "http:"),
    noteUrl.replace("/writer#", "/writer?token=x#"),
    noteUrl.replace("www.jianshu.com", "user@www.jianshu.com"),
  ])
    assert.equal(jianshuDraftUrl(url), null);
});

test("部分填写立即保存具体草稿与图片进度，重启重试仍使用同稿且不登记发布", async () => {
  const f = fixture();
  try {
    const initial = create(f, { title: "续填原稿", accountId: f.account.id });
    const draft = save(f, initial, {
      images: ["a", "b"].map((letter) => ({
        file: letter.repeat(64) + ".png",
        sha256: letter.repeat(64),
        storage: "content-assets" as const,
        name: letter,
      })),
    });
    let calls = 0;
    f.deps.port!.prepare = async (_account, payload, checkpoint) => {
      calls++;
      if (calls === 1) {
        assert.equal(payload.editorUrl, null);
        await checkpoint!({
          editorUrl: noteUrl,
          filled: false,
          uploadedImages: 1,
          totalImages: 2,
          titleHash: "a".repeat(64),
          textHash: "b".repeat(64),
          pendingImageSha256: "b".repeat(64),
        });
        const stored = f.db.setting<JianshuArticle>(
          `jianshu:article:v1:${draft.article.id}`,
          draft.article,
        );
        assert.equal(stored.editorUrl, noteUrl);
        assert.equal(stored.preparedFill?.uploadedImages, 1);
        throw new AppError("IMAGE_UPLOAD", "第二张图片上传失败", true);
      }
      assert.equal(payload.editorUrl, noteUrl);
      assert.equal(payload.fillCheckpoint?.uploadedImages, 1);
      assert.equal(payload.fillCheckpoint?.textHash, "b".repeat(64));
      assert.equal(payload.fillCheckpoint?.pendingImageSha256, "b".repeat(64));
      await checkpoint!({
        editorUrl: noteUrl,
        pendingImageSha256: null,
        uploadedImages: 2,
        totalImages: 2,
      });
      return {
        opened: true,
        filled: true,
        editorUrl: noteUrl,
        uploadedImages: 2,
        totalImages: 2,
        message: "标题正文和配图已填入，尚未发布。",
      };
    };
    const req = { id: draft.article.id, revision: draft.article.revision };
    await assert.rejects(f.service.prepare(req), /第二张图片/);
    assert.equal(f.service.get(req.id).article.stage, "uncertain");
    const reopened = new JianshuArticles(f.deps);
    try {
      const result = await reopened.prepare(req);
      assert.equal(calls, 2);
      assert.equal(result.article.stage, "prepared");
      assert.equal(result.article.receiptUrl, null);
      assert.equal(result.article.preparedFill?.filled, true);
      assert.equal(result.article.preparedFill?.uploadedImages, 2);
      assert.equal(result.article.preparedFill?.pendingImageSha256, null);
      assert.equal(result.article.preparedUid, f.account.uid);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test("官网创建结果未知且无具体草稿时，重试不能再建一篇；核验失败可直接恢复原状态", async () => {
  const f = fixture();
  try {
    const draft = create(f, { title: "未知远端结果", accountId: f.account.id });
    let calls = 0;
    f.deps.port!.prepare = async () => {
      calls++;
      throw Error("点击新建后连接中断");
    };
    const req = { id: draft.article.id, revision: 1 };
    await assert.rejects(f.service.prepare(req), /连接中断/);
    assert.equal(f.service.get(req.id).article.stage, "uncertain");
    await assert.rejects(f.service.prepare(req), /避免重复创建/);
    assert.equal(calls, 1);
    f.service.resolve({ ...req, notPublished: true });
    f.account.uid = null;
    await assert.rejects(f.service.prepare(req), /核实简书登录身份/);
    assert.equal(calls, 1);
    assert.equal(f.service.get(req.id).article.stage, "editing");
  } finally {
    f.close();
  }
});

test("只有明确确认图片未上传才清除pending，默认返回编辑保留官网草稿和检查点", () => {
  const f = fixture();
  try {
    const initial = create(f, { title: "待确认上传", accountId: f.account.id });
    const image = {
      file: "a".repeat(64) + ".png",
      sha256: "a".repeat(64),
      storage: "content-assets" as const,
      name: "封面",
    };
    const draft = save(f, initial, { images: [image] });
    const checkpoint = {
      editorUrl: noteUrl,
      filled: false,
      pendingImageSha256: image.sha256,
      uploadedImages: 0,
      totalImages: 1,
      titleHash: "b".repeat(64),
      textHash: "c".repeat(64),
      uploadedImageRefs: [],
    };
    f.db.setSetting(`jianshu:article:v1:${draft.article.id}`, {
      ...draft.article,
      stage: "uncertain",
      editorUrl: noteUrl,
      preparedUid: f.account.uid,
      preparedFill: checkpoint,
    });
    const req = {
      id: draft.article.id,
      revision: draft.article.revision,
      notPublished: true,
    };
    const ordinary = f.service.resolve(req);
    assert.equal(ordinary.article.stage, "editing");
    assert.deepEqual(ordinary.article.preparedFill, checkpoint);
    const recovered = f.service.resolve({ ...req, imageNotUploaded: true });
    assert.equal(recovered.article.stage, "editing");
    assert.equal(recovered.article.editorUrl, noteUrl);
    assert.equal(recovered.article.preparedUid, f.account.uid);
    assert.deepEqual(recovered.article.preparedFill, {
      ...checkpoint,
      pendingImageSha256: null,
    });
    assert.throws(
      () => f.service.resolve({ ...req, imageNotUploaded: true }),
      /没有待确认的图片/,
    );
    assert.equal(f.service.get(req.id).article.editorUrl, noteUrl);
    assert.equal(
      f.state.prepares,
      0,
      "人工确认只修改本地检查点，不自动提交远端上传",
    );
  } finally {
    f.close();
  }
});

test("明确改用新草稿只解除本地关联，保留文章版本与配图，不改写远端或已发布记录", () => {
  const f = fixture();
  try {
    const initial = create(f, {
      title: "英语学习安排",
      accountId: f.account.id,
    });
    const image = {
      file: "a".repeat(64) + ".png",
      sha256: "a".repeat(64),
      name: "封面",
      storage: "content-assets" as const,
    };
    const d = save(f, initial, { images: [image] });
    const prepared = {
      ...d.article,
      stage: "uncertain",
      editorUrl: noteUrl,
      preparedUid: f.account.uid,
      preparedRevision: d.article.revision,
      preparedFill: {
        editorUrl: noteUrl,
        filled: false,
        uploadedImages: 0,
        totalImages: 1,
      },
    };
    f.db.setSetting(`jianshu:article:v1:${d.article.id}`, prepared);
    const req = {
      id: d.article.id,
      revision: d.article.revision,
      notPublished: true,
    };
    assert.equal(
      f.service.resolve(req).article.editorUrl,
      noteUrl,
      "默认返回修改继续保留关联",
    );
    const recovered = f.service.resolve({ ...req, newDraft: true });
    assert.equal(recovered.article.editorUrl, null);
    assert.equal(recovered.article.preparedFill, null);
    assert.equal(recovered.article.preparedUid, null);
    assert.equal(recovered.article.stage, "editing");
    assert.equal(recovered.article.accountId, d.article.accountId);
    assert.equal(recovered.article.body, d.article.body);
    assert.deepEqual(recovered.article.images, d.article.images);
    assert.deepEqual(recovered.article.versions, d.article.versions);
    assert.equal(f.state.prepares, 0, "解除关联不创建或改写任何官网稿件");
    assert.throws(
      () => f.service.resolve({ ...req, newDraft: true }),
      /没有已关联/,
    );
    f.db.setSetting(`jianshu:article:v1:${d.article.id}`, {
      ...prepared,
      stage: "published",
      receiptUrl: "https://www.jianshu.com/p/783255fa1ea8",
    });
    assert.throws(
      () => f.service.resolve({ ...req, newDraft: true }),
      /已核实发布/,
    );
  } finally {
    f.close();
  }
});

test("旧手工交接可显式升级自动填写；已关联草稿改稿后仍保留检查点且不能换账号", async () => {
  const f = fixture();
  try {
    const draft = create(f, { title: "旧交接稿", accountId: f.account.id });
    const req = { id: draft.article.id, revision: 1 };
    await f.service.prepare(req);
    f.deps.port!.prepare = async (_account, payload, checkpoint) => {
      assert.equal(payload.editorUrl, null);
      await checkpoint!({
        editorUrl: noteUrl,
        filled: true,
        titleHash: "a".repeat(64),
        textHash: "b".repeat(64),
      });
      return {
        opened: true,
        filled: true,
        editorUrl: noteUrl,
        message: "已填入",
      };
    };
    const filled = await f.service.prepare(req);
    assert.equal(filled.article.stage, "prepared");
    const editing = f.service.resolve({ ...req, notPublished: true });
    assert.equal(editing.article.editorUrl, noteUrl);
    assert.equal(editing.article.preparedUid, f.account.uid);
    assert.throws(
      () => save(f, editing, { accountId: "another_account" }),
      /保留原账号/,
    );
    const updated = save(f, editing, { title: "修改标题" });
    assert.equal(updated.article.preparedFill?.filled, false);
    assert.equal(updated.article.preparedFill?.textHash, "b".repeat(64));
    f.account.uid = "another_uid";
    await assert.rejects(
      f.service.prepare({ id: req.id, revision: 2 }),
      /原官网草稿的账号一致/,
    );
    assert.equal(f.service.get(req.id).article.editorUrl, noteUrl);
    assert.equal(f.service.get(req.id).article.stage, "editing");
  } finally {
    f.close();
  }
});

test("填写恢复拒绝换成另一个官网草稿，并发填写只调用一次远端", async () => {
  const f = fixture();
  try {
    const draft = create(f, { title: "只使用原稿", accountId: f.account.id });
    const req = { id: draft.article.id, revision: 1 };
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    f.deps.port!.prepare = async (_account, _payload, checkpoint) => {
      calls++;
      await checkpoint!({ editorUrl: noteUrl });
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        opened: true,
        filled: true,
        editorUrl: noteUrl,
        message: "已填入",
      };
    };
    const pending = f.service.prepare(req);
    await started;
    await assert.rejects(f.service.prepare(req), /正在处理/);
    release();
    await pending;
    assert.equal(calls, 1);
    f.deps.port!.prepare = async (_account, _payload, checkpoint) => {
      await checkpoint!({
        editorUrl: noteUrl.replace("146614893", "146614894"),
      });
      throw Error("不应到达");
    };
    await assert.rejects(f.service.prepare(req), /草稿地址与原记录不一致/);
    const detail = f.service.get(req.id);
    assert.equal(detail.article.editorUrl, noteUrl);
    assert.equal(detail.article.stage, "uncertain");
    await f.service.checkResult({
      ...req,
      url: "https://www.jianshu.com/p/123456abcdef",
    });
    await assert.rejects(f.service.prepare(req), /已有发布结果/);
  } finally {
    f.close();
  }
});

test("提取码从SecretStore读取用于预览和真实交接，不明文写入settings", async () => {
  const f = fixture();
  try {
    let code = "k9z7";
    f.deps.readShareCode = async () => code;
    const draft = create(f, {
      copyId: f.copy.id,
      title: "带提取码的资料",
      accountId: f.account.id,
    });
    const delivered = await f.service.deliveryDetail(draft.article.id);
    assert.match(delivered.delivery.text, /提取码：k9z7/);
    assert.match(delivered.delivery.html, /提取码：k9z7/);
    await f.service.prepare({ id: draft.article.id, revision: 1 });
    assert.match(f.state.prepared!.text, /提取码：k9z7/);
    const stored = f.db.setting<JianshuArticle>(
      `jianshu:article:v1:${draft.article.id}`,
      draft.article,
    );
    assert.ok(!JSON.stringify(stored).includes(code));
    assert.equal(stored.preparedShareCodeHash?.length, 64);
    await f.service.checkResult({
      id: draft.article.id,
      revision: 1,
      url: "https://www.jianshu.com/p/123456abcdef",
    });
    assert.match(f.state.checked!.text, /提取码：k9z7/);
    const other = create(f, {
      copyId: f.copy.id,
      title: "后来改变提取码",
      accountId: f.account.id,
    });
    await f.service.prepare({ id: other.article.id, revision: 1 });
    code = "u2x4";
    await assert.rejects(
      f.service.prepare({ id: other.article.id, revision: 1 }),
      /资料提取信息已变化/,
    );
    assert.equal(f.service.get(other.article.id).article.stage, "prepared");
    await assert.rejects(
      f.service.checkResult({
        id: other.article.id,
        revision: 1,
        url: "https://www.jianshu.com/p/abcdef123456",
      }),
      /提取信息已变化/,
    );
    assert.equal(f.service.get(other.article.id).article.stage, "uncertain");
  } finally {
    f.close();
  }
});

test("聚合采集提示保留，全字段修订快照不会覆盖原作者或外部入口", async () => {
  const f = fixture();
  try {
    f.deps.collector!.collect = async () => ({
      items: structuredClone(f.state.items),
      warnings: ["部分来源没有公开日期"],
      sourceName: "来源",
      url: "https://example.com/feed",
      collectedAt: "2026-11-23",
      truncated: true,
    });
    const [one] = await f.service.collect({
      provider: "rss",
      url: "https://example.com/feed",
    });
    assert.ok(one.warnings.some((w) => /公开日期/.test(w)));
    assert.ok(one.warnings.some((w) => /截取/.test(w)));
    f.state.items[0].author = "修订后的作者";
    f.state.items[0].externalShares = [
      { url: "https://pan.quark.cn/s/another12345", code: "" },
    ];
    const [two] = await f.service.collect({
      provider: "rss",
      url: "https://example.com/feed",
    });
    assert.notEqual(one.id, two.id);
    assert.equal(
      f.service.sources().find((s) => s.id === one.id)?.author,
      "资料作者",
    );
    assert.equal(
      f.service.sources().find((s) => s.id === one.id)?.externalShares.length,
      0,
    );
    f.state.items[0].url = "javascript:alert(1)";
    await assert.rejects(
      f.service.collect({ provider: "rss", url: "https://example.com/feed" }),
    );
    assert.equal(f.service.sources().length, 2);
  } finally {
    f.close();
  }
});

test("图片需人工核对时保留状态，只能在文字发布核实后明确记录", async () => {
  const f = fixture();
  try {
    const draft = create(f, { accountId: f.account.id, title: "配图文章" });
    assert.throws(
      () =>
        f.service.confirmImages({
          id: draft.article.id,
          revision: 1,
          confirmed: true,
        }),
      /先完成公开文章/,
    );
    f.deps.port!.checkResult = async (_account, url) => ({
      verified: true,
      url,
      reason: "文字已核实",
      imageReviewRequired: true,
    });
    const checked = await f.service.checkResult({
      id: draft.article.id,
      revision: 1,
      url: "https://www.jianshu.com/p/123456abcdef",
    });
    assert.equal(checked.article.stage, "published");
    assert.equal(checked.article.imageReviewRequired, true);
    assert.match(checked.article.message, /配图仍需/);
    const reviewed = f.service.confirmImages({
      id: draft.article.id,
      revision: 1,
      confirmed: true,
    });
    assert.equal(reviewed.article.imageReviewRequired, false);
    assert.ok(reviewed.article.imageReviewedAt);
  } finally {
    f.close();
  }
});

test("交接后历史预览保持旧入口，提取码改变不会静默拼入新码", async () => {
  const f = fixture();
  try {
    let code = "old4";
    f.deps.readShareCode = async () => code;
    const originalUrl = f.copy.shareUrl;
    const draft = create(f, {
      copyId: f.copy.id,
      accountId: f.account.id,
      title: "原交付资料",
    });
    await f.service.prepare({ id: draft.article.id, revision: 1 });
    f.copy.shareUrl = "https://pan.quark.cn/s/newdelivery123";
    code = "new4";
    const history = await f.service.deliveryDetail(draft.article.id);
    assert.equal(history.delivery.resourceUrl, originalUrl);
    assert.ok(history.delivery.text.includes(originalUrl!));
    assert.ok(!history.delivery.text.includes(f.copy.shareUrl));
    assert.ok(!history.delivery.text.includes(code));
    assert.ok(
      history.issues.some((issue) => /未拼入当前提取码/.test(issue.text)),
    );
    assert.ok(
      history.issues.some((issue) => /保留当时的交付入口/.test(issue.text)),
    );
    assert.equal(history.article.stage, "prepared");
  } finally {
    f.close();
  }
});

test("恢复历史版本可同时恢复当时资料、来源与模板，避免旧正文配新入口", async () => {
  const f = fixture();
  try {
    const [source] = await f.service.collect({
      provider: "rss",
      url: "https://example.com/feed",
    });
    const original = create(f, {
      copyId: f.copy.id,
      sourceIds: [source.id],
      template: "resource",
      title: "原资料稿",
    });
    const changed = save(f, original, {
      copyId: null,
      sourceIds: [],
      template: "guide",
      title: "新用途稿",
    });
    const version = changed.article.versions[0];
    assert.equal(version.copyId, f.copy.id);
    assert.deepEqual(version.sourceIds, [source.id]);
    assert.equal(version.template, "resource");
    const restored = save(f, changed, {
      title: version.title,
      body: version.body,
      images: version.images.map((image) => ({
        ...image,
        storage: image.storage ?? "content-assets",
      })),
      copyId: version.copyId,
      sourceIds: version.sourceIds,
      template: version.template,
    });
    assert.equal(restored.article.revision, 3);
    assert.equal(restored.delivery.resourceUrl, f.copy.shareUrl);
    assert.equal(restored.sources[0].id, source.id);
    assert.equal(restored.article.template, "resource");
    assert.equal(restored.article.versions[1].copyId, null);
  } finally {
    f.close();
  }
});

test("配图校验期间资料入口变化，最终冻结内容与实际交接一致", async () => {
  const f = fixture();
  try {
    let code = "old7";
    f.deps.readShareCode = async () => code;
    const draft = create(f, {
      copyId: f.copy.id,
      title: "交接前资料变化",
      accountId: f.account.id,
    });
    const oldUrl = f.copy.shareUrl!;
    f.state.imageValidation = async () => {
      f.copy.shareUrl = "https://pan.quark.cn/s/newentry12345";
      code = "new8";
    };
    const withImage = save(f, draft, {
      images: [
        {
          file: "a".repeat(64) + ".png",
          sha256: "a".repeat(64),
          storage: "content-assets",
          name: "示例封面",
        },
      ],
    });
    await f.service.prepare({
      id: draft.article.id,
      revision: withImage.article.revision,
    });
    const detail = await f.service.deliveryDetail(draft.article.id);
    assert.equal(detail.delivery.resourceUrl, f.copy.shareUrl);
    assert.equal(detail.delivery.text, f.state.prepared!.text);
    assert.match(detail.delivery.text, /提取码：new8/);
    assert.ok(!detail.delivery.text.includes(oldUrl));
    assert.ok(!detail.delivery.text.includes("old7"));
    assert.equal(detail.article.preparedDelivery!.resourceUrl, f.copy.shareUrl);
  } finally {
    f.close();
  }
});
