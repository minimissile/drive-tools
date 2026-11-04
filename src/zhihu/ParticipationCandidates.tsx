import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type {
  ZhihuParticipationActivity,
  ZhihuParticipationCandidate,
  ZhihuParticipationKind,
} from "../../shared/zhihu-participation";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatTime } from "../lib/format";
import { Button, Empty, Field, Notice, Panel, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import type { ParticipationAccount } from "./Participation";
import { ParticipationContext } from "./ParticipationContext";
import {
  participationKindLabels,
  researchKindLabels,
  participationTime,
  type ParticipationAction,
} from "./participation-state";

const filterSchema = z.object({
  kind: z
    .enum(["all", "question", "answer", "article", "author"])
    .default("all"),
  text: z.string().default(""),
  page: z.number().int().min(1).default(1),
});
const planDraftSchema = z.object({
  kind: z.enum(["read", "answer", "comment", "like", "follow"]).default("read"),
  reason: z.string().max(2000).default(""),
  draft: z.string().max(12000).default(""),
  scheduledAt: z.string().default(""),
  contextVersion: z.number().int().positive(),
});

export function ParticipationCandidates({
  candidates,
  account,
  scope,
  planId,
  selectedId,
  select,
  busy,
  readError,
  run,
  showActivity,
}: {
  candidates: ZhihuParticipationCandidate[];
  account: ParticipationAccount;
  scope: string;
  planId?: string;
  selectedId: string;
  select(id: string): void;
  busy: boolean;
  readError: boolean;
  run: ParticipationAction;
  showActivity(id: string): void;
}) {
  const filters = useLocalDraft(
    `panxu-zhihu-participation-candidates-v1:${scope}`,
    filterSchema.parse({}),
    (value) => filterSchema.parse(value),
  );
  const needle = filters.value.text.trim().toLocaleLowerCase();
  const items = candidates.filter(
    (c) =>
      (filters.value.kind === "all" || c.kind === filters.value.kind) &&
      `${c.title} ${c.author || ""} ${c.excerpt}`
        .toLocaleLowerCase()
        .includes(needle),
  );
  const page = Math.min(
    filters.value.page,
    Math.max(1, Math.ceil(items.length / 8)),
  );
  const selected = candidates.find((c) => c.id === selectedId);
  return (
    <div className="participation-columns">
      <Panel
        title="已保存候选"
        extra={<small className="participation-meta">{items.length} 项</small>}
      >
        <div className="participation-list-filters">
          <Field label="候选类型">
            <Select
              value={filters.value.kind}
              items={[
                { value: "all", label: "全部类型" },
                ...Object.entries(researchKindLabels).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
              onValueChange={(kind) =>
                filters.update({
                  kind: kind as typeof filters.value.kind,
                  page: 1,
                })
              }
            />
          </Field>
          <Field label="筛选本地候选">
            <input
              value={filters.value.text}
              placeholder="标题、作者或摘要"
              onChange={(e) =>
                filters.update({ text: e.target.value, page: 1 })
              }
            />
          </Field>
        </div>
        {filters.error ? <Notice warning>{filters.error}</Notice> : null}
        {items.length ? (
          <>
            <div className="participation-list">
              {items.slice((page - 1) * 8, page * 8).map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  className="participation-choice"
                  aria-pressed={candidate.id === selectedId}
                  onClick={() => select(candidate.id)}
                >
                  <span>
                    <strong>{candidate.title}</strong>
                    <small>
                      {researchKindLabels[candidate.kind]}
                      {candidate.author ? ` · ${candidate.author}` : ""} · v
                      {candidate.version}
                    </small>
                    <p>{candidate.excerpt}</p>
                    {candidate.recommendation ? (
                      <small>
                        创作者推荐 · {candidate.recommendation.viewText} ·{" "}
                        {formatTime(candidate.recommendation.observedAt)}读取
                      </small>
                    ) : null}
                    <small>
                      {candidate.document
                        ? `上下文 ${formatTime(candidate.document.observedAt)}`
                        : `发现 ${formatTime(candidate.checkedAt)} · 尚未读取上下文`}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            <Pagination
              label="知乎参与候选分页"
              page={page}
              pageSize={8}
              total={items.length}
              onPageChange={(page) => filters.update({ page })}
            />
          </>
        ) : !readError ? (
          <Empty
            compact
            title={
              needle || filters.value.kind !== "all"
                ? "没有匹配的本地候选"
                : "尚无已保存候选"
            }
          >
            从上方输入领域关键词，显式发现真实问题或相关作者；历史候选不会因一次无结果而删除。
          </Empty>
        ) : null}
      </Panel>
      {selected ? (
        <CandidateDetail
          key={selected.id}
          candidate={selected}
          account={account}
          scope={scope}
          planId={planId}
          busy={busy}
          run={run}
          showActivity={showActivity}
        />
      ) : (
        <Panel title="上下文与参与安排">
          <Empty compact title="选择一项候选">
            查看来源与上下文，再按内容相关性安排阅读、回答或参与讨论。
          </Empty>
        </Panel>
      )}
    </div>
  );
}

function CandidateDetail({
  candidate: incoming,
  account,
  scope,
  planId,
  busy,
  run,
  showActivity,
}: {
  candidate: ZhihuParticipationCandidate;
  account: ParticipationAccount;
  scope: string;
  planId?: string;
  busy: boolean;
  run: ParticipationAction;
  showActivity(id: string): void;
}) {
  const [receipt, setReceipt] = useState<ZhihuParticipationCandidate | null>(
    null,
  );
  const c = receipt && receipt.version > incoming.version ? receipt : incoming;
  const draft = useLocalDraft(
    `panxu-zhihu-participation-plan-v1:${scope}:${c.id}`,
    planDraftSchema.parse({ contextVersion: c.version }),
    (value) => planDraftSchema.parse(value),
  );
  const [created, setCreated] = useState<ZhihuParticipationActivity | null>(
    null,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const kinds: ZhihuParticipationKind[] =
    c.kind === "author"
      ? ["read", "follow"]
      : c.kind === "question"
        ? ["read", "answer", "comment"]
        : ["read", "comment", "like"];
  const kind = kinds.includes(draft.value.kind) ? draft.value.kind : "read";
  const stale = draft.value.contextVersion !== c.version;
  const open = (url: string) =>
    void run(
      () => ipc("websiteAccounts.openDocument", { id: account.id, url }),
      "已在对应账号打开官方原页，未登记任何参与完成状态",
    );
  const plan = () => {
    const value = draft.value;
    void run(
      () =>
        ipc("zhihu.participation.plan", {
          accountId: account.id,
          candidateId: c.id,
          version: c.version,
          kind,
          reason: value.reason,
          draft: value.draft,
          scheduledAt: participationTime(value.scheduledAt),
          planId: planId ?? null,
        }),
      "参与任务已保存，实际处理状态以任务记录为准",
    ).then((result) => {
      if (result.ok && mounted.current) setCreated(result.value);
    });
  };
  return (
    <Panel
      title={c.title}
      extra={
        <Status kind="normal">
          {researchKindLabels[c.kind]} · v{c.version}
        </Status>
      }
    >
      <div className="participation-detail">
        <div className="participation-actions">
          <Button
            size="compact"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  ipc("zhihu.participation.inspect", {
                    accountId: account.id,
                    candidateId: c.id,
                    version: c.version,
                  }),
                "官方上下文快照已更新，未登记本人已读",
              ).then((result) => {
                if (result.ok && mounted.current) setReceipt(result.value);
              })
            }
          >
            {c.document ? "刷新官方上下文" : "读取官方上下文"}
          </Button>
          <Button
            quiet
            size="compact"
            disabled={busy}
            onClick={() => open(c.url)}
          >
            用此账号打开原页
          </Button>
        </div>
        <p className="participation-source">{c.url}</p>
        <p className="participation-meta">
          候选发现于 {formatTime(c.checkedAt)}
          {c.author ? ` · 作者 ${c.author}` : ""}
        </p>
        {c.document ? (
          <ParticipationContext document={c.document} open={open} busy={busy} />
        ) : (
          <Notice>
            当前仅有列表摘要：{c.excerpt || "页面未提供摘要"}
            。评论、回答、点赞与关注安排前须先读取上下文。
          </Notice>
        )}
        <section
          className="participation-form-section"
          aria-label="安排参与任务"
        >
          <h3>安排参与任务</h3>
          {draft.error ? <Notice warning>{draft.error}</Notice> : null}
          {stale ? (
            <Notice warning>
              候选上下文已更新为 v{c.version}，当前编辑仍基于 v
              {draft.value.contextVersion}。
              <Button
                size="compact"
                quiet
                disabled={busy}
                onClick={() => draft.update({ contextVersion: c.version })}
              >
                以当前上下文继续编辑
              </Button>
            </Notice>
          ) : null}
          <fieldset disabled={busy} className="participation-fields">
            <Field label="参与类型">
              <Select
                value={kind}
                items={kinds.map((value) => ({
                  value,
                  label: participationKindLabels[value],
                }))}
                onValueChange={(kind) =>
                  draft.update({ kind: kind as ZhihuParticipationKind })
                }
              />
            </Field>
            <Field label="计划时间（北京时间，选填）">
              <input
                type="datetime-local"
                value={draft.value.scheduledAt}
                onChange={(e) => draft.update({ scheduledAt: e.target.value })}
              />
            </Field>
            <div className="wide">
              <Field label="安排理由" hint="说明与账号内容方向的关系，至少5字">
                <textarea
                  value={draft.value.reason}
                  maxLength={2000}
                  placeholder="为什么值得阅读或参与这项讨论"
                  onChange={(e) => draft.update({ reason: e.target.value })}
                />
              </Field>
            </div>
            <div className="wide">
              <Field
                label={
                  kind === "comment"
                    ? "待审评论草稿（选填）"
                    : kind === "answer"
                      ? "回答思路（选填）"
                      : "参与笔记（选填）"
                }
              >
                <textarea
                  value={draft.value.draft}
                  maxLength={12000}
                  placeholder="围绕实际上下文记录想法，保存本身不会提交"
                  onChange={(e) => draft.update({ draft: e.target.value })}
                />
              </Field>
            </div>
          </fieldset>
          <div className="participation-actions">
            <Button
              primary
              size="compact"
              disabled={
                busy ||
                stale ||
                draft.value.reason.trim().length < 5 ||
                (kind !== "read" && !c.document)
              }
              onClick={plan}
            >
              保存{participationKindLabels[kind]}任务
            </Button>
            {created ? (
              <Button size="compact" onClick={() => showActivity(created.id)}>
                查看已保存任务
              </Button>
            ) : null}
          </div>
          <p className="participation-meta">
            保存与打开原页不会记为完成。关联自主计划的点赞、评论和关注，须另行授权后由AI判定是否参与；独立任务由本人处理。回答稿仍须审核与发布。
          </p>
        </section>
      </div>
    </Panel>
  );
}
