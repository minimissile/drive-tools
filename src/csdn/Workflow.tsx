import { useState } from "react";
import { z } from "zod";
import { Plus, Sparkles } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppActivity, useAppData } from "../state";
import {
  Button,
  Empty,
  Header,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import DraftEditor from "../studio/DraftEditor";
import { csdnStageLabels } from "../../shared/csdn-workflow";
import { CsdnSetup } from "./Setup";
import { CsdnPublication, CsdnReceipt } from "./Publication";
import { formatTime } from "../lib/format";
import "../studio/studio.css";
import "./csdn.css";

export default function CsdnWorkflowPage() {
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity();
  const selection = useLocalDraft(
    `panxu-csdn-selection-v1:${data!.dataPath}`,
    { id: "" },
    (value) => z.object({ id: z.string() }).parse(value),
  );
  const runId = selection.value.id;
  const [revision, setRevision] = useState(0);
  const history = useIpcQuery("csdn.history", undefined, {
    revision: busy,
    refreshInterval: 3000,
    keepPrevious: true,
  });
  const detail = useIpcQuery(
    "csdn.get",
    { id: runId },
    {
      enabled: !!runId,
      revision: busy,
      invalidate: data?.drafts,
      refreshInterval: 2500,
    },
  );
  const open = (id: string) => {
    selection.update({ id });
    setRevision((n) => n + 1);
  };
  const run = detail.data?.run;
  const draft = detail.data?.draft;
  const running =
    !!run && ["generating", "preparing", "submitting"].includes(run.stage);
  return (
    <div className="csdn-workflow">
      <Header
        title="CSDN 自动创作与发布"
        description="选词与配套资料 → 生成教程并审阅 → 自动填写 → 提交与回执。"
        action={
          runId ? (
            <Button onClick={() => open("")}>
              <Plus size={15} />
              新建单篇任务
            </Button>
          ) : undefined
        }
      />
      <div className="csdn-workflow-layout">
        <div className="csdn-workflow-main">
          {!runId ? (
            <CsdnSetup key={`setup:${revision}`} onCreated={open} />
          ) : (
            <>
              <QueryError
                error={detail.error}
                loading={detail.loading}
                onRetry={detail.reload}
              />
              {!detail.data && detail.loading ? (
                <LoadingState label="正在读取 CSDN 创作任务…" />
              ) : null}
              {run ? (
                <>
                  <Panel
                    title={run.input.keyword}
                    extra={
                      <Status
                        kind={
                          run.stage === "published"
                            ? "good"
                            : ["attention", "uncertain"].includes(run.stage)
                              ? "warning"
                              : "normal"
                        }
                      >
                        {csdnStageLabels[run.stage]}
                      </Status>
                    }
                  >
                    <p className="muted">
                      {run.source.source} ·{" "}
                      {run.source.observedAt
                        ? formatTime(run.source.observedAt)
                        : "搜索需求待核实"}
                    </p>
                    {!(draft && run.stage === "attention") ? (
                      <Notice warning={run.stage === "uncertain"}>
                        {run.message}
                      </Notice>
                    ) : null}
                    <ol className="csdn-stage-list" aria-label="单篇发布进度">
                      {[
                        "选词与资料",
                        "生成与审阅",
                        "自动填写",
                        "提交与回执",
                      ].map((label, index) => (
                        <li
                          key={label}
                          data-current={
                            index ===
                              ([
                                "submitted",
                                "published",
                                "uncertain",
                                "submitting",
                              ].includes(run.stage)
                                ? 3
                                : ["preparing", "ready"].includes(run.stage)
                                  ? 2
                                  : 1) || undefined
                          }
                        >
                          {label}
                        </li>
                      ))}
                    </ol>
                  </Panel>
                  {draft ? (
                    <Panel
                      title="教程编辑与审阅"
                      extra={
                        <small>
                          已保存 v{draft.version} ·{" "}
                          {draft.reviewed ? "已审阅" : "待审阅"}
                        </small>
                      }
                    >
                      {!["submitted", "published", "uncertain"].includes(
                        run.stage,
                      ) ? (
                        <div className="toolbar">
                          <Select
                            aria-label="CSDN 任务稿件版本"
                            value={draft.id}
                            disabled={busy > 0 || running}
                            items={detail.data!.versions.map((item) => ({
                              value: item.id,
                              label: `${item.title} · v${item.version} · ${formatTime(item.updatedAt)}`,
                            }))}
                            onValueChange={(draftId) => {
                              void command("csdn.attachDraft", {
                                id: run.id,
                                draftId,
                              });
                            }}
                          />
                        </div>
                      ) : null}
                      {["submitted", "published", "uncertain"].includes(
                        run.stage,
                      ) ? (
                        <article className="csdn-final-preview">
                          <h3>{draft.title}</h3>
                          <div>{draft.body}</div>
                          <p>{draft.tags.join(" · ")}</p>
                        </article>
                      ) : (
                        <DraftEditor
                          key={draft.id}
                          draft={draft}
                          onSaved={(draftId) => {
                            void command("csdn.attachDraft", {
                              id: run.id,
                              draftId,
                            });
                          }}
                          onContinue={() =>
                            document
                              .getElementById("csdn-publication")
                              ?.scrollIntoView({
                                block: "start",
                                behavior: "instant",
                              })
                          }
                        />
                      )}
                    </Panel>
                  ) : (
                    <Panel title="生成技术教程">
                      <p>
                        配套资料已关联。生成将使用现有文案模型、预算与调用记录，完成后保存在内容工作室。
                      </p>
                      <p className="csdn-evidence-preview">
                        {run.input.evidence}
                      </p>
                      <Button
                        primary
                        disabled={busy > 0 || running}
                        onClick={() =>
                          void command("csdn.generate", { id: run.id })
                        }
                      >
                        <Sparkles size={15} />
                        {run.stage === "attention"
                          ? "重试生成教程"
                          : "使用 AI 生成教程"}
                      </Button>
                    </Panel>
                  )}
                  {draft ? (
                    <div id="csdn-publication">
                      <CsdnPublication key={run.id} detail={detail.data!} />
                    </div>
                  ) : null}
                  <CsdnReceipt
                    key={`receipt:${run.id}`}
                    detail={detail.data!}
                  />
                  {run.events?.length ? (
                    <details className="csdn-event-log">
                      <summary>执行记录 · {run.events.length} 项</summary>
                      <ol>
                        {[...run.events].reverse().map((event, index) => (
                          <li key={`${event.at}:${index}`}>
                            <time>{formatTime(event.at)}</time>
                            <span>{event.message}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>
        <aside className="csdn-workflow-aside">
          <Panel
            title="单篇任务"
            extra={
              <Button quiet size="compact" onClick={() => open("")}>
                新建
              </Button>
            }
          >
            <QueryError
              error={history.error}
              loading={history.loading}
              onRetry={history.reload}
            />
            {!history.data && history.loading ? (
              <LoadingState compact label="正在读取任务…" />
            ) : history.data?.length ? (
              <nav className="csdn-task-list" aria-label="CSDN 单篇任务">
                {history.data.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-current={runId === item.id ? "step" : undefined}
                    onClick={() => open(item.id)}
                  >
                    <strong>{item.input.keyword}</strong>
                    <span>{csdnStageLabels[item.stage]}</span>
                    <small>{formatTime(item.updatedAt)}</small>
                  </button>
                ))}
              </nav>
            ) : !history.error ? (
              <Empty compact title="还没有创作任务">
                先选一个搜索问题和配套本人资料。
              </Empty>
            ) : null}
          </Panel>
          <p className="muted">
            任务与断点保存在当前工作空间。切页不重发，重启后需核对再继续。
          </p>
        </aside>
      </div>
    </div>
  );
}
