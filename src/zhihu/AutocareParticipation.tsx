import { useRef, useState } from "react";
import {
  autocareRandomLikeScope,
  autocareRandomCommentScope,
  autocareRandomFollowScope,
  type AutocareCommentJob,
  type AutocareSnapshot,
} from "../../shared/zhihu-autocare";
import type { ZhihuParticipationActivity } from "../../shared/zhihu-participation";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import { Button, Empty, Notice, Panel, Status } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { formatTime } from "../lib/format";
import { ParticipationContext } from "./ParticipationContext";
import "./participation.css";

const ruleInteractionKind = (a: ZhihuParticipationActivity) => {
  if (a.planId === autocareRandomFollowScope) return "follow";
  if (a.planId === autocareRandomLikeScope) return "like";
  if (a.planId === autocareRandomCommentScope) return "comment";
  const decision = a.attempts?.at(-1)?.decision;
  if (decision?.relevance !== null || decision.source !== "rule") return null;
  if (decision.rule === "autocare_random_follow") return "follow";
  if (decision.rule === "autocare_random_comment") return "comment";
  return decision.rule === "autocare_random_like" ? "like" : null;
};
const isRuleInteraction = (a: ZhihuParticipationActivity) =>
  ruleInteractionKind(a) !== null;
const interactionLabel = (a: ZhihuParticipationActivity) => {
  const ruleKind = ruleInteractionKind(a);
  if (ruleKind)
    return ruleKind === "follow"
      ? "自动关注作者"
      : ruleKind === "comment"
        ? "随机评论"
        : "随机点赞";
  return a.kind === "like"
    ? "点赞"
    : a.kind === "comment"
      ? "评论"
      : "关注作者";
};
const commentPreparationLabels: Record<AutocareCommentJob["status"], string> = {
  generating: "正在生成",
  ready: "正文已保存",
  skipped: "已跳过",
  attention: "需要处理",
  completed: "准备完成",
  cancelled: "已取消",
};

