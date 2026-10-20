import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import { AiService } from "../core/ai";
import { ResourceExports } from "../core/resource-export";
import { formatResourceExport } from "../core/export-formats";
import type { ExportRecord, ExportRun } from "../shared/resource-export";

const planResponse = {
  title: "英语教学资料",
  criteria: "筛选英语教学资料",
  columns: [
    { label: "资料名称", field: "title" },
    { label: "资料格式", field: "formats" },
    { label: "价格", field: "blank" },
  ],
  articleBrief: "面向英语老师写300字介绍",
  warnings: ["未记录价格，留空"],
};
async function setup() {
  const f = await fixture();
  await f.app.secrets.set("openrouter", "test-export-private-key");
  f.app.db.setSetting("model", "qa/export");
  f.app.db.setSetting("modelCatalog", [
    {
      id: "qa/export",
      structured: true,
      imageInput: true,
      promptPrice: 0.0000001,
      completionPrice: 0.0000001,
    },
  ]);
  f.app.db.setSetting("dailyAiBudgetMicros", 1000000);
  const qa = {
    calls: 0,
    phases: [] as string[],
    inputs: [] as any[],
    invalid: false,
    badArticle: false,
  };
  const ai = new AiService(
    f.app.repo,
    f.app.secrets,
    () => {},
    async (_url, init) => {
      qa.calls++;
      const payload = JSON.parse(String(init?.body)),
        phase = payload.response_format.json_schema.name;
      const input = JSON.parse(
        typeof payload.messages[1].content === "string"
          ? payload.messages[1].content
          : payload.messages[1].content[0].text,
      );
      qa.phases.push(phase);
      qa.inputs.push({ input, payload });
      await new Promise((r) => setTimeout(r, 2));
      let content: unknown;
      if (phase === "resource_export_plan") content = planResponse;
      else if (phase === "resource_export_match")
        content = {
          decisions: input.resources.map((r: any, i: number) => ({
            id: qa.invalid && i === 0 ? "made-up-id" : r.id,
            match: /英语|English/i.test(JSON.stringify(r)),
            reason: /英语|English/i.test(JSON.stringify(r))
              ? "标题或个人笔记中记录英语教学主题"
              : "未记录英语教学主题",
          })),
        };
      else
        content = {
          title: "英语教学资料怎么选",
          body: `按课堂需求整理资料。[${input.resources[0].title}](resource:${qa.badArticle ? "fake-id" : input.resources[0].id})可作为备课参考，使用前请核对文件内容。`,
          resourceIds: [qa.badArticle ? "fake-id" : input.resources[0].id],
        };
      return {
        usage: { cost: 0.0001 },
        choices: [{ message: { content: JSON.stringify(content) } }],
      };
    },
  );
  f.app.ai.resourceExport = ai.resourceExport.bind(ai);
  const create = (
    request = "导出英语教学资料",
    extra: Record<string, unknown> = {},
  ) =>
    f.app.invoke("resourceExport.plan", {
      request,
      ...extra,
    }) as Promise<ExportRun>;
  const step = (run: ExportRun) =>
    f.app.invoke("resourceExport.step", {
      runId: run.id,
    }) as Promise<ExportRun>;
  const finish = async (run: ExportRun) => {
    while (run.state !== "completed") {
      run = await step(run);
      assert.notEqual(run.state, "failed", run.error ?? "");
    }
    return run;
  };
  return { ...f, ai, qa, create, step, finish };
}

