import { useState } from "react";
import {
  generationBody,
  generationQuestion,
  generationTracks,
  type GenerationResource,
  type GenerationRules,
} from "../../shared/zhidao-generation";
import { Panel, Field, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";

const example: GenerationResource = {
  title: "Excel项目进度表",
  link: "",
  code: "",
  summary:
    "这份表格包含任务清单、负责人、截止日期与完成状态，适合记录小型项目的进展。使用前先复制一份，再用一个实际任务核对字段和统计结果。",
  image: "",
};
export function GenerationPreview({
  resources,
  rules,
}: {
  resources: GenerationResource[];
  rules: GenerationRules;
}) {
  const selected = resources[0] ?? example;
  return <Preview resources={resources} rules={rules} fallback={selected} />;
}
function Preview({
  resources,
  rules,
  fallback,
}: {
  resources: GenerationResource[];
  rules: GenerationRules;
  fallback: GenerationResource;
}) {
  const [index, setIndex] = useState("0");
  const resource = resources[Number(index)] ?? fallback;
  const question = generationQuestion(resource, rules);
  const body = generationBody(resource, rules);
  const link = (
    <p className="generation-preview-link">
      资料入口：{resource.link || "导入后显示真实链接"}
      {resource.code ? ` · 提取码 ${resource.code}` : ""}
    </p>
  );
  return (
    <Panel
      title={resources.length ? "问答预览" : "问答样式示例"}
      extra={
        <span className="generation-caption">
          {generationTracks[rules.track].label} · {question.length}/49字
        </span>
      }
      className="generation-preview"
    >
      {resources.length ? (
        <Field label="预览资料">
          <Select
            value={resources[Number(index)] ? index : "0"}
            onValueChange={setIndex}
            items={resources.map((entry, i) => ({
              value: String(i),
              label: `${i + 1}. ${entry.title}`,
            }))}
          />
        </Field>
      ) : (
        <p className="generation-caption">
          以下为样式示例。导入资料后可逐条预览，不会调用模型。
        </p>
      )}
      <article className="generation-answer-preview">
        <h3>{question}</h3>
        {rules.linkPosition === "first" ? link : null}
        <div>
          {body
            .split(/\n+/)
            .filter(Boolean)
            .map((p, i) => (
              <p key={i}>{p}</p>
            ))}
        </div>
        {rules.linkPosition === "last" ? link : null}
        {rules.includeImage && resource.image ? (
          <p className="generation-caption">
            图片将随回答导出：{resource.image}
          </p>
        ) : null}
      </article>
      {rules.mode === "ai" ? (
        <Notice>当前仅预览结构与资料依据；AI生成后以已保存的结果为准。</Notice>
      ) : null}
      <details className="generation-output-help">
        <summary>导出为答主工作台标准格式</summary>
        <dl>
          <div>
            <dt>qid</dt>
            <dd>创建问答时保持为空</dd>
          </div>
          <div>
            <dt>问题标题</dt>
            <dd>组合后的自然问句，最多49字</dd>
          </div>
          <div>
            <dt>回答内容</dt>
            <dd>分段正文、真实资料链接和可选图片</dd>
          </div>
        </dl>
      </details>
    </Panel>
  );
}