export function AutocareParticipation({
  snapshot: s,
  reload,
}: {
  snapshot: AutocareSnapshot;
  reload(): void;
}) {
  const [selected, setSelected] = useState(""),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    { notify } = useAppActions();
  // A successful remote action remains visible if the subsequent refresh fails.
  const [received, setReceived] = useState<
    Record<string, ZhihuParticipationActivity>
  >({});
  const activities = s.participation.activities
    .filter((a) => ["like", "follow", "comment"].includes(a.kind))
    .map((a) =>
      (received[a.id]?.version ?? 0) > a.version ? received[a.id] : a,
    )
    .reverse();
  const current = activities.find((a) => a.id === selected);
  const commentPreparations = (s.commentJobs ?? []).filter(
    (job) => !job.activityId,
  );
  const names = new Map(s.accounts.map((a) => [a.id, a.nickname || a.alias]));
  const result = (a: ZhihuParticipationActivity) => {
    const attempt = a.attempts?.at(-1);
    return attempt?.receipt?.outcome === "already_present"
      ? "原有状态 · 未重复操作"
      : a.status === "succeeded"
        ? "官方已核实"
        : a.status === "attention"
          ? "需要核对"
          : a.status === "executing"
            ? "正在执行"
            : a.status === "failed"
              ? "未完成"
              : a.resolution || a.status === "skipped"
                ? "已跳过"
                : isRuleInteraction(a)
                  ? "已选择 · 未执行"
                  : "历史待办 · 将重新核对";
  };
  const open = (url: string) => {
    void ipc("system.external", { url }).catch((e) =>
      notify(e instanceof Error ? e.message : "无法打开原文", "error"),
    );
  };
  const reconcile = async (a: ZhihuParticipationActivity) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const updated = await ipc("zhihu.autocare.reconcile", {
        id: a.id,
        version: a.version,
      });
      const actual = updated.participation.activities.find(
        (item) => item.id === a.id,
      );
      if (actual) setReceived((old) => ({ ...old, [a.id]: actual }));
      notify(
        actual?.attempts?.at(-1)?.receipt?.summary ||
          "已保留原执行记录，请查看核对结果",
        actual?.status === "succeeded" ? "success" : "warning",
      );
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "核对未完成，原记录保留");
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };
  return (
    <Panel
      title="互动记录"
      extra={<small className="muted">失败与未知结果保留原记录</small>}
    >
      <p className="muted autocare-help">
        点赞、评论和作者关注由程序自动安排。未尝试的历史待办会先重新核对；失败和未知结果不会自动重发。
      </p>
      {error ? <Notice danger>{error}</Notice> : null}
      {activities.length ? (
        <>
          <div className="table-wrap">
            <table className="autocare-participation-table">
              <thead>
                <tr>
                  <th>账号 / 操作</th>
                  <th>目标</th>
                  <th>状态</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {activities.slice((page - 1) * 6, page * 6).map((a) => (
                  <tr key={a.id}>
                    <td>
                      {names.get(a.accountId)}
                      <small>{interactionLabel(a)}</small>
                    </td>
                    <td>
                      <span>{a.context?.title || "原上下文待读取"}</span>
                      <small>{formatTime(a.createdAt)}</small>
                    </td>
                    <td>
                      <Status
                        kind={
                          a.status === "succeeded"
                            ? "good"
                            : a.status === "attention" || a.status === "failed"
                              ? "warning"
                              : "normal"
                        }
                      >
                        {result(a)}
                      </Status>
                    </td>
                    <td>
                      <Button
                        quiet
                        size="compact"
                        disabled={busy}
                        onClick={() =>
                          setSelected(selected === a.id ? "" : a.id)
                        }
                      >
                        {selected === a.id ? "收起" : "查看内容"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={6}
            total={activities.length}
            onPageChange={setPage}
            label="运营互动待办分页"
          />
        </>
      ) : (
        <Empty compact title="尚无互动记录">
          开启对应自动操作后，系统会在启动后2小时内按读取与互动额度安排准确目标。
        </Empty>
      )}
      {current?.context ? (
        <section
          className="autocare-interaction-detail"
          aria-label="当前互动目标"
        >
          <div className="row between">
            <h3>
              {interactionLabel(current)}的目标 · {names.get(current.accountId)}
            </h3>
            <Button
              quiet
              size="compact"
              onClick={() => open(current.context!.url)}
            >
              打开官方原文
            </Button>
          </div>
          <ParticipationContext
            document={current.context}
            open={open}
            busy={busy}
          />
          {current.kind === "comment" && current.draft ? (
            <div className="participation-decision">
              <strong>本次评论正文</strong>
              <p>{current.draft}</p>
            </div>
          ) : null}
          <div className="row compact">
            {current.attempts?.at(-1)?.submittedAt &&
            current.status === "attention" ? (
              <Button
                size="compact"
                disabled={s.busy || busy}
                onClick={() => void reconcile(current)}
              >
                只读核对原结果
              </Button>
            ) : null}
            <small className="muted">
              历史待办会由当前规则重新核对后纳入；已有失败或提交记录不会自动重放，未知结果仅核对原提交。
            </small>
          </div>
          {current.attempts?.at(-1) ? (
            <p className="autocare-wrap muted">
              {current.attempts.at(-1)?.receipt?.summary ||
                current.attempts.at(-1)?.error}{" "}
              · 尝试 {formatTime(current.attempts.at(-1)!.startedAt)}
              {current.attempts.at(-1)?.submittedAt
                ? ` · 提交 ${formatTime(current.attempts.at(-1)!.submittedAt!)}`
                : " · 未记录提交"}
            </p>
          ) : null}
        </section>
      ) : null}
      {commentPreparations.length ? (
        <details className="autocare-more">
          <summary>评论准备记录 · {commentPreparations.length} 条</summary>
          {commentPreparations.length > 5 ? (
            <p className="muted">显示最近5条，完整过程可查看运行日志。</p>
          ) : null}
          {commentPreparations
            .slice(-5)
            .reverse()
            .map((job) => (
              <div className="autocare-interaction-detail" key={job.id}>
                <div className="row between">
                  <strong>{names.get(job.accountId) || job.accountId}</strong>
                  <Status
                    kind={job.status === "attention" ? "warning" : "normal"}
                  >
                    {commentPreparationLabels[job.status]}
                  </Status>
                </div>
                <small className="muted">
                  更新 {formatTime(job.updatedAt)}
                </small>
                <p className="autocare-wrap autocare-help">{job.message}</p>
                {job.body ? (
                  <details className="participation-decision">
                    <summary>查看已保存评论正文</summary>
                    <p>{job.body}</p>
                  </details>
                ) : null}
              </div>
            ))}
        </details>
      ) : null}
    </Panel>
  );
}
