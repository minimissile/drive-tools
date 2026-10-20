import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { csdnHandoff } from "../shared/csdn";
import { includesOwnShareLink } from "../shared/publication";
import { fixture } from "./helpers";
import type { BrowserBinding, Draft } from "../shared/types";
import type { SearchDetail, SearchPage, SearchTopic } from "../shared/search";

test("资源入口检查匹配本人分享，不把来源、相似ID、示例代码或图片当成交付入口", () => {
  const own = "https://pan.quark.cn/s/own123";
  assert.equal(includesOwnShareLink(`[获取资料](${own}?pwd=abcd)`, own), true);
  for (const body of [
    "https://github.com/lxgw/LxgwWenKai-Lite",
    "https://pan.quark.cn/s/source123",
    `${own}extra`,
    `https://pan.quark.cn.evil.example/s/own123`,
    `\`\`\`text\n${own}\n\`\`\``,
    `\`${own}\``,
    `<!-- ${own} -->`,
    `![图片](${own})`,
  ])
    assert.equal(includesOwnShareLink(body, own), false, body);
  assert.equal(includesOwnShareLink(own, null), false);
});

test("正文已有本人链接时导出如实标记入口，并继续核验渠道权限与分享", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    const draft = (await f.app.invoke("draft.manual", {
      copyId: saved.copyId,
      platform: "csdn",
      template: true,
    })) as Draft;
    const edited = (await f.app.invoke("draft.save", {
      id: draft.id,
      title: "字体资料",
      body: `[配套资料](${f.provider.ownUrl})`,
      tags: [],
      coverText: "",
    })) as Draft;
    await f.app.invoke("draft.review", { id: edited.id, reviewed: true });
    await assert.rejects(f.app.contentPackage(edited.id, null, false), {
      code: "CHANNEL_LINK_BLOCKED",
    });
    const binding = (await f.app.invoke("binding.save", {
      platform: "csdn",
      alias: "已核实场景",
      windowId: "test-window",
      editorUrl: "https://editor.csdn.net/md/",
      linkPermission: "allowed",
      ruleNote: "模拟已核实的配套资料引用场景。",
    })) as BrowserBinding;
    f.ports.chooseDirectory = async () => f.dir;
    const exported = (await f.app.invoke("publication.export", {
      draftId: edited.id,
      bindingId: binding.id,
      includeLink: false,
    })) as { folder: string };
    for (const file of ["内容信息.json", "CSDN发布字段.json"]) {
      const info = JSON.parse(
        await readFile(join(exported.folder, file), "utf8"),
      );
      assert.equal(info.includesOwnLink, true);
      assert.equal(info.published, false);
    }
    f.provider.ownValid = false;
    await assert.rejects(f.app.contentPackage(edited.id, binding.id, false), {
      code: "SHARE_INVALID",
    });
    assert.equal(f.app.repo.calls().length, 0);
  } finally {
    await f.cleanup();
  }
});

test("CSDN交付将标题、正文和标签分开，保留代码格式，摘要不混入代码或图片", () => {
  assert.equal(
    csdnHandoff({
      title: "字体",
      body: "用 `font_manager.fontManager.addfont` 注册。",
      tags: [],
    }).summary,
    "用 font_manager.fontManager.addfont 注册。",
  );
  const body =
    '## 安装\n\n示例使用 `Matplotlib` 绘制**中文**。参见[官方文档](https://matplotlib.org/)。\n\n```python\nprint("中文")\n```\n\n![实测图](./结果.png)';
  const result = csdnHandoff({
    title: "中文图表教程",
    body,
    tags: ["Python", "Python", "Matplotlib"],
  });
  assert.equal(result.body, body);
  assert.equal(result.markdown, `# 中文图表教程\n\n${body}\n`);
  assert.deepEqual(result.tags, ["Python", "Matplotlib"]);
  assert.equal(result.summary, "示例使用 Matplotlib 绘制中文。参见官方文档。");
  assert.equal(result.titleTooLong, false);
  assert.equal(
    csdnHandoff({
      title: "字".repeat(101),
      body: "```python\nprint(1)\n```\n\n正文",
      tags: [],
    }).titleTooLong,
    true,
  );
  assert.equal(
    csdnHandoff({
      title: "标题",
      body: "```python\nprint(1)\n```\n\n正文",
      tags: [],
    }).summary,
    "正文",
  );
});

