import { fixture } from "./helpers";
import type { BrowserBinding } from "../shared/types";
import type {
  CsdnWorkflowDetail,
  CsdnEditorPayload,
} from "../shared/csdn-workflow";
import assert from "node:assert/strict";

export async function csdnFixture() {
  const f = await fixture();
  const saved = await f.add(true, {
    title: "Matplotlib 中文字体练习资料",
    summary: "开源字体与中文图表练习文件，附项目内字体注册示例。",
    tags: ["Matplotlib", "Python"],
  });
  await f.app.queue.execute(saved.jobId);
  await f.app.secrets.set("openrouter", "mock-csdn-key");
  f.app.db.setSetting("model", "mock/csdn-text");
  f.app.db.setSetting("modelCatalog", [
    {
      id: "mock/csdn-text",
      name: "本机模拟文案模型",
      structured: true,
      promptPrice: 0.000001,
      completionPrice: 0.000001,
    },
  ]);
  f.app.db.setSetting("dailyAiBudgetMicros", 1_000_000);
  const generated: Record<string, unknown>[] = [];
  const prepared: CsdnEditorPayload[] = [];
  let submitted = 0;
  Object.assign(f.app.ai, {
    requestJson: async (url: string, init: RequestInit) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      generated.push(JSON.parse(String(init.body)));
      return {
        usage: { cost: 0.001 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Matplotlib 中文乱码：项目内加载字体",
                body: "## 环境与前提\n\n本文说明在项目内注册中文字体的方法，示例需按实际环境验证。\n\n## 操作步骤\n\n```python\nfrom matplotlib import font_manager\nfont_manager.fontManager.addfont('demo.ttf')\n```\n\n## 结果与限制\n\n请核对字体许可、实际字体路径与图表显示结果。",
                tags: ["Python", "Matplotlib"],
                coverText: "中文图表",
              }),
            },
          },
        ],
      };
    },
  });
  const binding = (await f.app.invoke("binding.save", {
    platform: "csdn",
    alias: "本机模拟 CSDN 账号",
    windowId: "mock-window",
    editorUrl: "https://editor.csdn.net/md/",
    linkPermission: "allowed",
    ruleNote: "本机模拟已核实的教程配套资料引用场景。",
  })) as BrowserBinding;
  f.app.csdnEditor.prepare = async (_binding, payload) => {
    prepared.push(payload);
  };
  f.app.csdnEditor.submit = async (_binding, payload, beforeSubmit) => {
    await beforeSubmit();
    submitted++;
    return {
      status: "submitted",
      url: `https://blog.csdn.net/${payload.author}/article/details/123456789`,
    };
  };
  f.app.csdnEditor.inspect = async () => {};
  const create = (keyword = "Matplotlib 中文乱码") =>
    f.app.invoke("csdn.create", {
      keyword,
      sourceId: "manual",
      copyId: saved.copyId,
      evidence: "仅核对项目内字体注册方式，示例尚未覆盖所有操作系统。",
      softwareVersion: "3.x",
      operatingSystem: "macOS",
    }) as Promise<CsdnWorkflowDetail>;
  const generate = async (keyword?: string) => {
    const { run } = await create(keyword);
    return f.app.invoke("csdn.generate", {
      id: run.id,
    }) as Promise<CsdnWorkflowDetail>;
  };
  const configure = (runId: string, includeLink = true) =>
    f.app.invoke("csdn.configure", {
      id: runId,
      options: {
        bindingId: binding.id,
        author: "qa_author",
        summary: "可复核的项目内字体注册示例。",
        includeLink,
      },
    }) as Promise<CsdnWorkflowDetail>;
  const ready = async (keyword?: string) => {
    const result = await generate(keyword);
    await f.app.invoke("draft.review", {
      id: result.draft!.id,
      reviewed: true,
    });
    await configure(result.run.id);
    return f.app.invoke("csdn.prepare", {
      id: result.run.id,
    }) as Promise<CsdnWorkflowDetail>;
  };
  return {
    ...f,
    saved,
    binding,
    generated,
    prepared,
    create,
    generate,
    configure,
    ready,
    get submitted() {
      return submitted;
    },
  };
}
