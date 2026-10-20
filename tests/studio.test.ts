import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, removeV9, currentSchemaVersion } from "./helpers";
import { Database } from "../core/database";
import { AiService } from "../core/ai";
import { StudioService } from "../core/studio";
import { inspectBackup, stageRestore, fileHash } from "../core/backups";
import { AppError } from "../core/errors";
import type { Draft } from "../shared/types";
import type { StudioJob, CreativePackage } from "../shared/studio";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF2sAAAAASUVORK5CYII=";
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(12),
]);
async function setup() {
  const f = await fixture(),
    saved = await f.add(true, {
      title: "英语课堂资料",
      summary:
        "已整理的口语练习主题。 https://pan.quark.cn/s/private 提取码：abcd",
    });
  await f.app.queue.execute(saved.jobId);
  await f.app.secrets.set("openrouter", "test-studio-private-key");
  f.app.db.setSetting("model", "qa/text");
  f.app.db.setSetting("dailyAiBudgetMicros", 20_000_000);
  f.app.db.setSetting("modelCatalog", [
    {
      id: "qa/text",
      structured: true,
      promptPrice: 0.0000001,
      completionPrice: 0.0000001,
    },
  ]);
  const qa = {
    posts: 0,
    polls: 0,
    downloads: 0,
    texts: 0,
    invalid: false,
    timeout: false,
    downloadFail: false,
    keyEcho: false,
    missingId: false,
    irrelevantContent: false,
    missingCards: false,
    payloads: [] as any[],
  };
  const request = async (
    url: string,
    init?: RequestInit,
  ): Promise<Record<string, any>> => {
    if (url.endsWith("/images/models"))
      return {
        data: [
          {
            id: "qa/image",
            name: "测试图片",
            supported_parameters: {
              aspect_ratio: { values: ["3:4", "9:16"] },
              input_references: { max: 1 },
            },
          },
        ],
      };
    if (url.endsWith("/videos/models"))
      return {
        data: [
          {
            id: "qa/video",
            name: "测试动态视频",
            supported_aspect_ratios: ["9:16"],
            supported_durations: [8],
            supported_resolutions: ["720p"],
            generate_audio: true,
            supported_frame_images: ["first_frame"],
            pricing_skus: { "per-video-second": "0.1" },
          },
        ],
      };
    if (url.endsWith("/images/models/qa/image/endpoints"))
      return {
        endpoints: [
          {
            pricing: [
              { billable: "output_image", unit: "image", cost_usd: 0.02 },
            ],
          },
        ],
      };
    if (init?.method === "POST") {
      qa.posts++;
      qa.payloads.push(JSON.parse(String(init.body)));
      await new Promise((r) => setTimeout(r, 5));
      if (qa.timeout) throw new Error("response lost");
      if (qa.keyEcho)
        throw new AppError("MEDIA_REJECTED", "refused test-studio-private-key");
      if (url.endsWith("/images"))
        return {
          data: qa.invalid ? [] : [{ b64_json: png }],
          usage: { cost: 0.02 },
        };
      return {
        id: qa.missingId ? undefined : "remote-test",
        status: "pending",
      };
    }
    qa.polls++;
    return {
      id: "remote-test",
      status: "completed",
      unsigned_urls: ["https://evil.invalid/private"],
      usage: { cost: 0.8 },
    };
  };
  const fetchBinary: typeof fetch = async (url, init) => {
    qa.downloads++;
    assert.equal(
      String(url),
      "https://openrouter.ai/api/v1/videos/remote-test/content?index=0",
    );
    assert.match(JSON.stringify(init?.headers), /test-studio-private-key/);
    if (qa.downloadFail) throw new Error("download interrupted");
    return new Response(new Uint8Array(mp4), {
      headers: { "Content-Type": "video/mp4" },
    });
  };
  Object.assign(f.app.studio, { request, fetchBinary });
  const ai = new AiService(
    f.app.repo,
    f.app.secrets,
    () => {},
    async (_url, init) => {
      qa.texts++;
      const payload = JSON.parse(String(init?.body)),
        input = JSON.parse(payload.messages[1].content);
      qa.payloads.push(input);
      assert.doesNotMatch(
        payload.messages[1].content,
        /source123|private|abcd|test-studio-private-key/,
      );
      return {
        usage: { cost: 0.001 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "英语课堂练习",
                body: qa.irrelevantContent
                  ? "依据已记录的口语练习主题。<br><br/>整理备课要点。"
                  : "依据已记录的口语练习主题整理备课要点。",
                tags: ["英语"],
                coverText: "口语练习",
                cards: Array.from(
                  {
                    length: qa.missingCards
                      ? 0
                      : qa.irrelevantContent &&
                          ["text", "video"].includes(input.format)
                        ? 1
                        : input.pageCount,
                  },
                  (_, i) => ({
                    heading: `教学要点${i + 1}`,
                    copy: "根据课堂目标选择资料",
                    imagePrompt: "自然光下的课堂主题概念插图，绿色点缀",
                  }),
                ),
                videoPrompt:
                  input.format === "video" || qa.irrelevantContent
                    ? "镜头缓慢推进教室，纸页翻动，学生在白板前练习对话。"
                    : "",
                voiceover:
                  input.format === "video" || qa.irrelevantContent
                    ? "先选择口语主题，再安排课堂练习。"
                    : "",
              }),
            },
          },
        ],
      };
    },
  );
  f.app.ai.creativeDraft = ai.creativeDraft.bind(ai);
  await f.app.invoke("studio.models");
  const create = async (
    format: CreativePackage["format"] = "image",
    mode = "template",
    extra = {},
  ) =>
    f.app.invoke("studio.create", {
      copyId: saved.copyId,
      platform: "xiaohongshu",
      format,
      mode,
      templateId: "resource-guide",
      aspectRatio: format === "video" ? "9:16" : "3:4",
      pageCount: 3,
      ...extra,
    }) as Promise<Draft>;
  const submit = (draft: Draft, extra = {}) =>
    f.app.invoke("studio.submit", {
      draftId: draft.id,
      kind: draft.creative!.format === "video" ? "video" : "image",
      model: draft.creative!.format === "video" ? "qa/video" : "qa/image",
      reserveMicros: 1_000_000,
      ...extra,
    }) as Promise<StudioJob>;
  const clearThrottle = (id: string) =>
    f.app.db.run(
      "UPDATE studio_jobs SET data=json_set(data,'$.checkedAt',NULL) WHERE id=?",
      id,
    );
  return {
    ...f,
    saved,
    qa,
    create,
    submit,
    request,
    fetchBinary,
    clearThrottle,
  };
}
test("templates can be selected and customized; AI creates grounded text, image, carousel and motion plans", async () => {
  const f = await setup();
  try {
    const templates = (await f.app.invoke("studio.templates")) as any[];
    assert.equal(templates.length, 6);
    const custom = (await f.app.invoke("studio.templateSave", {
      name: "英语教师清单",
      description: "按课堂任务组织",
      style: "绿色清单",
      instruction: "先列课堂目标，再列资料用途",
    })) as any;
    for (const format of ["text", "image", "carousel", "video"] as const) {
      const d = await f.create(format, "ai", { templateId: custom.id });
      assert.equal(d.creative!.format, format);
      assert.equal(
        d.creative!.cards.length,
        format === "image" ? 1 : format === "carousel" ? 3 : 0,
      );
      assert.equal(d.reviewed, false);
    }
    assert.equal(f.qa.texts, 4);
    assert.ok(
      f.qa.payloads.some((p) => p.template?.instruction.includes("课堂目标")),
    );
    await f.app.invoke("studio.templateDelete", { id: custom.id });
    assert.equal(((await f.app.invoke("studio.templates")) as any[]).length, 6);
    await assert.rejects(
      f.app.invoke("studio.templateSave", {
        id: "resource-guide",
        name: "覆盖",
        style: "a",
        instruction: "b",
      }),
      { code: "TEMPLATE_NOT_FOUND" },
    );
  } finally {
    await f.cleanup();
  }
});
test("text keeps usable prose despite extra model media fields; required image plans still fail closed", async () => {
  const f = await setup();
  try {
    f.qa.irrelevantContent = true;
    const text = await f.create("text", "ai");
    assert.match(text.body, /口语练习/);
    assert.match(text.body, /主题。\n\n整理备课要点/);
    assert.doesNotMatch(text.body, /<br/i);
    assert.match(text.body, /教学要点1\n根据课堂目标选择资料/);
    assert.doesNotMatch(text.body, /自然光|镜头缓慢/);
    assert.deepEqual(text.creative!.cards, []);
    assert.equal(text.creative!.videoPrompt, "");
    assert.equal(text.creative!.voiceover, "");
    const video = await f.create("video", "ai");
    assert.deepEqual(video.creative!.cards, []);
    assert.match(video.creative!.videoPrompt, /镜头/);
    f.qa.missingCards = true;
    await assert.rejects(f.create("carousel", "ai"), {
      code: "CREATIVE_PLAN_INVALID",
    });
    assert.equal(f.qa.texts, 3);
    assert.equal(f.qa.posts, 0);
  } finally {
    await f.cleanup();
  }
});
test("image generation deduplicates submissions, saves actual PNG and blocks review until every carousel slot is ready", async () => {
  const f = await setup();
  try {
    f.app.db.setSetting("aiModels", { image: "qa/image" });
    f.app.db.setSetting(
      "studio:modelCatalog",
      f.app.db
        .setting<any[]>("studio:modelCatalog", [])
        .map((m) => ({ ...m, qualities: m.kind === "image" ? ["high"] : [] })),
    );
    const d = await f.create("carousel");
    await assert.rejects(
      f.app.invoke("draft.review", { id: d.id, reviewed: true }),
      { code: "MEDIA_INCOMPLETE" },
    );
    const [a, b] = await Promise.all([f.submit(d, { model: "" }), f.submit(d)]);
    assert.equal(a.id, b.id);
    assert.equal(f.qa.posts, 1);
    assert.equal(f.qa.payloads.at(-1).model, "qa/image");
    assert.equal(f.qa.payloads.at(-1).quality, "high");
    assert.equal(a.status, "completed");
    const path = await f.app.studio.assetPath(`${a.asset}.png`);
    assert.equal(await fileHash(path), a.asset);
    assert.equal(
      (await readFile(path)).subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
    );
    await f.submit(d, { slot: 1 });
    await f.submit(d, { slot: 2 });
    await f.app.invoke("draft.review", { id: d.id, reviewed: true });
    assert.equal(f.app.repo.draft(d.id).reviewed, true);
    await f.submit(d);
    assert.equal(f.qa.posts, 3);
    assert.equal(f.app.repo.draft(d.id).reviewed, true);
    const folder = join(f.dir, "exports");
    await mkdir(folder);
    f.ports.chooseDirectory = async () => folder;
    const result = (await f.app.invoke("publication.export", {
      draftId: d.id,
      bindingId: null,
      includeLink: false,
    })) as { folder: string };
    assert.equal(
      (await readdir(result.folder)).filter((n) => n.endsWith(".png")).length,
      3,
    );
    assert.ok((await readdir(result.folder)).includes("创意方案.json"));
    assert.doesNotMatch(
      await readFile(join(result.folder, "发布文案.txt"), "utf8"),
      /source123|private|提取码/,
    );
  } finally {
    await f.cleanup();
  }
});
test("edited versions retain unchanged media only; changed page text or prompts require regeneration", async () => {
  const f = await setup();
  try {
    const d = await f.create();
    await f.submit(d);
    const unchanged = (await f.app.invoke("draft.save", {
      id: d.id,
      title: d.title,
      body: d.body + "\n人工补充",
      tags: d.tags,
      coverText: d.coverText,
      creative: d.creative,
    })) as Draft;
    assert.equal(f.app.studio.readyAssets(unchanged.id).length, 1);
    assert.equal(f.qa.posts, 1);
    const imageOnly = (await f.app.invoke("draft.save", {
      id: d.id,
      title: d.title,
      body: "",
      tags: [],
      coverText: d.coverText,
      creative: d.creative,
    })) as Draft;
    await f.app.invoke("draft.review", { id: imageOnly.id, reviewed: true });
    assert.equal(f.app.repo.draft(imageOnly.id).reviewed, true);
    const creative = {
      ...unchanged.creative!,
      cards: unchanged.creative!.cards.map((c) => ({
        ...c,
        copy: "新的课堂文字",
      })),
    };
    const changed = (await f.app.invoke("draft.save", {
      id: unchanged.id,
      title: d.title,
      body: d.body,
      tags: d.tags,
      coverText: d.coverText,
      creative,
    })) as Draft;
    assert.equal(f.app.studio.jobs(changed.id).length, 0);
    assert.throws(() => f.app.studio.readyAssets(changed.id), {
      code: "MEDIA_INCOMPLETE",
    });
    assert.equal(f.app.studio.jobs(d.id).length, 1);
  } finally {
    await f.cleanup();
  }
});
test("video persists remote ID across restart, queries without duplicate creation and retries only downloading", async () => {
  const f = await setup();
  try {
    const d = await f.create("video"),
      j = await f.submit(d, { audio: true });
    assert.equal(j.remoteId, "remote-test");
    assert.equal(j.status, "pending");
    const restarted = new StudioService(
      f.app.repo,
      f.app.secrets,
      f.app.ai,
      f.dir,
      (b) => Promise.resolve(b),
      () => {},
      f.request,
      f.fetchBinary,
    );
    assert.equal(restarted.jobs(d.id)[0].remoteId, "remote-test");
    await f.submit(d);
    assert.equal(f.qa.posts, 1);
    f.qa.downloadFail = true;
    let polled = await restarted.poll(j.id);
    assert.equal(polled.status, "download_failed");
    assert.equal(polled.costMicros, 800000);
    f.clearThrottle(j.id);
    f.qa.downloadFail = false;
    const [a, b] = await Promise.all([
      restarted.poll(j.id),
      restarted.poll(j.id),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(a.status, "completed");
    assert.equal(f.qa.posts, 1);
    assert.equal(f.qa.polls, 2);
    assert.equal(f.qa.downloads, 2);
    assert.equal(
      (await readFile(await restarted.assetPath(`${a.asset}.mp4`))).toString(
        "ascii",
        4,
        8,
      ),
      "ftyp",
    );
    await f.app.invoke("draft.review", { id: d.id, reviewed: true });
    const payload = f.qa.payloads[0];
    assert.equal(payload.generate_audio, true);
    assert.equal(payload.duration, 8);
  } finally {
    await f.cleanup();
  }
});
test("uncertain response never auto-resubmits; explicit replacement preserves fee history and can be reviewed", async () => {
  const f = await setup();
  try {
    const d = await f.create();
    f.qa.timeout = true;
    const a = await f.submit(d);
    assert.equal(a.status, "uncertain");
    await f.submit(d);
    assert.equal(f.qa.posts, 1);
    assert.throws(() => f.app.studio.readyAssets(d.id), {
      code: "MEDIA_INCOMPLETE",
    });
    f.qa.timeout = false;
    const b = await f.submit(d, { regenerate: true });
    assert.equal(b.status, "completed");
    assert.equal(f.qa.posts, 2);
    assert.equal(f.app.studio.jobs(d.id)[0].superseded, true);
    assert.equal(f.app.studio.readyAssets(d.id).length, 1);
    assert.equal(
      f.app.repo.calls().filter((c) => c.phase === "studio_image").length,
      2,
    );
    assert.ok(f.app.repo.calls().some((c) => c.status === "uncertain"));
  } finally {
    await f.cleanup();
  }
});
test("saving text while video is queued reuses its persisted remote job in the new version", async () => {
  const f = await setup();
  try {
    const d = await f.create("video"),
      job = await f.submit(d);
    const newer = (await f.app.invoke("draft.save", {
      id: d.id,
      title: d.title,
      body: d.body + "\n新的介绍",
      tags: d.tags,
      coverText: d.coverText,
      creative: d.creative,
    })) as Draft;
    const copied = f.app.studio.jobs(newer.id)[0];
    assert.equal(copied.remoteId, job.remoteId);
    assert.equal(copied.callId, job.callId);
    await f.submit(newer);
    assert.equal(f.qa.posts, 1);
    const result = await f.app.studio.poll(copied.id);
    assert.equal(result.status, "completed");
    assert.equal(f.app.studio.readyAssets(newer.id).length, 1);
    assert.equal(f.qa.posts, 1);
  } finally {
    await f.cleanup();
  }
});
test("budgets, model capabilities and changed keys prevent requests; malformed output retains actual fee", async () => {
  const f = await setup();
  try {
    const d = await f.create("video");
    await assert.rejects(f.submit(d, { duration: 7 }), {
      code: "MEDIA_CAPABILITY_MISMATCH",
    });
    assert.equal(f.qa.posts, 0);
    f.app.db.setSetting("dailyAiBudgetMicros", 0);
    await assert.rejects(f.submit(d), { code: "AI_BUDGET_EXCEEDED" });
    assert.equal(f.qa.posts, 0);
    f.app.db.setSetting("dailyAiBudgetMicros", 20_000_000);
    const video = await f.submit(d);
    await f.app.secrets.set("openrouter", "different-key");
    await assert.rejects(f.app.studio.poll(video.id), {
      code: "MEDIA_KEY_CHANGED",
    });
    assert.equal(f.qa.polls, 0);
    await f.app.secrets.set("openrouter", "test-studio-private-key");
    const image = await f.create();
    f.qa.invalid = true;
    const bad = await f.submit(image);
    assert.equal(bad.status, "failed");
    assert.equal(bad.costMicros, 20000);
    assert.equal(bad.asset, null);
    assert.equal(
      f.app.repo.calls().find((c) => c.id === bad.callId)!.confirmedMicros,
      20000,
    );
    f.qa.invalid = false;
    f.qa.keyEcho = true;
    const rejected = await f.submit(image, { regenerate: true });
    assert.doesNotMatch(JSON.stringify(rejected), /test-studio-private-key/);
  } finally {
    await f.cleanup();
  }
});
test("backup and restore include generated media with hashes and templates; tampering is rejected", async () => {
  const f = await setup();
  try {
    const d = await f.create(),
      job = await f.submit(d);
    await f.app.invoke("studio.templateSave", {
      name: "我的模板",
      description: "",
      style: "白底",
      instruction: "先给要点",
    });
    const selected = join(f.dir, "backup");
    await mkdir(selected);
    f.ports.chooseDirectory = async () => selected;
    const backup = await f.app.backup(),
      info = await inspectBackup(backup!);
    assert.equal(info.media.length, 1);
    const staged = await stageRestore(backup!, f.dir, info.databaseSha256),
      db = new Database(join(staged.dataPath, "panxu.db"));
    try {
      assert.equal(
        db.get<any>("SELECT count(*) n FROM studio_templates")!.n,
        1,
      );
      assert.equal(db.get<any>("SELECT count(*) n FROM studio_jobs")!.n, 1);
      assert.equal(db.get<any>("SELECT count(*) n FROM secrets")!.n, 0);
    } finally {
      db.close();
    }
    assert.equal(
      await fileHash(join(staged.dataPath, "media", `${job.asset}.png`)),
      job.asset,
    );
    await writeFile(join(backup!, "media", `${job.asset}.png`), "tampered");
    await assert.rejects(inspectBackup(backup!), {
      code: "BACKUP_HASH_MISMATCH",
    });
  } finally {
    await f.cleanup();
  }
});
test("v8 migration takes a consistent v9 snapshot and preserves old drafts on reopen", async () => {
  const f = await setup();
  try {
    const path = join(f.dir, "old.db");
    const legacy = (await f.app.invoke("draft.manual", {
      copyId: f.saved.copyId,
      platform: "xiaohongshu",
      template: true,
    })) as Draft;
    f.app.db.run("VACUUM INTO ?", path);
    const raw = new DatabaseSync(path);
    raw.exec(removeV9 + "PRAGMA user_version=8;");
    raw.close();
    new Database(path).close();
    new Database(path).close();
    assert.equal(
      (await readdir(f.dir)).filter((n) => n.startsWith("old.db.before-v9-"))
        .length,
      1,
    );
    const db = new Database(path);
    assert.equal(db.get<any>("PRAGMA user_version").user_version, currentSchemaVersion);
    assert.equal(
      db.get<any>("SELECT id FROM drafts WHERE id=?", legacy.id).id,
      legacy.id,
    );
    db.close();
  } finally {
    await f.cleanup();
  }
});