test("CSDN导出沿用审阅与分享核验，Markdown和发布字段对应同一版本且不标记发布", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    const draft = (await f.app.invoke("draft.manual", {
      copyId: saved.copyId,
      platform: "csdn",
      template: true,
    })) as Draft;
    const body =
      '## 示例\n\n一份可运行的中文图表教程。\n\n```python\nprint("中文")\n```';
    const edited = (await f.app.invoke("draft.save", {
      id: draft.id,
      title: "中文图表教程",
      body,
      tags: ["Python", "Matplotlib"],
      coverText: "",
    })) as Draft;
    f.ports.chooseDirectory = async () => f.dir;
    const args = { draftId: edited.id, bindingId: null, includeLink: false };
    await assert.rejects(f.app.invoke("publication.export", args), {
      code: "REVIEW_REQUIRED",
    });
    await f.app.invoke("draft.review", { id: edited.id, reviewed: true });
    const pack = await f.app.contentPackage(edited.id, null, false);
    assert.equal(pack.body, body);
    assert.doesNotMatch(pack.body, /source123|own123/);
    const result = (await f.app.invoke("publication.export", args)) as {
      folder: string;
    };
    assert.equal(
      await readFile(join(result.folder, "文章.md"), "utf8"),
      `# 中文图表教程\n\n${body}\n`,
    );
    const fields = JSON.parse(
      await readFile(join(result.folder, "CSDN发布字段.json"), "utf8"),
    );
    assert.equal(fields.title, edited.title);
    assert.deepEqual(fields.tags, edited.tags);
    assert.equal(fields.summarySuggestion, "一份可运行的中文图表教程。");
    assert.equal(fields.published, false);
    assert.equal(f.app.snapshot().publications.length, 0);
    const info = JSON.parse(
      await readFile(join(result.folder, "内容信息.json"), "utf8"),
    );
    assert.equal(info.draftId, edited.id);
    assert.equal(info.draftVersion, edited.version);
    f.provider.ownValid = false;
    await assert.rejects(f.app.invoke("publication.export", args), {
      code: "SHARE_INVALID",
    });
  } finally {
    await f.cleanup();
  }
});

test("发文待审核记录可恢复并原位确认发布，重复回填不增行、不提前计入效果", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    const topic = (await f.app.invoke("search.create", {
      keyword: "Matplotlib 中文图表",
      platform: "csdn",
      copyId: saved.copyId,
    })) as SearchTopic;
    const draft = (await f.app.invoke("search.write", {
      id: topic.id,
    })) as Draft;
    await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
    const binding = (await f.app.invoke("binding.save", {
      platform: "csdn",
      alias: "本人测试账号",
      windowId: "test-window",
      editorUrl: "https://editor.csdn.net/md/",
      linkPermission: "none",
      ruleNote: "",
    })) as BrowserBinding;
    f.app.bit.open = async (b) => ({ opened: true, url: b.editorUrl });
    const input = {
      draftId: draft.id,
      bindingId: binding.id,
      url: "https://blog.csdn.net/test/article/details/123",
      status: "submitted",
    };
    await assert.rejects(f.app.invoke("publication.mark", input), {
      code: "EDITOR_NOT_OPENED",
    });
    await f.app.invoke("publication.open", input);
    await f.app.invoke("publication.mark", input);
    await f.app.invoke("publication.mark", input);
    const pending = f.app
      .snapshot()
      .publications.filter((p) => p.status !== "opened");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "submitted");
    assert.equal(pending[0].url, input.url);
    assert.equal(
      f.app.db.get<{ status: string }>(
        "SELECT status FROM publications WHERE id=?",
        pending[0].id,
      )?.status,
      "submitted",
    );
    assert.equal(
      ((await f.app.invoke("search.get", { id: topic.id })) as SearchDetail)
        .publications.length,
      0,
    );
    assert.equal(
      ((await f.app.invoke("search.list", {})) as SearchPage).counts.published,
      0,
    );
    await f.app.invoke("publication.mark", { ...input, status: "published" });
    await f.app.invoke("publication.mark", { ...input, status: "published" });
    const published = f.app
      .snapshot()
      .publications.filter((p) => p.status !== "opened");
    assert.equal(published.length, 1);
    assert.equal(published[0].id, pending[0].id);
    assert.equal(published[0].status, "published");
    assert.equal(
      ((await f.app.invoke("search.get", { id: topic.id })) as SearchDetail)
        .publications.length,
      1,
    );
    await assert.rejects(f.app.invoke("publication.mark", input), {
      code: "PUBLICATION_ALREADY_PUBLISHED",
    });
    await assert.rejects(
      f.app.invoke("publication.mark", {
        ...input,
        url: "https://example.com/article/123",
      }),
      { code: "INVALID_PUBLICATION_URL" },
    );
    assert.equal(f.app.repo.calls().length, 0);
  } finally {
    await f.cleanup();
  }
});
