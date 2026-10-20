import { TextSuggestions } from "../ui/TextSuggestions";
import { QueryError } from "../ui/QueryError";
import { RefreshCw, Sparkles } from "lucide-react";
import { Button, Field, LoadingState } from "../ui/primitives";
import { useAppActions, useAppActivity } from "../state";
import {
  aiPurposes,
  aiPurposeDetails,
  modelsForPurpose,
  recommendAiModels,
  type AiModelSelection,
} from "../../shared/ai-models";
import { useModelCatalog } from "./useModelCatalog";
import { modelDropdownOptions } from "./model-recommendations";
import "./models.css";

const modelFit = (id: string, fallback: string) => {
  if (id.startsWith("qwen/qwen3.8-max"))
    return "中文资源分析和内容创作的质量优先候选，支持结构化输出。";
  if (id === "google/gemini-3.8-flash")
    return "多模态理解与结构化输出，用于识别截图表头、列顺序和筛选要求。";
  if (id === "openai/gpt-image-2.5-sunburst")
    return "侧重精细创作与编辑准确度，用于营销封面和组图；生成后核对中文与细节。";
  if (id === "google/veo-3.1")
    return "侧重成片画质，支持竖屏、1080p与原生音频，可按本次任务调整。";
  return fallback;
};

export default function ModelSettings({
  value,
  onChange,
}: {
  value: AiModelSelection;
  onChange(value: AiModelSelection): void;
}) {
  const { notify } = useAppActions(),
    { busy } = useAppActivity();
  const { catalog, loading, refreshing, refresh, error, retry } =
    useModelCatalog();
  return (
    <section className="ai-model-settings" aria-label="按用途配置AI模型">
      <div className="row spread">
        <div>
          <h3>不同工作，交给合适的模型</h3>
          <p className="muted">
            在这里设置默认模型。创作、筛选和识图自动使用对应配置，图片与视频可在单次任务中临时更换。
          </p>
        </div>
        <div className="row">
          <Button
            disabled={busy > 0 || refreshing}
            onClick={async () => {
              const result = await refresh();
              if (result)
                notify(
                  result.priceFailures
                    ? `模型目录已刷新；${result.priceFailures}个图片模型报价暂缺或沿用旧记录，已有选择保持不变。`
                    : "模型目录已刷新，已有选择保持不变。",
                  result.priceFailures ? "warning" : "success",
                );
            }}
          >
            <RefreshCw size={14} />
            刷新全部模型
          </Button>
          <Button
            disabled={busy > 0 || refreshing}
            onClick={async () => {
              const latest = await refresh();
              if (!latest) return;
              const recommended = recommendAiModels(latest.catalog);
              onChange(
                Object.fromEntries(
                  aiPurposes.map((p) => [p, recommended[p] || value[p]]),
                ) as AiModelSelection,
              );
              const missing = aiPurposes.filter((p) => !recommended[p]);
              notify(
                missing.length
                  ? `已填写可用推荐；${missing.map((p) => aiPurposeDetails[p].label).join("、")}暂无合适推荐，请手动选择。`
                  : "已填写效果优先推荐，请保存设置后使用。",
                missing.length ? "warning" : "info",
              );
            }}
          >
            <Sparkles size={14} />
            效果优先推荐
          </Button>
        </div>
      </div>
      {error ? (
        <QueryError
          title="模型目录读取失败"
          error={error}
          loading={refreshing || loading}
          onRetry={() => void retry()}
        >
          当前选择已保留，可重试读取。
        </QueryError>
      ) : null}
      {refreshing || loading ? (
        <LoadingState label="正在读取官方模型能力…" compact>
          保留当前选择，不会提交生成任务。
        </LoadingState>
      ) : null}
      <div className="ai-purpose-grid">
        {aiPurposes.map((p) => {
          const detail = aiPurposeDetails[p],
            options = modelsForPurpose(p, catalog),
            selected = options.find((m) => m.id === value[p]);
          return (
            <div className="ai-purpose-card" key={p}>
              <Field label={detail.label} hint={detail.description}>
                <TextSuggestions
                  aria-label={`${detail.label}默认模型`}
                  placeholder="输入模型名或ID查找"
                  value={value[p]}
                  onValueChange={(nextValue) =>
                    onChange({ ...value, [p]: nextValue })
                  }
                  disabled={busy > 0 || refreshing}
                  items={modelDropdownOptions(catalog, p)}
                  showAllOnOpen
                />
              </Field>
              <div className="ai-purpose-description">
                <strong>
                  {selected?.name ?? (value[p] ? "待核对模型能力" : "尚未选择")}
                </strong>
                <small>
                  {modelFit(
                    value[p],
                    selected ? detail.description : detail.recommendation,
                  )}
                </small>
                {selected?.lastError ? (
                  <small className="ai-model-warning">
                    上次调用失败：{selected.lastError}
                    。推荐会跳过此模型；更换连接后仍可手动选择重试。
                  </small>
                ) : null}
                {selected && "promptPrice" in selected ? (
                  <small>
                    每百万令牌：输入{" "}
                    {selected.promptPrice == null
                      ? "未报价"
                      : `$${Number((selected.promptPrice * 1e6).toFixed(6))}`}{" "}
                    / 输出{" "}
                    {selected.completionPrice == null
                      ? "未报价"
                      : `$${Number((selected.completionPrice * 1e6).toFixed(6))}`}
                    ；按实际调用记账。
                  </small>
                ) : null}
                {selected && "ratios" in selected ? (
                  <small>
                    比例 {selected.ratios.join(" / ") || "模型默认"}
                    {p === "video"
                      ? ` · ${selected.resolutions.join(" / ") || "模型默认分辨率"}${selected.audio ? " · 支持原生音频" : ""}`
                      : ""}
                  </small>
                ) : null}
                {value[p] &&
                !selected &&
                (catalog.text.length || catalog.media.length) ? (
                  <small className="ai-model-warning">
                    当前目录未确认该模型适用于此用途，请刷新或重新选择。
                  </small>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <small>
        推荐来自当前官方可用目录与产品用途判断，不代表所有模型的效果排名。更换模型后，已有内容和远端任务继续保留原模型记录。
      </small>
    </section>
  );
}
