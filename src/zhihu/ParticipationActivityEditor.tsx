import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type {
  ZhihuParticipationActivity,
  ZhihuParticipationCandidate,
} from "../../shared/zhihu-participation";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatTime } from "../lib/format";
import { Button, Field, Notice, Panel, Status } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import type { ParticipationAccount } from "./Participation";
import { ParticipationContext } from "./ParticipationContext";
import { ParticipationResolution } from "./ParticipationResolution";
import { ParticipationAttempts } from "./ParticipationAttempts";
import { ParticipationQueue } from "./ParticipationQueue";
import {
  participationKindLabels,
  participationStatusLabels,
  participationStatusKind,
  type ParticipationAction,
} from "./participation-state";

const draftSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().max(2000),
  draft: z.string().max(12000),
  title: z.string().max(100),
  basis: z.string().max(4000),
});
function fieldsFor(
  a: ZhihuParticipationActivity,
  c?: ZhihuParticipationCandidate,
) {
  return {
    version: a.version,
    reason: a.reason,
    draft: a.draft,
    title: (a.context?.title || c?.title || "").slice(0, 100),
    basis: a.basis,
  };
}

export function ParticipationActivityEditor({
  activity: incoming,
  candidate: c,
  account,
  scope,
  busy,
  run,
  onOpenContents,
}: {
  activity: ZhihuParticipationActivity;
  candidate?: ZhihuParticipationCandidate;
  account: ParticipationAccount;
  scope: string;
  busy: boolean;
  run: ParticipationAction;
  onOpenContents(): void;
}) {
  const [receipt, setReceipt] = useState<ZhihuParticipationActivity | null>(
    null,
  );
  const a = receipt && receipt.version > incoming.version ? receipt : incoming;
  const editor = useLocalDraft(
    `panxu-zhihu-participation-activity-v1:${scope}:${a.id}`,
    fieldsFor(a, c),
    (value) => draftSchema.parse(value),
  );
  const [confirmed, setConfirmed] = useState(false),
    [resolve, setResolve] = useState<"done" | "skipped" | null>(null);
  const mounted = useRef(true),
    latest = useRef(editor.value);
  latest.current = editor.value;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setConfirmed(false);
  }, [
    a.version,
    c?.version,
    editor.value.title,
    editor.value.draft,
    editor.value.basis,
  ]);
  const stale = a.version !== editor.value.version;
  const contextStale = !!c && c.version !== a.candidateVersion;
  const attempts = a.attempts ?? [];
  const queued = a.status === "queued";
  const frozen =
    !!a.contentId || !!a.resolution || attempts.length > 0 || queued;
  const url = a.context?.url || c?.url;
  const open = (value: string) =>
    void run(
      () => ipc("websiteAccounts.openDocument", { id: account.id, url: value }),
      "已在对应账号打开官方原页，未登记本人完成状态",
    );
  const save = () => {
    const submitted = editor.value;
    void run(
      () =>
        ipc("zhihu.participation.save", {
          id: a.id,
          version: submitted.version,
          reason: submitted.reason,
          draft: submitted.draft,
        }),
      "参与任务文字已保存，本次保存未提交到知乎",
    ).then((result) => {
      if (result.ok && mounted.current) {
        setReceipt(result.value);
        if (JSON.stringify(latest.current) === JSON.stringify(submitted))
          editor.update({
            version: result.value.version,
            reason: result.value.reason,
            draft: result.value.draft,
          });
      }
    });
  };
  const answer = () => {
    const submitted = editor.value;
    void run(
      () =>
        ipc("zhihu.participation.answer", {
          id: a.id,
          version: submitted.version,
          title: submitted.title,
          body: submitted.draft,
          basis: submitted.basis,
          confirmed: true,
        }),
      "回答稿已交付知乎素材池，初始未审核、未发布",
    ).then((result) => {
      if (result.ok && mounted.current) {
        setReceipt(result.value.activity);
        setConfirmed(false);
        if (JSON.stringify(latest.current) === JSON.stringify(submitted))
          editor.update({
            version: result.value.activity.version,
            draft: result.value.activity.draft,
            basis: result.value.activity.basis,
          });
      }
    });
  };
  const reconcile = () => {
    void run(
      () =>
        ipc("zhihu.participation.reconcile", { id: a.id, version: a.version }),
      (activity) =>
        activity.status === "succeeded"
          ? {
              message: "已通过原账号官方页面核对执行状态，未重新提交",
              kind: "success",
            }
          : {
              message: "只读核对已完成，结果仍未确认；保留待核对记录，不会重发",
              kind: "warning",
            },
    ).then((result) => {
      if (result.ok && mounted.current) setReceipt(result.value);
    });
  };
  return (
    <Panel
      title={`${participationKindLabels[a.kind]} · ${a.context?.title || c?.title || "原候选暂不可读"}`}
      extra={
        <Status kind={participationStatusKind(a.status)}>
          {participationStatusLabels[a.status]}
        </Status>
      }
    >
      <div className="participation-detail">
        <div className="participation-actions">
          {url ? (
            <Button size="compact" disabled={busy} onClick={() => open(url)}>
              用此账号打开原页
            </Button>
          ) : null}
          {a.contentId ? (
            <Button size="compact" onClick={onOpenContents}>
              在知乎素材池查看原稿
            </Button>
          ) : null}
        </div>
        {url ? <p className="participation-source">{url}</p> : null}
        <p className="participation-meta">
          账号 {account.nickname || account.alias} · 任务 v{a.version} ·
          候选快照 v{a.candidateVersion}
          <br />
          创建 {formatTime(a.createdAt)} ·{" "}
          {a.scheduledAt
            ? `${queued ? "预计提交" : "计划"} ${formatTime(a.scheduledAt)}`
            : "未指定时间"}
        </p>
        {a.context ? (
          <details className="participation-details">
            <summary>查看安排时保存的上下文快照</summary>
            <ParticipationContext
              document={a.context}
              open={open}
              busy={busy}
            />
          </details>
        ) : (
          <Notice>
            任务尚未保存完整上下文。若要准备回答或调整互动安排，请先读取原候选。
          </Notice>
        )}
        {a.contentId ? (
          <Notice>
            已交付素材池：{a.contentId}
            。审核与发布在原素材池及发布队列处理，本记录不代表已发布。
          </Notice>
        ) : null}
        {!attempts.length ? <ParticipationQueue activity={a} /> : null}
        <ParticipationAttempts
          attempts={attempts}
          accountName={account.nickname || account.alias}
          busy={busy}
          canReconcile={a.status === "attention"}
          open={open}
          reconcile={reconcile}
        />
        {a.resolution ? (
          <div className="participation-resolution">
            <strong>本人记录 · 非知乎官方回执</strong>
            <p>
              {a.resolution.outcome === "done"
                ? "本人记录已处理"
                : "本人记录不采用"}{" "}
              · {formatTime(a.resolution.at)}
            </p>
            <p>{a.resolution.note}</p>
          </div>
        ) : null}
        {editor.error && !frozen ? (
          <Notice warning>{editor.error}</Notice>
        ) : null}
        {stale && !frozen ? (
          <Notice warning>
            任务已更新至 v{a.version}，本机暂存仍为 v{editor.value.version}
            ，没有覆盖你的文字。
            <Button
              quiet
              size="compact"
              disabled={busy}
              onClick={() => editor.update(fieldsFor(a, c))}
            >
              加载当前任务记录
            </Button>
          </Notice>
        ) : null}
        {!frozen && ["comment", "like", "follow"].includes(a.kind) ? (
          <p className="participation-meta">
            {a.planId
              ? "保存文字不代表已排队执行。关联计划须另行授权知乎相关参与，并由AI结合当前上下文、额度和间隔判定；实际结果以执行记录为准。"
              : "本项为独立参与任务，不会自主执行。可在官网自行处理后保存本人记录。"}
          </p>
        ) : null}
        {contextStale && !frozen ? (
          <Notice warning>
            原候选已有新上下文，当前任务仍保留旧依据。请回候选页核对后重新安排原任务，再核对稿件；不能直接据旧版本交付回答。
          </Notice>
        ) : null}
        {attempts.length ? (
          <div className="participation-decision">
            <strong>原任务安排理由</strong>
            <p>{a.reason}</p>
          </div>
        ) : (
          <fieldset className="participation-fields" disabled={busy || frozen}>
            <div className="wide">
              <Field label="安排理由" hint="至少5字">
                <textarea
                  value={frozen ? a.reason : editor.value.reason}
                  maxLength={2000}
                  onChange={(e) => editor.update({ reason: e.target.value })}
                />
              </Field>
            </div>
            {a.kind === "answer" ? (
              <div className="wide">
                <Field label="待审回答标题">
                  <input
                    value={frozen ? fieldsFor(a, c).title : editor.value.title}
                    maxLength={100}
                    onChange={(e) => editor.update({ title: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}
            <div className="wide">
              <Field
                label={
                  a.kind === "answer"
                    ? "回答正文（30–12,000字）"
                    : a.kind === "comment"
                      ? "评论正文（未提交）"
                      : "参与笔记"
                }
              >
                <textarea
                  className={
                    a.kind === "answer" ? "participation-answer-body" : ""
                  }
                  value={frozen ? a.draft : editor.value.draft}
                  maxLength={12000}
                  placeholder={
                    a.kind === "answer"
                      ? "基于真实问题和上下文起草回答，保存时保留AI辅助标识"
                      : "按真实上下文记录；保存文字本身不会提交"
                  }
                  onChange={(e) => editor.update({ draft: e.target.value })}
                />
              </Field>
            </div>
            {a.kind === "answer" ? (
              <div className="wide">
                <Field
                  label="回答依据（至少10字）"
                  hint="说明哪些事实来自此问题上下文，哪些内容是自己的说明"
                >
                  <textarea
                    value={frozen ? a.basis : editor.value.basis}
                    maxLength={4000}
                    onChange={(e) => editor.update({ basis: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}
          </fieldset>
        )}
        {!frozen ? (
          <>
            {a.kind === "answer" ? (
              <CheckboxField
                checked={confirmed}
                disabled={
                  busy ||
                  stale ||
                  contextStale ||
                  !c?.document ||
                  c.document.truncated
                }
                onChange={(e) => setConfirmed(e.target.checked)}
                label="我已核对当前问题、回答正文和依据，保存为待审核素材"
              />
            ) : null}
            <div className="participation-actions">
              <Button
                size="compact"
                disabled={
                  busy || stale || editor.value.reason.trim().length < 5
                }
                onClick={save}
              >
                保存任务文字
              </Button>
              {a.kind === "answer" ? (
                <Button
                  primary
                  size="compact"
                  disabled={
                    busy ||
                    stale ||
                    contextStale ||
                    !confirmed ||
                    !c?.document ||
                    c.document.truncated ||
                    !editor.value.title.trim() ||
                    editor.value.draft.trim().length < 30 ||
                    editor.value.basis.trim().length < 10
                  }
                  onClick={answer}
                >
                  保存待审回答稿
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
        {!a.resolution && !attempts.length && !queued ? (
          <section className="participation-form-section">
            <h3>记录本人处理结果</h3>
            <p className="participation-meta">
              仅记录你已在官网实际完成的阅读或处理，不会自动操作知乎，也不作为官方核验。
            </p>
            <div className="participation-actions">
              <Button
                size="compact"
                disabled={busy}
                onClick={() => setResolve("done")}
              >
                记录本人已处理
              </Button>
              <Button
                quiet
                size="compact"
                disabled={busy}
                onClick={() => setResolve("skipped")}
              >
                记录不采用
              </Button>
            </div>
          </section>
        ) : null}
      </div>
      {resolve ? (
        <ParticipationResolution
          activity={a}
          outcome={resolve}
          scope={scope}
          busy={busy}
          run={run}
          close={() => setResolve(null)}
          onResolved={(activity) => {
            if (mounted.current) setReceipt(activity);
          }}
        />
      ) : null}
    </Panel>
  );
}
