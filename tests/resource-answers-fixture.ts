import { fixture } from "./helpers";
import { AppError } from "../core/errors";
export const qaPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZfQAAAAASUVORK5CYII=";
export async function resourceAnswersFixture() {
  const f = await fixture();
  const a = await f.add(false, {
    title: "英语零基础教学资料",
    summary: "包含入门词汇、口语练习与学习计划",
  });
  const b = await f.add(false, {
    sourceText: "https://pan.quark.cn/s/qatesting2",
    title: "Python编程学习资料",
    summary: "变量、函数与练习案例",
  });
  await f.app.secrets.set("openrouter", "qa-only-not-a-real-key");
  f.app.db.setSetting("aiModels", { copy: "qa-copy", image: "qa-image" });
  f.app.db.setSetting("studio:modelCatalog", [
    {
      id: "qa-image",
      name: "模拟图片模型（不计费）",
      kind: "image",
      ratios: ["3:4"],
      durations: [],
      resolutions: [],
      audio: false,
      reference: false,
      pricing: "测试服务，真实费用为0",
    },
  ]);
  const calls: any[] = [];
  const clipboard = { text: "", html: "", imageBytes: 0 };
  const control = {
    failNext: false,
    hold: false,
    release: undefined as undefined | (() => void),
    imageCalls: 0,
  };
  f.ports.copyText = async (text) => {
    clipboard.text = text;
  };
  f.ports.copyRichText = async (html, text) => {
    clipboard.html = html;
    clipboard.text = text;
  };
  f.ports.copyImage = async (bytes) => {
    clipboard.imageBytes = bytes.length;
  };
  f.app.ai.resourceExport = async <T>(
    _name: string,
    schema: any,
    _instruction: string,
    raw: any,
  ) => {
    calls.push(structuredClone(raw));
    if (control.hold)
      await new Promise<void>((resolve) => {
        control.release = resolve;
      });
    if (control.failNext) {
      control.failNext = false;
      throw new AppError("QA_FAILURE", "模拟模型生成失败，旧版本保留");
    }
    const count = raw.format === "text" ? 0 : raw.format === "image" ? 1 : 2;
    return schema.parse({
      title: `${raw.question.slice(0, 45)} · ${raw.style}`,
      body: `依据${raw.resources.map((r: any) => r.title).join("、")}回答。\n${raw.instruction ? `校准：${raw.instruction}` : "先学习基础，再进行练习。"}\n问题：${raw.question}`,
      cards: Array.from({ length: count }, (_, i) => ({
        heading: `学习步骤${i + 1}`,
        copy: "先掌握基础，再进行练习。",
        imagePrompt: "明亮简洁的学习路线示意图。",
      })),
    }) as T;
  };
  (f.app.studio as any).request = async () => {
    control.imageCalls++;
    return { data: [{ b64_json: qaPng }], usage: { cost: 0.001 } };
  };
  f.app.studio.models = async () => f.app.db.setting("studio:modelCatalog", []);
  return { ...f, ids: [a.resourceId, b.resourceId], calls, clipboard, control };
}
