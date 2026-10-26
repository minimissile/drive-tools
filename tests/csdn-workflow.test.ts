import test from "node:test";
import assert from "node:assert/strict";
import { csdnFixture } from "./csdn-fixture";
import { editorValueForDraft } from "../shared/studio";
import {
  csdnPublicationIssue,
  type CsdnWorkflowDetail,
} from "../shared/csdn-workflow";
import { CsdnWorkflows } from "../core/csdn/workflow";
import { isCsdnPublishRequest } from "../core/csdn/editor";
import type { Draft } from "../shared/types";

test("CSDN 本地选词保留来源和指标，资料匹配只返回已核验本人副本", async () => {
  const f = await csdnFixture();
  try {
    await f.app.invoke("pool.save", {
      name: "字体需求词",
      resourceId: f.saved.resourceId,
      keywords: [
        {
          id: "mock-word",
          word: "Matplotlib 中文乱码",
          source: "手工",
          platform: "baidu",
          metrics: { index: 0 },
          intent: "排错",
          sourceUpdatedAt: null,
          fetchedAt: new Date().toISOString(),
        },
      ],
    });
    const words = f.app.csdn.words({ query: "Matplotlib" });
    assert.equal(words.length, 1);
    assert.match(words[0].source, /字体需求词/);
    assert.deepEqual(words[0].metrics, { index: 0 });
    const matches = f.app.csdn.matches({ keyword: "Matplotlib 中文乱码" });
    assert.equal(matches[0].copyId, f.saved.copyId);
    assert.ok(matches[0].matchedTerms.includes("matplotlib"));
    f.app.db.run(
      "UPDATE copies SET share_verified_at=NULL WHERE id=?",
      f.saved.copyId,
    );
    assert.deepEqual(f.app.csdn.matches({ keyword: "Matplotlib" }), []);
    assert.equal(f.generated.length, 0);
    assert.equal(f.submitted, 0);
  } finally {
    await f.cleanup();
  }
});

test("CSDN 单篇完整链路复用 AI 台账、草稿版本、审阅、本人链接和发布记录", async () => {
  const f = await csdnFixture();
  try {
    const created = await f.create();
    assert.equal(created.run.stage, "configured");
    assert.equal(f.generated.length, 0);
    assert.equal((await f.create()).run.id, created.run.id);
    const generated = (await f.app.invoke("csdn.generate", {
      id: created.run.id,
    })) as CsdnWorkflowDetail;
    assert.equal(generated.run.stage, "review");
    assert.equal(generated.draft!.topicId, created.run.topicId);
    assert.equal(generated.draft!.reviewed, false);
    assert.equal(f.generated.length, 1);
    assert.equal(
      f.app.repo.calls().filter((call) => call.endpoint === "openrouter")
        .length,
      1,
    );
    await f.configure(created.run.id);
    const unreviewed = (await f.app.invoke("csdn.prepare", {
      id: created.run.id,
    })) as CsdnWorkflowDetail;
    assert.equal(unreviewed.run.stage, "attention");
    assert.equal(f.prepared.length, 0);
    const edited = (await f.app.invoke("draft.save", {
      id: generated.draft!.id,
      title: generated.draft!.title,
      body: generated.draft!.body + "\n\n已补充本人操作核对记录。",
      tags: generated.draft!.tags,
      coverText: "",
    })) as Draft;
    await f.app.invoke("csdn.attachDraft", {
      id: created.run.id,
      draftId: edited.id,
    });
    await f.app.invoke("draft.review", { id: edited.id, reviewed: true });
    const ready = (await f.app.invoke("csdn.prepare", {
      id: created.run.id,
    })) as CsdnWorkflowDetail;
    assert.equal(ready.run.stage, "ready", ready.run.message);
    assert.equal(ready.draft!.version, 2);
    assert.match(f.prepared[0].body, /https:\/\/pan\.quark\.cn\/s\/own123/);
    assert.doesNotMatch(f.prepared[0].body, /source123/);
    assert.equal(f.prepared[0].aiAssisted, true);
    await assert.rejects(
      f.app.invoke("csdn.submit", { id: ready.run.id }),
      /Invalid input/,
    );
    const result = (await f.app.invoke("csdn.submit", {
      id: ready.run.id,
      confirmed: true,
    })) as CsdnWorkflowDetail;
    assert.equal(result.run.stage, "submitted", result.run.message);
    assert.equal(f.submitted, 1);
    assert.equal(
      f.app.snapshot().publications.filter((p) => p.status === "submitted")
        .length,
      1,
    );
    await assert.rejects(
      f.app.invoke("csdn.submit", { id: ready.run.id, confirmed: true }),
      { code: "CSDN_PREPARE_REQUIRED" },
    );
    assert.equal(f.submitted, 1);
    const published = (await f.app.invoke("csdn.resolve", {
      id: ready.run.id,
      url: result.run.url,
      result: "published",
      confirmed: true,
    })) as CsdnWorkflowDetail;
    assert.equal(published.run.stage, "published");
    assert.equal(f.app.search.get(created.run.topicId).publications.length, 1);
    assert.ok(f.app.db.get("SELECT publication_id FROM publication_targets"));
  } finally {
    await f.cleanup();
  }
});

