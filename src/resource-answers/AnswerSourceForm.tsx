import { answerStyles } from "../../shared/resource-answers";
import { useAppNavigation } from "../state";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { SearchSelect } from "../ui/SearchSelect";
import { Select } from "../ui/Select";
import { updateSelection } from "../lib/selection";
import type { ResourceAnswersModel } from "./useResourceAnswers";

const styleHints: Record<(typeof answerStyles)[number], string> = {
  清晰实用: "条理清楚，突出可执行的建议。",
  简洁直接: "先说重点，减少铺垫。",
  专业详解: "解释背景、方法和使用细节。",
  新手友好: "少用术语，分步讲解。",
  自然口语: "像日常交流一样，表达自然。",
  推广推荐: "突出适合的人群、资源特点和使用场景。",
};
export function AnswerSourceForm({
  model: m,
}: {
  model: ResourceAnswersModel;
}) {
  const { form } = m;
  const { openSettings } = useAppNavigation();
  const selected = form.value.resources;
  const updateResource = (
    resource: { id: string; title: string },
    checked: boolean,
  ) => {
    const ids = updateSelection(
      selected.map((r) => r.id),
      [resource.id],
      checked,
      10,
    );
    const records = new Map([...selected, resource].map((r) => [r.id, r]));
    form.update({ resources: ids.map((id) => records.get(id)!) });
  };
  return (
    <Panel title="问题与资源" className="resource-answer-source">
      <fieldset
        className="resource-answers-form"
        disabled={m.pending}
        aria-label="问题与资源设置"
      >
        <Field label="你的问题">
          <textarea
            rows={4}
            maxLength={4000}
            value={form.value.question}
            onChange={(e) => form.update({ question: e.target.value })}
            placeholder="例如：如何给零基础学习者介绍这些英语资料？"
          />
        </Field>
        <div className="resource-answer-resource-picker">
          <div className="resource-answer-section-heading">
            <h3>参考资源</h3>
            <small>{selected.length} / 10 项</small>
          </div>
          {selected.length < 10 ? (
            <SearchSelect
              label="选择参考资源（最多10项）"
              value={{ value: "", label: "搜索并添加资源" }}
              items={(m.resources.data?.items ?? [])
                .filter((r) => !selected.some((s) => s.id === r.id))
                .map((r) => ({ value: r.id, label: r.title }))}
              onQueryChange={m.setQuery}
              loading={m.resources.loading}
              error={m.resources.error}
              onRetry={m.resources.reload}
              onChange={(id) => {
                const r = m.resources.data?.items.find((r) => r.id === id);
                if (r) updateResource({ id: r.id, title: r.title }, true);
              }}
            />
          ) : (
            <p className="resource-answer-help">
              已选满10项。移除一项后可继续添加。
            </p>
          )}
          {selected.length ? (
            <ul className="resource-answers-selected" aria-label="已选参考资源">
              {selected.map((r) => (
                <li key={r.id}>
                  <span>{r.title}</span>
                  <Button
                    quiet
                    size="compact"
                    aria-label={`移除资源 ${r.title}`}
                    onClick={() => updateResource(r, false)}
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="resource-answer-help">
              可选择多份资源，结合已有资料回答问题。
            </p>
          )}
        </div>
        <div className="resource-answer-output-settings">
          <div className="field-pair resource-answers-options">
            <Field label="输出形式">
              <Select
                disabled={m.pending}
                value={form.value.format}
                onValueChange={(v) =>
                  form.update({ format: v as typeof form.value.format })
                }
                items={[
                  { value: "text", label: "文本" },
                  { value: "mixed", label: "图文（2张配图）" },
                  { value: "image", label: "图片（1张）" },
                ]}
              />
            </Field>
            <Field label="回答风格">
              <Select
                disabled={m.pending}
                value={form.value.style}
                onValueChange={(v) =>
                  form.update({ style: v as typeof form.value.style })
                }
                items={answerStyles.map((v) => ({ value: v, label: v }))}
              />
            </Field>
          </div>
          <p className="resource-answer-help">{styleHints[form.value.style]}</p>
          {form.value.format !== "text" ? (
            <p className="resource-answer-help">
              先生成文字与画面方案，确认后再逐张生成图片。
            </p>
          ) : null}
        </div>
        <p className="resource-answer-help">
          根据资源标题、摘要、标签和文件名创作，不代表已读取网盘文件正文。文字与图片生成分别计费。
        </p>
        <div className="resource-answer-form-footer">
          <p className="resource-answer-help" aria-live="polite">
            {m.pending ? "正在生成并保存，请稍候…" : m.inputHint}
          </p>
          <div className="resource-answer-actions">
            <Button
              primary
              disabled={!m.canGenerate}
              onClick={() => void m.generate(false)}
            >
              {m.pending ? "正在生成…" : "生成新内容"}
            </Button>
            <Button quiet onClick={() => openSettings("ai")}>
              模型与预算设置
            </Button>
          </div>
        </div>
      </fieldset>
      {form.error ? <Notice warning>{form.error}</Notice> : null}
      {m.error ? (
        <Notice danger>
          {m.error} 需求和原版本已保留；如需重试，请点击生成，可能产生新的费用。
        </Notice>
      ) : null}
    </Panel>
  );
}