test("text-only export retains the user's request instead of adding model-invented filters or article facts", async () => {
  const f = await setup();
  try {
    const request =
      "筛选已归档的开源字体，ZIP也可以，导出标题和文件清单；写约200字短文，只依据资料记录说明用途和授权。";
    const run = await f.create(request);
    assert.equal(run.plan.criteria, request);
    assert.equal(run.plan.articleBrief, request);
    assert.doesNotMatch(run.plan.criteria, /英语教学/);
    const edited = {
      ...run.plan,
      criteria: "只要包含PDF的英语资料",
      articleBrief: "给老师写100字",
    };
    const updated = (await f.app.invoke("resourceExport.updatePlan", {
      runId: run.id,
      plan: edited,
    })) as ExportRun;
    assert.equal(updated.plan.criteria, edited.criteria);
    assert.equal(updated.plan.articleBrief, edited.articleBrief);
    const longRequest = "筛选开源字体，按实际资料记录整理。".repeat(150);
    assert.ok(longRequest.length > 2000 && longRequest.length <= 6000);
    const longRun = await f.create(longRequest);
    assert.equal(longRun.plan.criteria, longRequest);
    assert.equal(longRun.plan.articleBrief, longRequest);
    await f.app.invoke("resourceExport.updatePlan", {
      runId: longRun.id,
      plan: longRun.plan,
    });
  } finally {
    await f.cleanup();
  }
});

test("AI export validates image/text input, uses vision multipart once, and retains no image or credentials in history", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.create(""));
    await assert.rejects(
      f.create("", { images: ["https://example.com/image.png"] }),
      { code: "INVALID_EXPORT_IMAGE" },
    );
    await assert.rejects(
      f.create("", { images: ["data:image/png;base64,YWJj"] }),
      { code: "INVALID_EXPORT_IMAGE" },
    );
    assert.equal(f.qa.calls, 0);
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF2sAAAAASUVORK5CYII=";
    const [a, b] = await Promise.all([
      f.create("根据截图导出，提取码：abcd", { images: [image] }),
      f.create("根据截图导出，提取码：abcd", { images: [image] }),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(f.qa.calls, 1);
    assert.equal(
      f.qa.inputs[0].payload.messages[1].content[1].image_url.url,
      image,
    );
    const stored = JSON.stringify(
      f.app.db.setting(`resourceExport:v1:${a.id}`, null),
    );
    assert.doesNotMatch(
      stored,
      /data:image|base64|abcd|test-export-private-key/,
    );
    assert.equal(a.input.imageCount, 1);
    f.app.db.setSetting("modelCatalog", [
      { id: "qa/export", structured: true, imageInput: false },
    ]);
    await assert.rejects(f.create("截图", { images: [image] }), {
      code: "VISION_MODEL_REQUIRED",
    });
    assert.equal(f.qa.calls, 1);
  } finally {
    await f.cleanup();
  }
});

test("full-library export scans beyond 500, keeps every exclusion, shares in-flight batches and resumes checkpoints", async () => {
  const f = await setup();
  try {
    f.app.db.transaction(() => {
      for (let i = 0; i < 523; i++)
        f.app.db.run(
          "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          `r-${i}`,
          i % 2 ? `English教学${i}` : `数学教学${i}`,
          `https://pan.quark.cn/s/row${i}`,
          `row${i}`,
          "quark",
          "教学",
          "[]",
          "已记录的资料说明",
          "2026-10-16",
          "2026-10-16",
        );
    });
    let run = await f.create();
    assert.equal(run.total, 523);
    assert.equal(run.scanned, 0);
    const [a, b] = await Promise.all([f.step(run), f.step(run)]);
    assert.equal(a.scanned, 30);
    assert.deepEqual(a, b);
    assert.equal(
      f.qa.phases.filter((p) => p === "resource_export_match").length,
      1,
    );
    const resumed = new ResourceExports(f.app.repo, f.ai, () => {});
    run = resumed.get(run.id);
    assert.equal(run.scanned, 30);
    run = await f.finish(run);
    assert.equal(run.scanned, 523);
    assert.equal(run.records.length, 261);
    assert.equal(run.excluded.length, 262);
    assert.equal(
      new Set([...run.records, ...run.excluded].map((r) => r.id)).size,
      523,
    );
    assert.ok(run.records.some((r) => r.id === "r-521"));
    await f.app.invoke("resourceExport.article", {
      runId: run.id,
      ids: run.records.map((r) => r.id),
    });
    const articleInput = f.qa.inputs.at(-1).input;
    assert.equal(articleInput.selectedCount, 261);
    assert.equal(articleInput.resources.length, 40);
    assert.equal(
      articleInput.groups.reduce(
        (n: number, g: { count: number }) => n + g.count,
        0,
      ),
      261,
    );
    assert.doesNotMatch(
      JSON.stringify(f.qa.inputs),
      /https:\/\/pan\.quark\.cn|test-export-private-key/,
    );
    await assert.rejects(
      f.app.invoke("resourceExport.updatePlan", {
        runId: run.id,
        plan: planResponse,
      }),
      { code: "EXPORT_STARTED" },
    );
    const excluded = run.excluded[0];
    const file = await f.app.resourceExports.file(
      run.id,
      [excluded.id],
      [{ label: "手工补充", field: "title" }],
      "csv",
      async () => ({ url: "", code: null }),
    );
    assert.match(file.bytes.toString(), /数学教学/);
  } finally {
    await f.cleanup();
  }
});

