import type { ZhihuInteractionAttempt } from "../../shared/zhihu-interaction";
import { formatTime } from "../lib/format";
import { Button, Notice, Status } from "../ui/primitives";
import { participationKindLabels } from "./participation-state";

const attemptLabels: Record<ZhihuInteractionAttempt["status"], string> = {
  running: "执行中",
  succeeded: "官方状态已确认",
  failed: "执行失败",
  unknown: "结果未知 · 待核对",
};

export function ParticipationAttempts({
  attempts,
  accountName,
  busy,
  canReconcile,
  open,
  reconcile,
}: {
  attempts: readonly ZhihuInteractionAttempt[];
  accountName: string;
  busy: boolean;
  canReconcile: boolean;
  open(url: string): void;
  reconcile(): void;
}) {
  const latest = attempts[attempts.length - 1];
  if (!latest) return null;
  const unknown = latest.status === "unknown";
  return (
    <section className="participation-form-section" aria-label="真实执行记录">
      <div className="participation-execution-heading">
        <h3>真实执行记录</h3>
        <span className="participation-meta">{attempts.length} 次记录</span>
      </div>
      {unknown ? (
        <Notice warning>
          结果未知，禁止重新提交。只读核对会检查原账号、原目标和原评论，不执行新的点赞、评论或关注。
          {latest.submittedAt && canReconcile ? (
            <div className="participation-actions">
              <Button size="compact" disabled={busy} onClick={reconcile}>
                只读核对原执行结果
              </Button>
            </div>
          ) : (
            <p className="participation-meta">
              当前记录不具备只读核对条件；请保留原任务，勿重新提交。
            </p>
          )}
        </Notice>
      ) : null}
      <div className="participation-attempts">
        {[...attempts].reverse().map((attempt, index) => (
          <AttemptDetail
            key={attempt.id}
            attempt={attempt}
            accountName={accountName}
            latest={index === 0}
            busy={busy}
            open={open}
          />
        ))}
      </div>
    </section>
  );
}

function AttemptDetail({
  attempt: a,
  accountName,
  latest,
  busy,
  open,
}: {
  attempt: ZhihuInteractionAttempt;
  accountName: string;
  latest: boolean;
  busy: boolean;
  open(url: string): void;
}) {
  const receipt = a.receipt;
  const confirmed = a.status === "succeeded" && !!receipt;
  const outcome = confirmed
    ? receipt.outcome === "already_present"
      ? "原本已是该状态 · 未新增互动"
      : "本次操作已由官方页面核验"
    : null;
  return (
    <details className="participation-attempt" open={latest}>
      <summary>
        <span className="participation-attempt-heading">
          <Status
            kind={
              confirmed
                ? "good"
                : a.status === "unknown"
                  ? "warning"
                  : a.status === "failed"
                    ? "danger"
                    : "normal"
            }
          >
            {confirmed && receipt.outcome === "already_present"
              ? "已确认原有状态"
              : attemptLabels[a.status]}
          </Status>
          <span>
            {participationKindLabels[a.request.kind]} ·{" "}
            {formatTime(a.startedAt)}
          </span>
        </span>
      </summary>
      <div className="participation-attempt-body">
        <dl className="participation-evidence">
          <div>
            <dt>执行账号</dt>
            <dd>
              {accountName} · UID {a.request.actorUid}
            </dd>
          </div>
          <div className="wide">
            <dt>官方目标</dt>
            <dd>{a.request.url}</dd>
          </div>
          <div>
            <dt>提交时间</dt>
            <dd>{a.submittedAt ? formatTime(a.submittedAt) : "未记录提交"}</dd>
          </div>
          <div>
            <dt>官方核验时间</dt>
            <dd>{receipt ? formatTime(receipt.observedAt) : "尚无官方确认"}</dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>{a.finishedAt ? formatTime(a.finishedAt) : "尚未结束"}</dd>
          </div>
          {receipt ? (
            <>
              <div>
                <dt>官方核验账号 UID / 状态</dt>
                <dd>
                  {receipt.actorUid} /{" "}
                  {receipt.state === "liked"
                    ? "已点赞"
                    : receipt.state === "commented"
                      ? "评论可见"
                      : "已关注"}
                </dd>
              </div>
              <div>
                <dt>目标作者 UID / 目标 ID</dt>
                <dd>
                  {receipt.targetAuthorUid} / {receipt.targetId}
                </dd>
              </div>
              <div>
                <dt>评论 ID</dt>
                <dd>
                  {receipt.commentId ||
                    (a.request.kind === "comment" ? "未提供" : "不适用")}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
        {outcome ? (
          <p className="participation-execution-result">
            <strong>{outcome}</strong>
            <span>{receipt?.summary}</span>
          </p>
        ) : null}
        {a.error ? (
          <Notice
            danger={a.status === "failed"}
            warning={a.status === "unknown"}
          >
            {a.error}
          </Notice>
        ) : null}
        <div className="participation-decision">
          <strong>
            AI相关性判断 · {Math.round(a.decision.relevance * 100)}%
          </strong>
          <p>{a.decision.basis}</p>
          <blockquote>{a.decision.quote}</blockquote>
        </div>
        {a.request.kind === "comment" ? (
          <div className="participation-decision">
            <strong>本次准确评论正文</strong>
            <p>{a.request.text}</p>
            {receipt?.text && receipt.text !== a.request.text ? (
              <>
                <strong>官方核验所见正文</strong>
                <p>{receipt.text}</p>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="participation-actions">
          <Button
            size="compact"
            disabled={busy}
            onClick={() => open(a.request.url)}
          >
            用此账号查看官方目标
          </Button>
        </div>
        <details className="participation-details">
          <summary>查看本次决策使用的上下文</summary>
          <div className="participation-context-text">
            {a.request.contextText}
          </div>
        </details>
        <details className="participation-details">
          <summary>执行标识与版本依据</summary>
          <dl className="participation-evidence">
            <div className="wide">
              <dt>执行记录</dt>
              <dd>{a.id}</dd>
            </div>
            <div className="wide">
              <dt>运营计划</dt>
              <dd>
                {a.planId} · v{a.planRevision} · 任务 v{a.activityVersion}
              </dd>
            </div>
            <div className="wide">
              <dt>准确请求指纹</dt>
              <dd>{a.request.fingerprint}</dd>
            </div>
          </dl>
        </details>
      </div>
    </details>
  );
}
