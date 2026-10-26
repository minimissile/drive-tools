import { useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions, useAppData } from "../state";
import { Button, Field, LoadingState, Panel } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { StudioAsset } from "../studio/StudioAsset";
export function AnswerMedia({ draftId }: { draftId: string }) {
  const { data } = useAppData();
  const { command } = useAppActions();
  const draft = useIpcQuery("draft.get", { id: draftId });
  const catalog = useIpcQuery("studio.modelCatalog", undefined);
  const jobs = useIpcQuery(
    "studio.jobs",
    { draftId },
    { refreshInterval: 4000, keepPrevious: true },
  );
  const [model, setModel] = useState(data!.settings.aiModels.image);
  const [reserve, setReserve] = useState("0.10");
  const [pending, setPending] = useState(false);
  const models = (catalog.data ?? []).filter((m) => m.kind === "image");
  const chosen = models.find((m) => m.id === model);
  const cards = draft.data?.creative?.cards ?? [];
  const readyCount = cards.filter((_, slot) =>
    jobs.data?.some(
      (job) =>
        job.kind === "image" &&
        job.slot === slot &&
        job.status === "completed" &&
        job.asset,
    ),
  ).length;
  const budgetValid =
    Number.isFinite(Number(reserve)) &&
    Number(reserve) >= 0.001 &&
    Number(reserve) <= 100;
  const submit = async (slot: number) => {
    setPending(true);
    try {
      const result = await command("studio.submit", {
        draftId,
        kind: "image",
        slot,
        model,
        reserveMicros: Math.round(Number(reserve) * 1e6),
        regenerate: ["failed", "completed"].includes(
          jobs.data?.findLast(
            (job) => job.kind === "image" && job.slot === slot,
          )?.status ?? "",
        ),
      });
      jobs.reload();
      return result;
    } finally {
      setPending(false);
    }
  };
  return (
    <Panel
      title="图片制作与复制"
      className="resource-answer-media"
      extra={
        draft.data && jobs.data ? (
          <small>
            {readyCount} / {cards.length} 张已生成
          </small>
        ) : undefined
      }
    >
      <QueryError
        error={draft.error || catalog.error || jobs.error}
        onRetry={() => {
          draft.reload();
          catalog.reload();
          jobs.reload();
        }}
      />
      {!draft.data && !draft.error ? (
        <LoadingState label="正在读取画面方案…" />
      ) : null}
      <div className="fields resource-answer-media-controls">
        <Field label="图片模型">
          <Select
            aria-label="资源问答图片模型"
            disabled={pending}
            value={model}
            items={[
              { value: "", label: "请选择图片模型" },
              ...models.map((m) => ({ value: m.id, label: m.name })),
            ]}
            onValueChange={setModel}
          />
        </Field>
        <Field label="单张预留预算（美元）">
          <input
            type="number"
            min="0.001"
            max="100"
            step="0.01"
            value={reserve}
            disabled={pending}
            aria-invalid={!budgetValid || undefined}
            aria-describedby={
              !budgetValid ? "resource-answer-budget-error" : undefined
            }
            onChange={(e) => setReserve(e.target.value)}
          />
        </Field>
        <Button
          disabled={pending || catalog.loading}
          onClick={() =>
            void command("studio.models").then(() => catalog.reload())
          }
        >
          刷新图片模型
        </Button>
      </div>
      {!budgetValid ? (
        <p
          className="resource-answer-help resource-answer-field-error"
          id="resource-answer-budget-error"
          role="alert"
        >
          请输入0.001至100美元的单张预留预算。
        </p>
      ) : null}
      <p className="resource-answer-help">
        每张图片独立提交并计费，预留预算不代表最终费用。生成后可复制图片或完整图文。
      </p>
      {!catalog.loading && !catalog.error && !models.length ? (
        <p className="resource-answer-help">
          本地尚无可用图片模型，请点击“刷新图片模型”获取列表。
        </p>
      ) : null}
      <details className="resource-answer-pricing">
        <summary>查看所选模型费用说明</summary>
        <p className="resource-answer-help">
          {chosen?.pricing || "选择图片模型后显示费用说明。"}
        </p>
      </details>
      <div className="resource-answer-media-plans">
        {cards.map((card, slot) => (
          <section
            className="resource-answer-media-plan"
            key={slot}
            aria-label={`第${slot + 1}张画面方案`}
          >
            <h3>{card.heading}</h3>
            <p className="resource-answer-media-copy">{card.copy}</p>
            <StudioAsset
              embedded
              jobs={jobs.data ?? []}
              kind="image"
              slot={slot}
              dirty={false}
              canGenerate={!pending && !!chosen && budgetValid && !jobs.error}
              allowRepeat={false}
              submit={submit}
              reload={jobs.reload}
            />
          </section>
        ))}
      </div>
    </Panel>
  );
}
