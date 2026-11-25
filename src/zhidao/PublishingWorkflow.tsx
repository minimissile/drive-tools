import { PublishingKeywordPlan } from "./PublishingKeywordPlan";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
} from "lucide-react";
import {
  publishingSteps,
  publishingContentReviewed,
  publishingLinkIssue,
  publishingRowShare,
  publishingRowsWithLinks,
  type PublishingQuestion,
  type PublishingDestination,
} from "../../shared/zhidao-workflow";
import {
  parseResourceKeywordText,
  resourceKeywordLimit,
} from "../../shared/resource-keywords";
import { useAppData, useAppNavigation } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { readDraft } from "../storage/local-draft";
import { windowStorage } from "../storage/window-storage";
import { useIpcQuery } from "../api/useIpcQuery";
import { Button, Notice, Panel, Field, Empty, Header } from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { LoadingState } from "../ui/DataState";
import { IntakeKeywords } from "../resources/IntakeKeywords";
import { useOperationAction } from "./hooks";
import {
  publishingDraftSchema,
  publishingReviewDraftKey,
  publishingReviewDraftSchema,
  resourceEntryIssue,
  type PublishingDraftRow,
} from "./publishing-draft";
import { PublishingResources } from "./PublishingResources";
import { PublishingReview } from "./PublishingReview";
import { PublishingGenerationRecovery } from "./PublishingGenerationRecovery";
import {
  PublishingPreview,
  type PublishingPreviewGroup,
} from "./PublishingPreview";
import { usePublishingGeneration } from "./usePublishingGeneration";
import { usePublishingPreparation } from "./usePublishingPreparation";
import { PublishingKeywordBatch } from "./PublishingKeywordBatch";
import { usePublishingKeywordBatch } from "./usePublishingKeywordBatch";
import "./publishing-workflow.css";

import { PublishingSubmit } from "./PublishingSubmit";
import type { OperationRun } from "../../shared/zhidao";

