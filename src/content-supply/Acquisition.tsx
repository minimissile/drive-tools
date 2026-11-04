import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions, useAppNavigation } from "../state";
import { formatTime } from "../lib/format";
import { Button, LoadingState, Notice, Status } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import type { SupplyAcquireRun } from "../../shared/pipix-acquisition";
import type { SupplyEditorial } from "../../shared/content-supply";

export function SupplyAcquisitionPanel({
  context,
  keyword,
  onOpenDraft,
}: {
  context: Pick<
    SupplyEditorial,
    "planId" | "accountId" | "direction" | "audience"
  >;
  keyword: string;
  onOpenDraft(id: string): void;
}) {
  const query = useIpcQuery("contentSupply.acquisition", undefined, {
    keepPrevious: true,
    refreshInterval: 3000,
  });
  const [selected, setSelected] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [comments, setComments] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { openSettings } = useAppNavigation(),
    { notify } = useAppActions();
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setConfirmed(false);
  }, [
    context.planId,
    context.accountId,
    context.direction,
    context.audience,
    keyword,
    comments,
  ]);
  const run =
      query.data?.runs.find((item) => item.id === selected) ??
      query.data?.runs[0],
    usage = query.data?.usage;
  const action = async (fn: () => Promise<unknown>, message: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setConfirmed(false);
    try {
      await fn();
      query.reload();
      notify(message, "success");
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "补料未完成，请检查日志",
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="supply-acquisition" aria-label="按方向自动补料">
      <div className="row spread">
        <h3 className="supply-subheading">按方向自动补料</h3>
        <Button size="compact" onClick={() => openSettings("sources")}>
          请求上限与数据源
        </Button>
      </div>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!query.data && !query.error ? (
        <LoadingState compact label="正在读取补料状态…" />
      ) : null}
      {usage ? (
        <>
          <p className="supply-muted">
            先找本地未建单图文，再按上方关键词补列表和评论，最后建立编辑资料包。本轮最多{" "}
            {usage.policy.requestsPerRun} 次新请求、
            {usage.policy.listPagesPerRun} 页列表、每帖{" "}
            {usage.policy.commentPagesPerItem} 页评论、
            {usage.policy.itemsPerRun} 份素材；今日剩余 {usage.remainingToday}{" "}
            次。
          </p>
          <div className="row">
            <CheckboxField
              label="补采真实评论"
              checked={comments}
              disabled={busy || query.data?.busy}
              onChange={(event) => setComments(event.target.checked)}
            />
            <CheckboxField
              label="授权本次补料在上述请求上限内调用TikHub"
              checked={confirmed}
              disabled={busy || query.data?.busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <Button
              primary
              size="compact"
              disabled={
                busy ||
                query.data?.busy ||
                !confirmed ||
                !keyword.trim() ||
                !context.direction.trim()
              }
              onClick={() =>
                void action(async () => {
                  const created = await ipc("contentSupply.acquire", {
                    ...context,
                    keyword,
                    comments,
                    confirmed: true,
                  });
                  if (alive.current) setSelected(created.id);
                }, "本轮补料已启动，过程与请求次数保存在日志中")
              }
            >
              按方向自动补料
            </Button>
          </div>
          <small className="supply-muted">
            关键词用空格或逗号分开，最多使用前5个。只负责准备编辑资料，不自动确认权利、审阅或发布。
          </small>
        </>
      ) : null}
      {error ? <Notice danger>{error}</Notice> : null}
      {query.data?.runs.length ? (
        <>
          <Select
            aria-label="选择补料记录"
            value={run?.id ?? ""}
            items={query.data.runs.map((item) => ({
              value: item.id,
              label: `${formatTime(item.createdAt)} · ${item.context.keyword}`,
            }))}
            onValueChange={(id) => {
              setSelected(id);
              setConfirmed(false);
            }}
          />
          {run ? (
            <>
              <div className="row">
                <Status
                  kind={
                    run.status === "attention"
                      ? "warning"
                      : run.status === "completed"
                        ? "good"
                        : "normal"
                  }
                >
                  {
                    (
                      {
                        running: "补料中",
                        paused: "已暂停",
                        completed: "本轮已结束",
                        attention: "需处理",
                      } as Record<SupplyAcquireRun["status"], string>
                    )[run.status]
                  }
                </Status>
                <span className="supply-muted">
                  新请求 {run.requestsUsed}/{run.policy.requestsPerRun} · 匹配{" "}
                  {run.sourceIds.length} 份 · 编辑单 {run.draftIds.length} 份
                </span>
                {query.data.busy && run.status === "running" ? (
                  <Button
                    size="compact"
                    disabled={busy}
                    onClick={() =>
                      void action(
                        () => ipc("contentSupply.acquirePause"),
                        "当前请求完成归档后暂停后续补料",
                      )
                    }
                  >
                    暂停本轮
                  </Button>
                ) : null}
                {["paused", "attention"].includes(run.status) ? (
                  <Button
                    size="compact"
                    disabled={busy || query.data.busy || !confirmed}
                    onClick={() =>
                      void action(
                        () =>
                          ipc("contentSupply.acquireResume", {
                            id: run.id,
                            confirmed: true,
                          }),
                        "已继续原补料，保留本轮请求总上限",
                      )
                    }
                  >
                    授权后继续原补料
                  </Button>
                ) : null}
                {run.draftIds[0] ? (
                  <Button
                    size="compact"
                    onClick={() => onOpenDraft(run.draftIds[0])}
                  >
                    查看本轮编辑单
                  </Button>
                ) : null}
              </div>
              <p className="supply-muted">{run.reason}</p>
              {run.warnings.length ? (
                <details className="supply-details">
                  <summary>材料缺失与范围说明 · {run.warnings.length}</summary>
                  <ul>
                    {run.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
