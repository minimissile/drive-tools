import { Copy } from "lucide-react";
import { useAppActions } from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { Loading } from "../ui/DataState";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { formatTime } from "../lib/format";
import type { ResourceAnswersModel } from "./useResourceAnswers";
const formats = { text: "文本", mixed: "图文", image: "图片" };
const statuses = {
  completed: "已完成",
  failed: "生成失败",
  uncertain: "待核对",
  generating: "生成中",
};
export function AnswerVersions({ model: m }: { model: ResourceAnswersModel }) {
  const { form, current } = m;
  const { command } = useAppActions();
  return (
    <Panel
      title="内容与版本"
      extra={<small>最近50个版本</small>}
      className="resource-answer-result"
    >
      <QueryError
        error={m.history.error}
        loading={m.history.loading}
        onRetry={m.history.reload}
      />
      {!m.history.data && !m.history.error ? (
        <LoadingState label="正在读取已保存版本…" />
      ) : null}
      {m.history.data ? (
        <div className="resource-answer-result-stack">
          <Field label="历史版本">
            <Select
              aria-label="选择资源问答版本"
              value={current?.id ?? ""}
              disabled={m.pending || !m.history.data.length}
              onValueChange={(id) => {
                const run = m.history.data?.find((r) => r.id === id);
                if (run) m.pick(run);
              }}
              items={[
                { value: "", label: "选择已保存版本", disabled: true },
                ...(current && !m.history.data.some((r) => r.id === current.id)
                  ? [{ value: current.id, label: current.title }]
                  : []),
                ...m.history.data.map((r) => ({
                  value: r.id,
                  label: `${r.title} · ${formats[r.input.format]} · ${statuses[r.status]} · ${formatTime(r.createdAt)}`,
                })),
              ]}
            />
          </Field>
          {m.pending ? (
            <Loading
              label={
                current
                  ? "正在生成新版本，当前内容已保留…"
                  : "正在生成内容并保存…"
              }
            />
          ) : null}
          {current?.status === "completed" ? (
            <>
              <article
                className="resource-answer-preview"
                aria-label="生成内容预览"
              >
                <div className="resource-answer-preview-heading">
                  <h3>{current.title}</h3>
                  <div className="resource-answer-meta">
                    <span>{formats[current.input.format]}</span>
                    <span>{current.input.style}</span>
                    <time dateTime={current.createdAt}>
                      {formatTime(current.createdAt)}
                    </time>
                  </div>
                </div>
                <div className="resource-answer-body">{current.body}</div>
                <div className="resource-answer-copybar">
                  <div className="resource-answer-actions">
                    <Button
                      onClick={() =>
                        void command(
                          "resourceAnswers.copy",
                          { id: current.id, format: "text" },
                          "文字已复制",
                        )
                      }
                    >
                      <Copy size={14} />
                      复制文字
                    </Button>
                    {current.draftId ? (
                      <Button
                        onClick={() =>
                          void command(
                            "resourceAnswers.copy",
                            { id: current.id, format: "rich" },
                            "图文已复制，可粘贴到支持富文本的编辑器",
                          )
                        }
                      >
                        <Copy size={14} />
                        复制完整图文
                      </Button>
                    ) : null}
                  </div>
                  {current.draftId ? (
                    <p className="resource-answer-help">
                      全部配图完成后，可复制完整图文；也可先复制文字。
                    </p>
                  ) : null}
                </div>
                <p className="resource-answer-help resource-answer-references">
                  参考资源：{current.resources.map((r) => r.title).join("、")}
                </p>
              </article>
              <div className="resource-answer-calibration">
                <div className="resource-answer-section-heading">
                  <h3>继续校准</h3>
                  <small>保留当前版本</small>
                </div>
                <Field label="补充说明 / 校准要求">
                  <textarea
                    disabled={m.pending}
                    rows={3}
                    maxLength={4000}
                    value={form.value.instruction}
                    onChange={(e) =>
                      form.update({ instruction: e.target.value })
                    }
                    placeholder="例如：语气更自然，缩短到300字，突出初学者的使用顺序。"
                  />
                </Field>
                <p className="resource-answer-help">
                  结合当前问题、资源、风格及补充说明，重新生成完整内容。
                </p>
                <div className="resource-answer-actions">
                  <Button
                    primary
                    disabled={!m.canGenerate || !form.value.instruction.trim()}
                    onClick={() => void m.generate(true)}
                  >
                    根据说明生成新版本
                  </Button>
                </div>
              </div>
            </>
          ) : current ? (
            <Notice warning>
              {current.error ||
                "该次生成尚未完成，可能仍在处理或已中断。请先刷新历史记录确认，不会自动重新请求。"}
            </Notice>
          ) : !m.history.error && !m.pending ? (
            <Empty title="从一个问题开始">
              输入问题并选择参考资源。生成后可在这里预览、复制，或补充说明继续校准。
            </Empty>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
