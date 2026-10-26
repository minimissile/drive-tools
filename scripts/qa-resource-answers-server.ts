/** Local-only UI QA bridge: real business services, disposable DB, simulated AI/clipboard. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resourceAnswersFixture } from "../tests/resource-answers-fixture";
import type { ResourceAnswer } from "../shared/resource-answers";
import { randomUUID } from "node:crypto";
const f = await resourceAnswersFixture();
// Optional development preview: static sample content, no generation or writable IPC.
const preview = process.argv.includes("--preview");
const previewRun: ResourceAnswer = {
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  status: "completed",
  error: "",
  title: "英语学习资料怎么用：从基础词汇到开口练习（排版示例）",
  body: "以下为本地排版示例，未调用模型。\n\n先从基础词汇开始。把资料分成每天能完成的小任务，每次学习后做一次简单回顾。\n\n再结合口语练习巩固。根据自己的学习节奏选择内容，不必一次看完所有资料。\n\n最后整理学习记录。把不熟悉的表达单独记下来，方便下一次复习。",
  draftId: "preview-answer",
  resources: f.ids.map((id) => {
    const r = f.app.repo.getResource(id);
    return { id: r.id, title: r.title };
  }),
  input: {
    requestId: randomUUID(),
    question: "如何给零基础学习者介绍这些资料，并说明适合的使用顺序？",
    resourceIds: f.ids,
    style: "新手友好",
    format: "mixed",
    instruction: "",
    previousId: null,
  },
};
const allowed = new Set([
  "snapshot",
  "resource.page",
  "resource.get",
  "resource.intakeOptions",
  "resourceAnswers.list",
  "resourceAnswers.generate",
  "resourceAnswers.copy",
  "studio.modelCatalog",
  "studio.models",
  "studio.jobs",
  "studio.submit",
  "studio.assetCopy",
  "draft.get",
  "zhidao.summary",
  "zhidao.activeRuns",
]);
let historyFailure = false;
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:8070");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.end();
    return;
  }
  try {
    if (req.url?.startsWith("/asset/")) {
      const name = req.url.slice(7);
      if (!/^[a-f0-9]{64}\.png$/.test(name)) throw Error("Invalid asset");
      res.setHeader("Content-Type", "image/png");
      res.end(await readFile(await f.app.studio.assetPath(name)));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    let value: unknown;
    if (req.url === "/control") {
      if (input.action === "fail") f.control.failNext = true;
      if (input.action === "history") historyFailure = !historyFailure;
      value = { historyFailure };
    } else if (req.url === "/state") {
      value = {
        calls: f.calls.length,
        imageCalls: f.control.imageCalls,
        clipboard: f.clipboard,
        transfers: f.provider.transfers,
        shares: f.provider.shares,
      };
    } else {
      if (input.method === "updater.state") value = null;
      else {
        if (!allowed.has(input.method))
          throw Error(`QA blocked IPC: ${input.method}`);
        if (
          preview &&
          !new Set([
            "snapshot",
            "resource.page",
            "resource.get",
            "resource.intakeOptions",
            "resourceAnswers.list",
            "studio.modelCatalog",
            "studio.jobs",
            "draft.get",
            "zhidao.summary",
            "zhidao.activeRuns",
          ]).has(input.method)
        )
          throw Error("这是只读排版预览，请在源码桌面窗口操作。");
        if (historyFailure && input.method === "resourceAnswers.list")
          throw Error("模拟版本列表读取失败");
        if (preview && input.method === "resourceAnswers.list")
          value = [previewRun];
        else if (preview && input.method === "draft.get")
          value = {
            id: previewRun.draftId,
            creative: {
              cards: [
                {
                  heading: "学习路线",
                  copy: "先掌握基础词汇，再结合口语练习逐步巩固。",
                },
                {
                  heading: "每日回顾",
                  copy: "记录不熟悉的表达，形成自己的复习清单。",
                },
              ],
            },
          };
        else if (preview && input.method === "studio.jobs") value = [];
        else value = await f.app.invoke(input.method, input.args);
      }
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ value }));
  } catch (e) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
    );
  }
});
server.on("error", async (e) => {
  console.error(e);
  await f.cleanup();
  process.exitCode = 1;
});
server.listen(5199, "127.0.0.1", () =>
  console.log(
    "Resource answers QA bridge at 127.0.0.1:5199; disposable DB; no paid API",
  ),
);
async function close() {
  server.close();
  await f.cleanup();
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
