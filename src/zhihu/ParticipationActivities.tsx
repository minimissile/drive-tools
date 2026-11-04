import { z } from "zod";
import type {
  ZhihuParticipationActivity,
  ZhihuParticipationCandidate,
} from "../../shared/zhihu-participation";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatTime } from "../lib/format";
import { Empty, Field, Notice, Panel, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import type { ParticipationAccount } from "./Participation";
import { ParticipationActivityEditor } from "./ParticipationActivityEditor";
import {
  participationKindLabels,
  participationStatusLabels,
  participationStatusKind,
  type ParticipationAction,
} from "./participation-state";

const filterSchema = z.object({
  status: z
    .enum([
      "all",
      "planned",
      "needs_review",
      "prepared",
      "done",
      "skipped",
      "executing",
      "queued",
      "succeeded",
      "attention",
      "failed",
    ])
    .default("all"),
  text: z.string().default(""),
  page: z.number().int().min(1).default(1),
});
export function participationTitle(
  activity: ZhihuParticipationActivity,
  candidates: ZhihuParticipationCandidate[],
) {
  return (
    activity.context?.title ||
    candidates.find((c) => c.id === activity.candidateId)?.title ||
    "原候选暂不可读"
  );
}

export function ParticipationActivities({
  activities,
  candidates,
  account,
  scope,
  selectedId,
  select,
  busy,
  readError,
  run,
  onOpenContents,
}: {
  activities: ZhihuParticipationActivity[];
  candidates: ZhihuParticipationCandidate[];
  account: ParticipationAccount;
  scope: string;
  selectedId: string;
  select(id: string): void;
  busy: boolean;
  readError: boolean;
  run: ParticipationAction;
  onOpenContents(): void;
}) {
  const filters = useLocalDraft(
    `panxu-zhihu-participation-activities-v1:${scope}`,
    filterSchema.parse({}),
    (value) => filterSchema.parse(value),
  );
  const needle = filters.value.text.trim().toLocaleLowerCase();
  const items = activities.filter(
    (a) =>
      (filters.value.status === "all" || a.status === filters.value.status) &&
      `${participationTitle(a, candidates)} ${a.reason} ${a.draft}`
        .toLocaleLowerCase()
        .includes(needle),
  );
  const page = Math.min(
    filters.value.page,
    Math.max(1, Math.ceil(items.length / 8)),
  );
  const selected = activities.find((a) => a.id === selectedId);
  return (
    <div className="participation-columns">
      <Panel
        title="参与任务"
        extra={<small className="participation-meta">{items.length} 项</small>}
      >
        <div className="participation-list-filters">
          <Field label="处理状态">
            <Select
              value={filters.value.status}
              items={[
                { value: "all", label: "全部状态" },
                ...Object.entries(participationStatusLabels).map(
                  ([value, label]) => ({ value, label }),
                ),
              ]}
              onValueChange={(status) =>
                filters.update({
                  status: status as typeof filters.value.status,
                  page: 1,
                })
              }
            />
          </Field>
          <Field label="筛选本地任务">
            <input
              value={filters.value.text}
              placeholder="目标、理由或草稿"
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
              {items.slice((page - 1) * 8, page * 8).map((activity) => (
                <button
                  type="button"
                  key={activity.id}
                  className="participation-choice"
                  aria-pressed={activity.id === selectedId}
                  onClick={() => select(activity.id)}
                >
                  <span>
                    <strong>{participationTitle(activity, candidates)}</strong>
                    <span className="participation-task-state">
                      <Status kind={participationStatusKind(activity.status)}>
                        {participationStatusLabels[activity.status]}
                      </Status>
                      <small>
                        {participationKindLabels[activity.kind]} · v
                        {activity.version}
                      </small>
                    </span>
                    {activity.attempts?.at(-1)?.receipt?.outcome ===
                    "already_present" ? (
                      <small>已确认原有状态，未新增互动</small>
                    ) : null}
                    <p>{activity.reason}</p>
                    <small>
                      {activity.scheduledAt
                        ? `${activity.status === "queued" ? "预计提交" : "计划"} ${formatTime(activity.scheduledAt)}`
                        : "未指定时间"}
                      {activity.planId
                        ? " · 已关联运营计划"
                        : " · 独立参与任务"}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            <Pagination
              label="知乎参与任务分页"
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
              needle || filters.value.status !== "all"
                ? "没有匹配的参与任务"
                : "尚无参与任务"
            }
          >
            先在候选与上下文中安排具体任务；这里保留理由、草稿、真实执行证据及本人处理记录。
          </Empty>
        ) : null}
      </Panel>
      {selected ? (
        <ParticipationActivityEditor
          key={selected.id}
          activity={selected}
          candidate={candidates.find((c) => c.id === selected.candidateId)}
          account={account}
          scope={scope}
          busy={busy}
          run={run}
          onOpenContents={onOpenContents}
        />
      ) : (
        <Panel title="任务依据与待审草稿">
          <Empty compact title="选择一项参与任务">
            查看上下文、待审稿、执行证据，或记录本人已在官网完成的处理。
          </Empty>
        </Panel>
      )}
    </div>
  );
}