export function PublishingWorkflow({
  headerActions,
  onShowRun,
}: {
  headerActions?: ReactNode;
  onShowRun(run: OperationRun): void;
}) {
  const { data } = useAppData();
  const dataPath = data!.dataPath;
  const { navigate, edit } = useAppNavigation();
  const action = useOperationAction();
  const draft = useLocalDraft(
    `panxu-zhidao-publishing-workflow:${dataPath}`,
    {
      flowVersion: 2 as const,
      step: 0,
      accountId: "",
      rows: [] as PublishingDraftRow[],
      activeKey: "",
      pendingReviews: [] as string[],
      reviewVersions: {} as Record<
        string,
        { generationId?: string; legacyUpgraded?: true }
      >,
      keywordBatchId: "",
      keywordBatchApplied: [] as string[],
    },
    (raw) => publishingDraftSchema.parse(raw),
  );
  const { rows, step } = draft.value;
  const ids = rows.map((r) => r.key);
  const records = useIpcQuery(
    "zhidao.workflow.get",
    { ids },
    {
      enabled: ids.length > 0,
      keepPrevious: true,
      refreshInterval: step === 2 || step === 3 ? 2500 : 0,
    },
  );
  const currentRecords = (records.data ?? []).filter((r) => ids.includes(r.id));
  const recordsById = new Map(
    currentRecords.map((record) => [record.id, record]),
  );
  const findRecord = (row: PublishingDraftRow) => recordsById.get(row.key);
  const [searching, setSearching] = useState(false);
  const runningChange = useCallback(
    (value: boolean) => setSearching(value),
    [],
  );
  const [previewGroups, setPreviewGroups] = useState<PublishingPreviewGroup[]>(
    [],
  );
  const reviewDrafts = useRef(new Map<string, PublishingQuestion[]>());
  const preparation = usePublishingPreparation(
    draft.value,
    draft.update,
    records.reload,
  );
  const generation = usePublishingGeneration(
    draft.value,
    draft.update,
    records.reload,
  );
  const busy =
    !!action.pending || searching || preparation.pending || generation.pending;
  const readyRows = rows.filter((row) => findRecord(row)?.stage === "ready");
  const openPreview = (destination?: PublishingDestination) => {
    setPreviewGroups(
      rows.flatMap((row) => {
        const record = findRecord(row);
        if (!record?.rows.length) return [];
        const version = draft.value.reviewVersions[row.key] ?? {
          legacyUpgraded: record.legacyUpgraded,
          generationId: draft.value.pendingReviews.includes(row.key)
            ? undefined
            : record.generation?.id,
        };
        const reviewKey = publishingReviewDraftKey(
          dataPath,
          record.id,
          version.legacyUpgraded,
          version.generationId,
        );
        const edited =
          reviewDrafts.current.get(reviewKey) ??
          readDraft(windowStorage, reviewKey, (raw) =>
            publishingReviewDraftSchema.parse(raw),
          )?.rows;
        const previewRows =
          edited?.length &&
          edited.every((question, index) =>
            record.contentFirst
              ? record.rows.some((saved) => saved.id === question.id)
              : question.keyword === record.rows[index]?.keyword,
          )
            ? edited
            : record.rows;
        return [
          {
            id: record.id,
            title: row.title,
            pendingLinks: step !== 4,
            rows:
              step === 4
                ? publishingRowsWithLinks(record, previewRows, destination)
                : previewRows,
          },
        ];
      }),
    );
  };
  const unpreparedCount = rows.length - readyRows.length;
  const navigableRows = rows;
  const active =
    navigableRows.find((row) => row.key === draft.value.activeKey) ??
    navigableRows[0];
  const activeRecord = active && findRecord(active);
  const editingVersion = (active && draft.value.reviewVersions[active.key]) ?? {
    legacyUpgraded: activeRecord?.legacyUpgraded,
    generationId:
      active && draft.value.pendingReviews.includes(active.key)
        ? undefined
        : activeRecord?.generation?.id,
  };
  const generationConflict =
    !!activeRecord &&
    draft.value.pendingReviews.includes(activeRecord.id) &&
    editingVersion.generationId !== activeRecord.generation?.id;
  const missingGenerationRows = rows.filter(
    (row) => !findRecord(row)?.contentFirst || !findRecord(row)?.rows.length,
  );
  const entryIssue = resourceEntryIssue(rows);
  const checked =
    !entryIssue &&
    rows.every(
      (r) =>
        r.checked &&
        parseResourceKeywordText(r.keywords.text).length > 0 &&
        parseResourceKeywordText(r.keywords.text).length <=
          resourceKeywordLimit,
    );
  const pendingPreparation = rows.filter((row) => {
    const record = findRecord(row);
    return (
      record?.stage !== "ready" &&
      !record?.transferBlocked &&
      (!!row.resourceId || !!draft.value.accountId)
    );
  });
  const titles = currentRecords.flatMap((record) =>
    record.rows.map((row) =>
      row.question
        .trim()
        .normalize("NFKC")
        .replace(/[\p{P}\s]/gu, "")
        .toLowerCase(),
    ),
  );
  const duplicateTitles = new Set(titles).size !== titles.length;
  const reviewed =
    checked &&
    !duplicateTitles &&
    rows.every((row) => {
      const record = findRecord(row);
      return (
        publishingContentReviewed(record) &&
        !draft.value.pendingReviews.includes(row.key)
      );
    });
  const replaceRows = (next: PublishingDraftRow[]) => {
    const updated = next.map((row) => {
      const previous = rows.find((r) => r.key === row.key);
      const record = previous && findRecord(previous);
      const content = (r: PublishingDraftRow) =>
        JSON.stringify([
          r.title,
          r.link,
          r.category,
          r.summary,
          r.image,
          parseResourceKeywordText(r.keywords.text),
        ]);
      const changed = !!previous && content(previous) !== content(row);
      if ((previous?.prepared || record) && changed) {
        return {
          ...row,
          key: crypto.randomUUID(),
          prepared: false,
          checked: false,
          resourceId: record?.libraryResourceId || row.resourceId,
          copyId: record?.copyId || row.copyId,
        };
      }
      return changed ? { ...row, checked: false } : row;
    });
    draft.update({
      rows: updated,
      pendingReviews: draft.value.pendingReviews.filter((id) =>
        updated.some((row) => row.key === id),
      ),
      reviewVersions: Object.fromEntries(
        Object.entries(draft.value.reviewVersions).filter(([id]) =>
          updated.some((row) => row.key === id),
        ),
      ),
      activeKey:
        updated[rows.findIndex((r) => r.key === draft.value.activeKey)]?.key ??
        updated[0]?.key ??
        "",
    });
  };
  const patch = (row: PublishingDraftRow, patch: Partial<PublishingDraftRow>) =>
    replaceRows(rows.map((r) => (r.key === row.key ? { ...r, ...patch } : r)));
  const goToStep = (target: number, generateMissing = false) => {
    if (target === step) return;
    if (target === 2 && generateMissing && missingGenerationRows.length) {
      draft.update({ step: 2, activeKey: missingGenerationRows[0].key });
      void generation.start(missingGenerationRows);
      return;
    }
    draft.update({
      step: target,
      ...(step === 0 && target === 1
        ? {
            rows: rows.map((row) =>
              !row.checked && !row.keywords.seeds.trim()
                ? {
                    ...row,
                    keywords: {
                      ...row.keywords,
                      seeds: row.title.slice(0, 100),
                    },
                  }
                : row,
            ),
          }
        : {}),
    });
  };
  const keywordBatch = usePublishingKeywordBatch(
    draft.value,
    draft.update,
    replaceRows,
  );
  const available = [
    true,
    !entryIssue,
    !!checked && !keywordBatch.running,
    !!reviewed && !records.error,
    !!reviewed && unpreparedCount === 0 && !publishingLinkIssue(currentRecords),
  ];
  const resourceNavigation = navigableRows.length ? (
    <div className="publishing-resource-navigation" aria-label="逐份资源检查">
      {navigableRows.map((row) => (
        <Button
          key={row.key}
          quiet
          title={row.title}
          className={active?.key === row.key ? "is-current" : ""}
          onClick={() => draft.update({ activeKey: row.key })}
          disabled={busy}
          aria-pressed={active?.key === row.key}
        >
          <span>
            {rows.indexOf(row) + 1}. {row.title}
          </span>
          {(
            step === 1
              ? row.checked
              : !draft.value.pendingReviews.includes(row.key) &&
                !!findRecord(row)?.rows.length &&
                findRecord(row)?.rows.every((q) => q.reviewed)
          ) ? (
            <Check size={14} />
          ) : null}
        </Button>
      ))}
    </div>
  ) : null;
  return (
    <div className="publishing-workflow">
      <div className="publishing-workflow-heading">
        <Header title="问答发布" />
        <ol className="publishing-steps" aria-label="问答表格制作进度">
          {publishingSteps.map((label, index) => {
            const complete =
              index < step && (index !== 3 || unpreparedCount === 0);
            return (
              <li
                key={label}
                data-state={
                  step === index
                    ? "current"
                    : complete
                      ? "complete"
                      : "upcoming"
                }
                aria-current={step === index ? "step" : undefined}
              >
                <button
                  disabled={busy || (!available[index] && index !== step)}
                  onClick={() => goToStep(index)}
                >
                  <span aria-hidden="true">
                    {complete ? <Check size={14} /> : index + 1}
                  </span>
                  {label}
                </button>
              </li>
            );
          })}
        </ol>
        {headerActions}
      </div>
      {generation.error && activeRecord?.generation?.status !== "failed" ? (
        <Notice danger>{generation.error}</Notice>
      ) : null}
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
      <QueryError
        error={records.error}
        loading={records.loading}
        onRetry={records.reload}
        title="无法读取资源处理记录"
      />
      {step === 0 ? (
        <PublishingResources rows={rows} onChange={replaceRows} />
      ) : null}
      {step === 1 ? (
        <PublishingKeywordBatch
          model={keywordBatch}
          count={rows.filter((row) => !row.checked).length}
          disabled={busy || !!entryIssue}
        >
          {resourceNavigation}
        </PublishingKeywordBatch>
      ) : null}
      {step === 2 ? resourceNavigation : null}
      {step === 1 && active ? (
        <>
          {active.checked ? (
            <Panel
              title={active.title}
              extra={
                <div className="publishing-saved-word-actions">
                  <span className="muted">
                    {parseResourceKeywordText(active.keywords.text).length} 个词
                    · {active.resourceId ? "已跳过重复检查" : "已确认"}
                  </span>
                  <Button onClick={() => patch(active, { checked: false })}>
                    修改关键词
                  </Button>
                </div>
              }
            >
              <ul
                className="publishing-saved-words"
                aria-label="已确认关键词"
                tabIndex={0}
              >
                {parseResourceKeywordText(active.keywords.text).map((word) => (
                  <li key={word}>{word}</li>
                ))}
              </ul>
            </Panel>
          ) : (
            <>
              <IntakeKeywords
                layout="columns"
                key={active.key}
                title={active.title}
                value={active.keywords}
                onChange={(keywords) =>
                  patch(active, { keywords, checked: false })
                }
                wordCount={
                  parseResourceKeywordText(active.keywords.text).length
                }
                locked={!!action.pending}
                running={searching}
                onRunningChange={runningChange}
                lookupLocked={keywordBatch.running}
              />
              <div className="publishing-keyword-confirm">
                <span className="muted">
                  删去不相关或误导的词，再确认这份资源。关键词不会自动等同于可发布的问题。
                </span>
                <Button
                  primary
                  disabled={
                    busy ||
                    !parseResourceKeywordText(active.keywords.text).length ||
                    parseResourceKeywordText(active.keywords.text).length > 100
                  }
                  onClick={() => {
                    patch(active, { checked: true });
                    const following = rows.find(
                      (r) => r.key !== active.key && !r.checked,
                    );
                    if (following) draft.update({ activeKey: following.key });
                  }}
                >
                  确认这份资源的关键词
                </Button>
              </div>
            </>
          )}
        </>
      ) : null}
      {step === 3 ? (
        <Panel
          title="按已确认问答准备独立链接"
          extra={
            preparation.pending ? (
              <Button
                disabled={preparation.stopping}
                onClick={() => void preparation.stop()}
              >
                {preparation.stopping ? "正在停止…" : "停止准备"}
              </Button>
            ) : (
              <Button
                primary
                disabled={busy || !reviewed || !pendingPreparation.length}
                onClick={() => void preparation.start(pendingPreparation)}
              >
                准备所有待处理资源
              </Button>
            )
          }
        >
          <div className="publishing-preparation-settings">
            {rows.some((r) => !r.resourceId) ? (
              <Field label="库外资源转存到">
                <Select
                  value={draft.value.accountId}
                  onValueChange={(accountId) => draft.update({ accountId })}
                  disabled={
                    busy ||
                    rows.some((r) => !r.resourceId && !!findRecord(r)?.copyId)
                  }
                  items={[
                    { value: "", label: "选择百度网盘账号" },
                    ...data!.accounts
                      .filter((a) => a.provider === "baidu" && a.enabled)
                      .map((a) => ({ value: a.id, label: a.alias })),
                  ]}
                />
              </Field>
            ) : null}
            <p className="publishing-help">
              每条已确认问答使用一个独立链接，库中资源跳过转存。已完成的链接直接复用。
              <span>停止后保留已有结果，已提交的转存仍在原队列执行。</span>
            </p>
          </div>
          <div className="publishing-preparation-list">
            {rows.map((row) => {
              const record = findRecord(row);
              const recovery = record?.transferRecovery;
              const login = recovery?.stage === "waiting_login";
              const viewTasks = record?.transferBlocked && !recovery;
              const error =
                record?.stage === "ready" || record?.stage === "transferring"
                  ? ""
                  : preparation.errors[row.key];
              let actionLabel = record?.copyId ? "创建分享" : "准备并创建分享";
              if (
                record?.stage === "failed" &&
                record.shareCheck?.status === "unavailable"
              )
                actionLabel = "重新检查并继续";
              if (record?.stage === "uncertain") actionLabel = "核对分享并继续";
              if (record?.stage === "transferring") actionLabel = "转存进行中";
              if (record?.stage === "ready") actionLabel = "分享已准备";
              if (viewTasks) actionLabel = "查看转存任务";
              if (recovery) {
                if (login) actionLabel = "登录原账号";
                else
                  actionLabel =
                    recovery.stage === "needs_review"
                      ? "核对并恢复"
                      : "恢复转存";
              }
              const questionCount = record?.rows.length ?? 0;
              const linkCount =
                record?.rows.filter((question, index) =>
                  publishingRowShare(record, question, index),
                ).length ?? 0;
              return (
                <div key={row.key} className="publishing-preparation-row">
                  <div className="publishing-preparation-info">
                    <strong>{row.title}</strong>
                    <span className="muted">
                      {row.resourceId ? "库中 · 原账号副本" : "库外 · 先转存"} ·{" "}
                      {questionCount} 条问答 · 独立链接 {linkCount} /{" "}
                      {questionCount}
                    </span>
                    <p
                      role="status"
                      data-error={
                        !!error ||
                        record?.stage === "failed" ||
                        record?.stage === "uncertain"
                      }
                    >
                      {error || record?.message || "等待准备资源"}
                    </p>
                    {record?.lastShareMs !== undefined ||
                    record?.connectionMs !== undefined ? (
                      <small className="muted">
                        {record?.connectionMs !== undefined
                          ? `本批账号连接 ${(record.connectionMs / 1000).toFixed(1)} 秒`
                          : ""}
                        {record?.connectionMs !== undefined &&
                        record?.lastShareMs !== undefined
                          ? " · "
                          : ""}
                        {record?.lastShareMs !== undefined
                          ? `上一条分享创建 ${(record.lastShareMs / 1000).toFixed(1)} 秒`
                          : ""}
                      </small>
                    ) : null}
                  </div>
                  <div className="publishing-preparation-actions">
                    <Button
                      disabled={
                        busy ||
                        !reviewed ||
                        record?.stage === "transferring" ||
                        record?.stage === "ready" ||
                        (!record?.copyId &&
                          !row.resourceId &&
                          !draft.value.accountId)
                      }
                      onClick={() => {
                        if (login && record)
                          void action.run(
                            "account.login",
                            { id: record.accountId },
                            records.reload,
                          );
                        else if (recovery)
                          void preparation.resume(row, recovery.jobId);
                        else if (viewTasks) navigate("tasks");
                        else void preparation.start([row]);
                      }}
                    >
                      {actionLabel}
                    </Button>
                    {row.resourceId && (record?.stage === "failed" || error) ? (
                      <Button
                        quiet
                        disabled={busy}
                        onClick={() => edit(row.resourceId, row.copyId)}
                      >
                        查看资源
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      ) : null}
      {step === 2 && active ? (
        <Panel
          title={
            activeRecord?.rows.length ? undefined : `检查问答 · ${active.title}`
          }
          className="publishing-review-panel"
        >
          {activeRecord ? (
            <PublishingKeywordPlan record={activeRecord} />
          ) : null}
          {duplicateTitles ? (
            <Notice warning>
              存在重复的问题标题，请逐份资源修改后保存，再下载表格。
            </Notice>
          ) : null}
          {generationConflict ? (
            <Notice warning>
              这份问答已在其他窗口更新。当前未保存编辑仍保留，请先复制需要的内容，再查看新版。
              <Button
                quiet
                disabled={activeRecord?.generation?.status !== "completed"}
                onClick={() =>
                  draft.update({
                    pendingReviews: draft.value.pendingReviews.filter(
                      (id) => id !== active.key,
                    ),
                    reviewVersions: Object.fromEntries(
                      Object.entries(draft.value.reviewVersions).filter(
                        ([id]) => id !== active.key,
                      ),
                    ),
                  })
                }
              >
                保留草稿并查看新版
              </Button>
            </Notice>
          ) : null}
          {activeRecord && !activeRecord.contentFirst ? (
            <Notice warning>
              旧稿与分享记录已保留。请按新流程重新生成最多20条问答，确认后再准备独立链接。
              <Button
                disabled={busy}
                onClick={() => void generation.start([active])}
              >
                按新流程生成问答
              </Button>
            </Notice>
          ) : activeRecord?.generation &&
            activeRecord.generation.status !== "completed" &&
            !generationConflict ? (
            <>
              <p className="publishing-help" role="status">
                {activeRecord.contentFirst &&
                !activeRecord.generation.topics ? (
                  activeRecord.generation.status === "running" ? (
                    "正在归并相关关键词，整理最多20条问答。"
                  ) : (
                    "关键词归并未完成，请核对错误后继续。"
                  )
                ) : (
                  <>
                    AI 标题与简介 · 已完成{" "}
                    {activeRecord.generation.drafts.length} /{" "}
                    {activeRecord.generation.targets.length}{" "}
                    条。已完成批次与原有问答保留。
                  </>
                )}
              </p>
              {activeRecord.generation.status === "running" ? (
                <LoadingState
                  compact
                  label={
                    activeRecord.generation.topics &&
                    activeRecord.generation.drafts.length ===
                      activeRecord.generation.targets.length
                      ? "正在检查问答意图与相似内容…"
                      : "正在使用 AI 生成标题与简介…"
                  }
                />
              ) : (
                <>
                  {activeRecord.generation.validation?.status === "failed" ? (
                    <PublishingGenerationRecovery
                      record={activeRecord}
                      busy={busy}
                      onCorrect={() =>
                        void action
                          .run("zhidao.workflow.generate", {
                            id: active.key,
                            optimize: true,
                          })
                          .finally(records.reload)
                      }
                      onAdjust={() => draft.update({ step: 1 })}
                    />
                  ) : (
                    <>
                      <Notice warning>
                        {activeRecord.generation.message ||
                          "AI 生成尚未完成，请核对后继续。"}
                      </Notice>
                      {activeRecord.generation.topics &&
                      !activeRecord.generation.topics.length ? (
                        <Button
                          primary
                          disabled={busy}
                          onClick={() => draft.update({ step: 1 })}
                        >
                          返回调整关键词
                        </Button>
                      ) : (
                        <Button
                          primary
                          disabled={busy}
                          onClick={() =>
                            void action
                              .run("zhidao.workflow.generate", {
                                id: active.key,
                              })
                              .finally(records.reload)
                          }
                        >
                          {activeRecord.generation.planVersion === 2 &&
                          activeRecord.generation.drafts.length ===
                            activeRecord.generation.targets.length
                            ? "重新检查问答"
                            : "继续生成剩余问答"}
                        </Button>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          ) : activeRecord?.rows.length ? (
            <PublishingReview
              key={publishingReviewDraftKey(
                dataPath,
                active.key,
                editingVersion.legacyUpgraded,
                editingVersion.generationId,
              )}
              record={activeRecord}
              pending={draft.value.pendingReviews.includes(active.key)}
              onPreview={openPreview}
              upgrading={action.pending === "zhidao.workflow.generate"}
              editingVersion={editingVersion}
              conflict={generationConflict}
              onOptimize={() => {
                if (busy || draft.value.pendingReviews.includes(active.key))
                  return;
                void action
                  .run(
                    "zhidao.workflow.generate",
                    { id: active.key, optimize: true },
                    (updated) => {
                      reviewDrafts.current.delete(
                        publishingReviewDraftKey(
                          dataPath,
                          active.key,
                          activeRecord.legacyUpgraded,
                          activeRecord.generation?.id,
                        ),
                      );
                      records.setData(
                        currentRecords.map((record) =>
                          record.id === updated.id ? updated : record,
                        ),
                      );
                      records.reload();
                    },
                    "AI 优化完成，请重新核对未确认问答",
                  )
                  .finally(records.reload);
              }}
              onDirty={() => {
                draft.update({
                  pendingReviews: [
                    ...new Set([...draft.value.pendingReviews, active.key]),
                  ],
                  reviewVersions: {
                    ...draft.value.reviewVersions,
                    [active.key]: editingVersion,
                  },
                });
              }}
              onSaved={() => {
                draft.update({
                  pendingReviews: draft.value.pendingReviews.filter(
                    (id) => id !== active.key,
                  ),
                  reviewVersions: Object.fromEntries(
                    Object.entries(draft.value.reviewVersions).filter(
                      ([id]) => id !== active.key,
                    ),
                  ),
                });
                records.reload();
              }}
              onTextChange={(updated) =>
                reviewDrafts.current.set(
                  publishingReviewDraftKey(
                    dataPath,
                    active.key,
                    editingVersion.legacyUpgraded,
                    editingVersion.generationId,
                  ),
                  updated,
                )
              }
            />
          ) : action.pending === "zhidao.workflow.generateMany" ||
            generation.pending ||
            records.loading ? (
            <LoadingState compact label="正在使用 AI 生成标题与简介…" />
          ) : (
            <Empty
              compact
              icon={FileSpreadsheet}
              title="根据关键词生成问答表格行"
              action={
                <Button
                  primary
                  disabled={busy || !!records.error}
                  onClick={() => void generation.start(missingGenerationRows)}
                >
                  AI 生成待生成问答（{missingGenerationRows.length}份）
                </Button>
              }
            >
              AI
              会合并相近搜索意图，生成1–20条不同的标题和介绍，自然融入相关关键词。请先检查和删减问答，再按实际条数准备链接。使用文案创作模型与现有预算。
            </Empty>
          )}
        </Panel>
      ) : null}
      {step === 2 && !active && !records.error ? (
        <Panel title="检查问答">
          {records.loading ? (
            <LoadingState compact label="正在读取资源处理记录…" />
          ) : (
            <Empty compact icon={FileSpreadsheet} title="暂无可检查的问答">
              返回检查关键词，再使用 AI 生成问答。
            </Empty>
          )}
        </Panel>
      ) : null}
      {previewGroups.length ? (
        <PublishingPreview
          groups={previewGroups}
          onClose={() => setPreviewGroups([])}
        />
      ) : null}
      {step === 4 ? (
        !currentRecords.length ? (
          !records.error ? (
            <LoadingState compact label="正在读取本批问答与上传任务…" />
          ) : null
        ) : (
          <PublishingSubmit
            records={currentRecords}
            ready={!!available[4] && !records.error}
            onPreview={openPreview}
            onChanged={records.reload}
            onShowRun={onShowRun}
          />
        )
      ) : null}
      <div className="publishing-workflow-footer">
        <div>
          {step === 0 && entryIssue ? (
            <span className="muted">{entryIssue}</span>
          ) : step === 1 ? (
            <span className="muted">
              已确认 {rows.filter((r) => r.checked).length} / {rows.length}{" "}
              份资源
              {missingGenerationRows.length
                ? " · 下一步使用文案模型生成问答，按现有预算计费"
                : ""}
            </span>
          ) : (
            <span className="muted">
              输入自动暂存；返回修改会重新检查后续步骤。
            </span>
          )}
        </div>
        <div>
          <Button
            disabled={busy || step === 0}
            onClick={() => draft.update({ step: step - 1 })}
          >
            <ChevronLeft size={15} />
            上一步
          </Button>
          {step < 4 ? (
            <Button
              primary
              disabled={busy || !available[step + 1] || !!records.error}
              onClick={() => goToStep(Math.min(4, step + 1), true)}
            >
              下一步：
              {step === 1 && missingGenerationRows.length
                ? "AI 生成问答"
                : publishingSteps[step + 1]}
              <ChevronRight size={15} />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