test("CSDN 生成前实时核验分享，失效时不调用模型；本人已有资料可复用自身分享", async () => {
  const f = await csdnFixture();
  try {
    const created = await f.create();
    f.provider.ownValid = false;
    const blocked = (await f.app.invoke("csdn.generate", {
      id: created.run.id,
    })) as CsdnWorkflowDetail;
    assert.equal(blocked.run.stage, "attention");
    assert.equal(f.generated.length, 0);
    f.provider.ownValid = true;
    await f.app.invoke("copies.check", { copyIds: [f.saved.copyId] });
    f.app.db.run(
      "UPDATE resources SET source_url=?,source_kind='owned' WHERE id=?",
      f.provider.ownUrl,
      f.saved.resourceId,
    );
    assert.equal(
      f.app.csdn.matches({ keyword: "Matplotlib" })[0].copyId,
      f.saved.copyId,
    );
    const generated = (await f.app.invoke("csdn.generate", {
      id: created.run.id,
    })) as CsdnWorkflowDetail;
    assert.equal(generated.run.stage, "review", generated.run.message);
    assert.equal(f.generated.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("CSDN 最终点击前再核验本地版本与分享，填写后变化不会发出请求", async () => {
  const f = await csdnFixture();
  try {
    const ready = await f.ready();
    let clicked = false;
    f.app.csdnEditor.submit = async (_binding, payload, before) => {
      f.app.db.run(
        "UPDATE copies SET share_version=share_version+1 WHERE id=?",
        f.saved.copyId,
      );
      await before();
      clicked = true;
      return {
        status: "submitted",
        url: `https://blog.csdn.net/${payload.author}/article/details/123`,
      };
    };
    const result = (await f.app.invoke("csdn.submit", {
      id: ready.run.id,
      confirmed: true,
    })) as CsdnWorkflowDetail;
    assert.equal(result.run.stage, "attention");
    assert.match(result.run.message, /更新|变化/);
    assert.equal(clicked, false);
  } finally {
    await f.cleanup();
  }
});

test("CSDN 暂存编辑、过期草稿和失效分享都在触及发布窗口前阻止交付", async () => {
  const f = await csdnFixture();
  try {
    const ready = await f.ready();
    assert.equal(ready.run.stage, "ready", ready.run.message);
    const draft = ready.draft!;
    await f.app.invoke("studio.workingSave", {
      draftId: draft.id,
      editedAt: Date.now(),
      value: { ...editorValueForDraft(draft), body: "尚未保存的另一段内容" },
    });
    const blocked = (await f.app.invoke("csdn.prepare", {
      id: ready.run.id,
    })) as CsdnWorkflowDetail;
    assert.equal(blocked.run.stage, "attention");
    assert.match(blocked.run.message, /未保存|编辑/);
    assert.equal(f.prepared.length, 1);
    await f.app.invoke("studio.workingClear", { draftId: draft.id });
    f.app.db.run(
      "UPDATE copies SET share_version=share_version+1 WHERE id=?",
      f.saved.copyId,
    );
    const stale = (await f.app.invoke("csdn.prepare", {
      id: ready.run.id,
    })) as CsdnWorkflowDetail;
    assert.match(stale.run.message, /更新|审阅/);
    await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
    f.provider.ownValid = false;
    const invalid = (await f.app.invoke("csdn.prepare", {
      id: ready.run.id,
    })) as CsdnWorkflowDetail;
    assert.match(invalid.run.message, /分享有效性/);
    assert.equal(f.prepared.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("CSDN 改动发布设置撤销填写状态，无资料入口时不能自动提交", async () => {
  const f = await csdnFixture();
  try {
    const ready = await f.ready();
    await f.configure(ready.run.id, false);
    await assert.rejects(
      f.app.invoke("csdn.submit", { id: ready.run.id, confirmed: true }),
      { code: "CSDN_PREPARE_REQUIRED" },
    );
    const noLink = (await f.app.invoke("csdn.prepare", {
      id: ready.run.id,
    })) as CsdnWorkflowDetail;
    assert.match(noLink.run.message, /本人资料入口/);
    assert.equal(f.submitted, 0);
    await f.configure(ready.run.id);
    await f.app.invoke("csdn.prepare", { id: ready.run.id });
    f.app.db.run(
      "UPDATE browser_bindings SET window_id='changed-window' WHERE id=?",
      f.binding.id,
    );
    const changed = (await f.app.invoke("csdn.submit", {
      id: ready.run.id,
      confirmed: true,
    })) as CsdnWorkflowDetail;
    assert.equal(changed.run.stage, "attention");
    assert.match(changed.run.message, /变化/);
    assert.equal(f.submitted, 0);
  } finally {
    await f.cleanup();
  }
});

test("CSDN 提交响应丢失保留未知状态，重试被拦截，人工登记后不重发", async () => {
  const f = await csdnFixture();
  try {
    const ready = await f.ready();
    let clicks = 0;
    f.app.csdnEditor.submit = async (_b, _p, before) => {
      await before();
      clicks++;
      throw Error("回执丢失");
    };
    const unknown = (await f.app.invoke("csdn.submit", {
      id: ready.run.id,
      confirmed: true,
    })) as CsdnWorkflowDetail;
    assert.equal(unknown.run.stage, "uncertain");
    await assert.rejects(f.app.invoke("csdn.prepare", { id: ready.run.id }), {
      code: "CSDN_RESULT_EXISTS",
    });
    await assert.rejects(
      f.app.invoke("csdn.submit", { id: ready.run.id, confirmed: true }),
      { code: "CSDN_PREPARE_REQUIRED" },
    );
    await assert.rejects(
      f.app.invoke("csdn.resolve", {
        id: ready.run.id,
        result: "submitted",
        url: "https://blog.csdn.net/another/article/details/123",
        confirmed: true,
      }),
      { code: "CSDN_RECEIPT_MISMATCH" },
    );
    const url = "https://blog.csdn.net/qa_author/article/details/123";
    await f.app.invoke("csdn.resolve", {
      id: ready.run.id,
      result: "submitted",
      url,
      confirmed: true,
    });
    await f.app.invoke("csdn.resolve", {
      id: ready.run.id,
      result: "submitted",
      url,
      confirmed: true,
    });
    assert.equal(
      f.app.snapshot().publications.filter((p) => p.status === "submitted")
        .length,
      1,
    );
    assert.equal(clicks, 1);
  } finally {
    await f.cleanup();
  }
});

test("CSDN 明确拒绝与点击前异常允许修正，未知结果须显式确认未提交", async () => {
  const f = await csdnFixture();
  try {
    const ready = await f.ready();
    f.app.csdnEditor.submit = async () => {
      throw Error("账号不一致，未点击提交");
    };
    const beforeClick = (await f.app.invoke("csdn.submit", {
      id: ready.run.id,
      confirmed: true,
    })) as CsdnWorkflowDetail;
    assert.equal(beforeClick.run.stage, "attention");
    await f.app.invoke("csdn.prepare", { id: ready.run.id });
    f.app.csdnEditor.submit = async (_b, _p, before) => {
      await before();
      return { status: "rejected", message: "平台拒绝" };
    };
    const rejected = (await f.app.invoke("csdn.submit", {
      id: ready.run.id,
      confirmed: true,
    })) as CsdnWorkflowDetail;
    assert.equal(rejected.run.stage, "attention");
    await f.app.invoke("csdn.prepare", { id: ready.run.id });
    f.app.csdnEditor.submit = async (_b, _p, before) => {
      await before();
      throw Error("超时");
    };
    await f.app.invoke("csdn.submit", { id: ready.run.id, confirmed: true });
    await assert.rejects(
      f.app.invoke("csdn.resolve", {
        id: ready.run.id,
        result: "not_submitted",
        url: "",
      }),
      /Invalid input/,
    );
    const resolved = (await f.app.invoke("csdn.resolve", {
      id: ready.run.id,
      result: "not_submitted",
      url: "",
      confirmed: true,
    })) as CsdnWorkflowDetail;
    assert.equal(resolved.run.stage, "review");
    assert.equal(resolved.run.prepared, null);
  } finally {
    await f.cleanup();
  }
});

test("CSDN 同一比特窗口串行操作，重启撤销填写状态并暂停未知提交", async () => {
  const f = await csdnFixture();
  try {
    const first = await f.ready();
    const second = await f.generate("Matplotlib 项目内注册字体");
    await f.app.invoke("draft.review", {
      id: second.draft!.id,
      reviewed: true,
    });
    await f.configure(second.run.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.app.csdnEditor.prepare = async () => gate;
    const inProgress = f.app.invoke("csdn.prepare", { id: first.run.id });
    await assert.rejects(f.app.invoke("csdn.prepare", { id: second.run.id }), {
      code: "CSDN_WINDOW_BUSY",
    });
    release();
    await inProgress;
    const interrupted = f.app.csdn.get(second.run.id).run;
    interrupted.stage = "submitting";
    f.app.db.setSetting(`csdnWorkflow:v1:${interrupted.id}`, interrupted);
    const restarted = new CsdnWorkflows({
      repo: f.app.repo,
      search: f.app.search,
      ai: f.app.ai,
      editor: f.app.csdnEditor,
      verifyTarget: async () => {
        throw Error("重启不核验远端");
      },
      contentPackage: () => {
        throw Error("重启不调用远端");
      },
      record: async () => {
        throw Error("重启不发布");
      },
      changed: () => {},
    });
    assert.equal(restarted.get(first.run.id).run.stage, "attention");
    assert.equal(restarted.get(second.run.id).run.stage, "uncertain");
    assert.equal(restarted.get(first.run.id).run.prepared, null);
    assert.equal(f.generated.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("CSDN 只识别官方实际发布回执，排除草稿保存及相似域名", () => {
  const request = (url: string, pubStatus: string) => ({
    url: () => url,
    method: () => "POST",
    postDataJSON: () => ({ pubStatus }),
  });
  const url =
    "https://bizapi.csdn.net/blog-console-api/v3/mdeditor/saveArticle";
  assert.equal(isCsdnPublishRequest(request(url, "publish")), true);
  assert.equal(isCsdnPublishRequest(request(url, "draft")), false);
  assert.equal(
    isCsdnPublishRequest(
      request(
        url.replace("bizapi.csdn.net", "bizapi.csdn.net.evil.test"),
        "publish",
      ),
    ),
    false,
  );
  assert.equal(
    csdnPublicationIssue({
      title: "太短",
      body: "正文",
      tags: ["Python"],
    })?.includes("5–100"),
    true,
  );
  assert.match(
    csdnPublicationIssue({
      title: "完整的教程标题",
      body: "【请填写实际步骤】",
      tags: ["Python"],
    })!,
    /占位/,
  );
  assert.match(
    csdnPublicationIssue({
      title: "完整的教程标题",
      body: "![实测图](./demo.png)",
      tags: ["Python"],
    })!,
    /图片/,
  );
});