test("invalid AI decisions preserve cursor and fees; retry never duplicates prior results; budgets prevent calls", async () => {
  const f = await setup();
  try {
    await f.add(false, { title: "英语教学" });
    let run = await f.create();
    f.qa.invalid = true;
    run = await f.step(run);
    assert.equal(run.state, "failed");
    assert.equal(run.scanned, 0);
    assert.equal(run.records.length, 0);
    assert.match(run.error!, /未完整逐项/);
    assert.equal(
      f.app.repo.calls().filter((c) => c.endpoint === "openrouter").length,
      2,
    );
    f.qa.invalid = false;
    run = await f.finish(run);
    assert.equal(run.records.length, 1);
    const before = f.qa.calls;
    await f.step(run);
    assert.equal(f.qa.calls, before);
    f.app.db.setSetting("dailyAiBudgetMicros", 0);
    await assert.rejects(f.create("另一份英语教学导出"), {
      code: "AI_BUDGET_EXCEEDED",
    });
    assert.equal(f.qa.calls, before);
  } finally {
    await f.cleanup();
  }
});

test("knowledge selection reads associated personal notes, blocks outside symlinks and explicitly reports missing notes", async () => {
  const f = await setup();
  try {
    const a = await f.add(false, { title: "课堂资料合集" }),
      b = await f.add(false, {
        title: "其他合集",
        sourceText: "https://pan.quark.cn/s/other",
      });
    const base = join(f.dir, "vault", "盘序", "Resources");
    await mkdir(base, { recursive: true });
    f.app.db.setSetting("vaultPath", join(f.dir, "vault"));
    const path = join(base, "a.md");
    await writeFile(
      path,
      "---\nshare_url: https://pan.quark.cn/s/private\n---\n<!-- panxu:generated:start -->\n提取码：aB12\n<!-- panxu:generated:end -->\n## 我的笔记\n英语教学，口语课堂使用。 API Key: sk-or-v1-abcdefghijklmnop",
    );
    f.app.db.run(
      "INSERT INTO note_exports VALUES(?,?,?,?,?)",
      a.copyId,
      path,
      "hash",
      1,
      "2026-10-16",
    );
    const outside = join(f.dir, "private.md");
    await writeFile(outside, "English secret outside");
    await symlink(outside, join(base, "b.md"));
    f.app.db.run(
      "INSERT INTO note_exports VALUES(?,?,?,?,?)",
      b.copyId,
      join(base, "b.md"),
      "hash",
      1,
      "2026-10-16",
    );
    const run = await f.finish(await f.create("英语教学", { scope: "notes" }));
    assert.equal(run.total, 1);
    assert.equal(run.records[0].id, a.resourceId);
    assert.match(run.records[0].note, /英语教学/);
    assert.doesNotMatch(
      JSON.stringify(f.qa.inputs),
      /private|aB12|abcdefghijklmnop|secret outside/,
    );
    assert.ok(run.warnings.some((s) => s.includes("无法读取")));
    const dbOnly = await f.finish(
      await f.create("英语教学", { scope: "database" }),
    );
    assert.equal(dbOnly.records.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("explicit local category/provider/account filters and known split paths constrain the candidate snapshot", async () => {
  const f = await setup();
  try {
    const a = await f.add(false, { title: "英语教学", category: "语言" });
    await f.add(false, {
      title: "数学",
      category: "理科",
      sourceText: "https://pan.quark.cn/s/math",
    });
    f.app.db.run(
      "UPDATE copies SET files=? WHERE id=?",
      JSON.stringify([{ id: "a", name: "课程", isDirectory: true }]),
      a.copyId,
    );
    f.app.db.run(
      "INSERT INTO split_items(id,copy_id,file_id,file,ancestors,path,depth) VALUES(?,?,?,?,?,?,?)",
      "part",
      a.copyId,
      "b",
      JSON.stringify({ name: "英语.pdf", isDirectory: false }),
      "[]",
      "课程/英语.pdf",
      1,
    );
    const run = await f.finish(
      await f.create("英语教学", { category: "语言", accountId: f.account.id }),
    );
    assert.equal(run.total, 1);
    assert.equal(run.records[0].formats, "pdf");
    assert.match(run.records[0].filenames, /课程\/英语.pdf/);
    const empty = await f.finish(
      await f.create("英语教学", { provider: "baidu" }),
    );
    assert.equal(empty.total, 0);
  } finally {
    await f.cleanup();
  }
});

test("five output formats preserve labels, unicode, blank cells, escape formulas, and create a valid Excel archive", async () => {
  const f = await setup();
  try {
    const record = Object.fromEntries(
      [
        "title",
        "category",
        "tags",
        "summary",
        "provider",
        "accounts",
        "filenames",
        "formats",
        "fileCount",
        "status",
        "shareUrls",
        "extractionCodes",
        "note",
        "updatedAt",
        "reason",
        "blank",
      ].map((key) => [key, ""]),
    ) as ExportRecord;
    record.id = "r";
    record.title = '=HYPERLINK("bad")';
    record.summary = '英语 | <b>\n带逗号,和双引号"';
    const columns = [
      { label: "资源名称", field: "title" as const },
      { label: "介绍", field: "summary" as const },
      { label: "缺少数据", field: "blank" as const },
    ];
    const csv = formatResourceExport("csv", columns, [record]).toString();
    assert.match(csv, /'=.*/);
    assert.match(csv, /带逗号/);
    const md = formatResourceExport("md", columns, [record]).toString();
    assert.match(md, /\\\|/);
    assert.match(md, /&lt;b&gt;<br>/);
    const json = JSON.parse(
      formatResourceExport("json", columns, [record]).toString(),
    );
    assert.equal(json.rows[0][2], "");
    assert.deepEqual(json.columns, columns);
    assert.match(
      formatResourceExport("txt", columns, [record]).toString(),
      /介绍：英语/,
    );
    const excel = formatResourceExport("xlsx", columns, [record]),
      path = join(f.dir, "output.xlsx");
    await writeFile(path, excel);
    execFileSync("unzip", ["-t", path]);
    const sheet = execFileSync("unzip", [
      "-p",
      path,
      "xl/worksheets/sheet1.xml",
    ]).toString();
    assert.match(sheet, /t="inlineStr"/);
    assert.doesNotMatch(sheet, /<f[ >]/);
    assert.match(sheet, /资源名称/);
    assert.match(sheet, /&lt;b&gt;/);
    assert.throws(
      () =>
        formatResourceExport("xlsx", columns, [
          { ...record, summary: "a".repeat(32768) },
        ]),
      { code: "EXPORT_CELL_TOO_LONG" },
    );
    const whitespaceFormula = formatResourceExport("csv", columns, [
      { ...record, title: "  =HYPERLINK(1)" },
    ]).toString();
    assert.match(whitespaceFormula, /'  =HYPERLINK/);
  } finally {
    await f.cleanup();
  }
});

test("share columns reuse live ownership checks, exclude origin URLs and export codes only in their explicit column", async () => {
  const f = await setup();
  try {
    const saved = await f.add(true, { title: "英语教学" });
    await f.app.queue.execute(saved.jobId);
    const run = await f.finish(await f.create());
    let output = "";
    f.ports.saveFile = async (_name, bytes) => {
      output = bytes.toString();
      return "/tmp/result.csv";
    };
    const args = {
      runId: run.id,
      ids: run.records.map((r) => r.id),
      columns: [{ label: "链接", field: "shareUrls" }],
      format: "csv",
    };
    await f.app.invoke("resourceExport.file", args);
    assert.match(output, /own123/);
    assert.doesNotMatch(output, /source123|提取码/);
    assert.doesNotMatch(output, /test/);
    await f.app.invoke("resourceExport.file", {
      ...args,
      columns: [
        { label: "本人链接", field: "shareUrls" },
        { label: "提取码", field: "extractionCodes" },
      ],
    });
    assert.match(output, /test/);
    assert.doesNotMatch(output, /source123/);
    assert.ok(run.records.every((r) => r.extractionCodes === ""));
    f.provider.ownValid = false;
    await assert.rejects(f.app.invoke("resourceExport.file", args), {
      code: "SHARE_INVALID",
    });
    await assert.rejects(
      f.app.invoke("resourceExport.file", { ...args, ids: ["fake"] }),
      { code: "EXPORT_SELECTION_INVALID" },
    );
  } finally {
    await f.cleanup();
  }
});

test("articles use only selected resources, reject fabricated citations, and export edited prose with real sources", async () => {
  const f = await setup();
  try {
    await f.add(false, { title: "英语教学" });
    const run = await f.finish(await f.create());
    const args = { runId: run.id, ids: run.records.map((r) => r.id) };
    f.qa.badArticle = true;
    await assert.rejects(f.app.invoke("resourceExport.article", args), {
      code: "EXPORT_ARTICLE_INVALID",
    });
    const failed = f.app.resourceExports.get(run.id);
    assert.match(failed.articleError!, /不存在的资源/);
    assert.equal(failed.state, "completed");
    assert.equal(failed.article, null);
    f.qa.badArticle = false;
    const result = (await f.app.invoke(
      "resourceExport.article",
      args,
    )) as ExportRun;
    assert.match(result.article!.body, /resource:resource_/);
    assert.equal(result.articleError, null);
    f.qa.badArticle = true;
    await assert.rejects(f.app.invoke("resourceExport.article", args), {
      code: "EXPORT_ARTICLE_INVALID",
    });
    assert.deepEqual(f.app.resourceExports.get(run.id).article, result.article);
    assert.match(f.app.resourceExports.get(run.id).articleError!, /不存在的资源/);
    f.qa.badArticle = false;
    const before = f.qa.calls;
    await f.app.invoke("resourceExport.articleSave", {
      runId: run.id,
      article: { ...result.article!, title: "已保存的修改" },
    });
    assert.equal(
      f.app.resourceExports.get(run.id).article!.title,
      "已保存的修改",
    );
    assert.equal(f.qa.calls, before);
    const file = f.app.resourceExports.articleFile(
      run.id,
      { ...result.article!, title: "我编辑的标题" },
      "md",
    );
    assert.match(file.bytes.toString(), /我编辑的标题/);
    assert.match(file.bytes.toString(), /资源依据/);
    assert.doesNotMatch(file.bytes.toString(), /resource:resource_/);
    assert.throws(
      () =>
        f.app.resourceExports.articleFile(
          run.id,
          { ...result.article!, body: "[虚构](resource:fake)" },
          "txt",
        ),
      { code: "EXPORT_ARTICLE_INVALID" },
    );
  } finally {
    await f.cleanup();
  }
});
