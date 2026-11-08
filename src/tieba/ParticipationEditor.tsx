import { z } from "zod";
import type {
  TiebaParticipationCandidate,
  TiebaParticipationSnapshot,
  TiebaReplyDraft,
} from "../../shared/tieba-participation";
import type { FeedbackMessage } from "../lib/feedback";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Status,
} from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import {
  tiebaReplyContextIssue,
  tiebaReplyCanRegenerate,
  tiebaReplyEditable,
  tiebaReplyEditorView,
  tiebaReplyStatusKind,
  tiebaReplyStatusLabels,
} from "./participation-view";
import { tiebaTime } from "./view-model";

type Action = (
  operation: () => Promise<TiebaParticipationSnapshot>,
  resultMessage:
    string | ((value: TiebaParticipationSnapshot) => FeedbackMessage),
) => Promise<void>;

export function ParticipationEditor({
  workspace,
  candidate,
  draft,
  accountName,
  busy,
  unavailable,
  error,
  close,
  read,
  action,
}: {
  workspace: string;
  candidate: TiebaParticipationCandidate;
  draft: TiebaReplyDraft | null;
  accountName: string;
  busy: boolean;
  unavailable: boolean;
  error: string;
  close(): void;
  read(): void;
  action: Action;
}) {
  const context = candidate.context;
  const issue = tiebaReplyContextIssue(candidate);
  const disabled = busy || unavailable;
  const generate = () =>
    action(
      () =>
        ipc("tieba.participation.generate", {
          candidateId: candidate.id,
          confirmed: true,
        }),
      (result) => {
        const next = result.drafts.find(
          (item) => item.candidateId === candidate.id,
        );
        return next?.status === "ready"
          ? {
              text: "回复已生成并通过规则检查，请审阅正文后提交",
              tone: "success",
            }
          : {
              text: next?.message || "本次未取得可提交的回复，请查看处理原因",
              tone: "warning",
            };
      },
    );
  const contextView = (
    <section className="tieba-reply-context" aria-label="原帖与已有回复">
      <div className="tieba-reply-section-heading">
        <h3>原帖上下文</h3>
        <Button size="compact" quiet disabled={disabled} onClick={read}>
          重新读取
        </Button>
      </div>
      <h4>{candidate.title}</h4>
      <p className="tieba-reply-meta">
        {accountName} · {candidate.forumName}吧 ·{" "}
        {context ? `读取于 ${tiebaTime(context.checkedAt)}` : "尚未读取正文"}
      </p>
      {!context && busy ? (
        <LoadingState label="正在读取原帖正文与必要回复…" />
      ) : null}
      {!context && !busy ? (
        <Empty compact title="尚未取得原帖正文">
          点击“重新读取”，核对完整上下文后再生成回复。
        </Empty>
      ) : null}
      {context ? (
        <div className="tieba-reply-context-content">
          <div className="tieba-reply-original">
            {context.body || "未读取到原帖正文"}
          </div>
          <details className="tieba-reply-existing">
            <summary>已读取的楼层 · {context.replies.length} 条</summary>
            {context.replies.length ? (
              <ol>
                {context.replies.map((reply) => (
                  <li key={reply.postId}>
                    <strong>{reply.authorName || "未取得昵称"}</strong>
                    <p>{reply.text}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">本次没有取得其他楼层正文。</p>
            )}
          </details>
        </div>
      ) : null}
    </section>
  );
  return draft ? (
    <DraftEditor
      key={draft.id}
      {...{
        workspace,
        candidate,
        draft,
        accountName,
        busy,
        unavailable,
        error,
        close,
        action,
        contextView,
        issue,
      }}
    />
  ) : (
    <Dialog
      title="帖子上下文与回复"
      className="tieba-participation-dialog"
      focus="container"
      onClose={close}
      footer={
        <>
          <span className="tieba-reply-cost">
            AI生成使用当前文案模型，调用费用计入全局预算。
          </span>
          <Button onClick={close}>关闭</Button>
          <Button
            primary
            disabled={disabled || !!issue}
            data-testid="tieba-reply-generate"
            onClick={() => void generate()}
          >
            {busy ? "正在准备…" : "AI生成回复"}
          </Button>
        </>
      }
    >
      {error ? <Notice danger>{error}</Notice> : null}
      {issue ? <Notice warning>{issue}</Notice> : null}
      {contextView}
    </Dialog>
  );
}

function DraftEditor({
  workspace,
  candidate,
  draft,
  accountName,
  busy,
  unavailable,
  error,
  close,
  action,
  contextView,
  issue,
}: {
  workspace: string;
  candidate: TiebaParticipationCandidate;
  draft: TiebaReplyDraft;
  accountName: string;
  busy: boolean;
  unavailable: boolean;
  error: string;
  close(): void;
  action: Action;
  contextView: import("react").ReactNode;
  issue: string;
}) {
  const local = useLocalDraft(
    `tieba-reply-body:${workspace}:${draft.id}`,
    { body: draft.body, baseBody: draft.body, version: draft.version },
    (value) =>
      z
        .object({
          body: z.string().max(10000),
          baseBody: z.string().max(10000),
          version: z.number().int().positive(),
        })
        .parse(value),
  );
  const { notify } = useAppActions();
  const { body, changed, stale } = tiebaReplyEditorView(local.value, draft);
  const editable = tiebaReplyEditable(draft);
  const canRegenerate = tiebaReplyCanRegenerate(draft);
  const invalidLength = body.trim().length < 20 || body.trim().length > 800;
  const disabled = busy || unavailable;
  const reset = () => {
    local.clear();
    local.update({
      body: draft.body,
      baseBody: draft.body,
      version: draft.version,
    });
  };
  const copy = async (text: string) => {
    try {
      await ipc("system.copyText", { text });
      notify("链接已复制", "success");
    } catch {
      notify("复制未完成，可选择链接文字手动复制", "error");
    }
  };
  const save = () =>
    action(
      () =>
        ipc("tieba.participation.save", {
          draftId: draft.id,
          version: draft.version,
          body,
        }),
      "回复已保存并通过规则检查，请核对后提交",
    );
  const submit = () =>
    action(
      () =>
        ipc("tieba.participation.submit", {
          draftId: draft.id,
          version: draft.version,
          confirmed: true,
        }),
      (result) => {
        const next = result.drafts.find((item) => item.id === draft.id);
        return next?.status === "verified"
          ? { text: "官网已核实该条回复", tone: "success" }
          : {
              text: next?.message || "已完成提交尝试，请查看原结果",
              tone: "warning",
            };
      },
    );
  const reconcile = () =>
    action(
      () => ipc("tieba.participation.reconcile", { draftId: draft.id }),
      (result) => {
        const next = result.drafts.find((item) => item.id === draft.id);
        return next?.status === "verified"
          ? { text: "官网已核实原回复，未重复提交", tone: "success" }
          : {
              text: next?.message || "尚未核实原回复，保留未知记录",
              tone: "warning",
            };
      },
    );
  const regenerate = () =>
    action(
      () =>
        ipc("tieba.participation.generate", {
          candidateId: candidate.id,
          confirmed: true,
        }),
      (result) => {
        const next = result.drafts.find((item) => item.id === draft.id);
        return next?.status === "ready"
          ? { text: "回复已重新生成，请审阅正文", tone: "success" }
          : {
              text: next?.message || "未取得可提交的回复，请查看处理原因",
              tone: "warning",
            };
      },
    );
  return (
    <Dialog
      title="帖子上下文与回复"
      className="tieba-participation-dialog"
      focus="container"
      onClose={close}
      footer={
        <>
          <span className="tieba-reply-cost">
            {draft.submittedAt
              ? `原提交时间 ${tiebaTime(draft.submittedAt)}`
              : `将以「${accountName}」回复当前主题帖`}
            {canRegenerate ? " · 再次生成会计入全局AI预算" : ""}
          </span>
          <Button onClick={close}>关闭</Button>
          {canRegenerate ? (
            <Button
              disabled={disabled || !!issue || changed || stale}
              data-testid="tieba-reply-regenerate"
              onClick={() => void regenerate()}
            >
              AI重新生成
            </Button>
          ) : null}
          {editable ? (
            <>
              <Button
                disabled={
                  disabled ||
                  (!changed && draft.status !== "draft") ||
                  stale ||
                  invalidLength ||
                  !!issue
                }
                data-testid="tieba-reply-save"
                onClick={() => void save()}
              >
                保存并检查
              </Button>
              <Button
                primary
                disabled={
                  disabled ||
                  changed ||
                  stale ||
                  draft.status !== "ready" ||
                  !!issue
                }
                data-testid="tieba-reply-submit"
                onClick={() => void submit()}
              >
                提交回复
              </Button>
            </>
          ) : draft.status === "uncertain" ? (
            <Button
              primary
              disabled={disabled}
              data-testid="tieba-reply-reconcile"
              onClick={() => void reconcile()}
            >
              只读核对原回复
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Notice danger>{error}</Notice> : null}
      {local.error ? <Notice warning>{local.error}</Notice> : null}
      {stale && editable ? (
        <Notice warning>
          其他窗口已更新这份回复，当前修改仍保留。请复制需保留的内容，或恢复已保存正文后继续。
        </Notice>
      ) : null}
      {issue && editable ? <Notice warning>{issue}</Notice> : null}
      {draft.status === "uncertain" ? (
        <Notice warning>
          提交结果未知，原正文和记录已保留。只能查询原回复，不会再次点击提交。
        </Notice>
      ) : null}
      {draft.status === "attention" ? (
        <Notice warning>
          生成已中断或费用需要核对，保留现有内容与调用记录；当前不能再次生成或提交。
        </Notice>
      ) : null}
      <div className="tieba-reply-columns">
        {contextView}
        <section className="tieba-reply-draft" aria-label="回复正文与核验记录">
          <div className="tieba-reply-section-heading">
            <h3>回复正文</h3>
            <Status kind={tiebaReplyStatusKind(draft.status)}>
              {tiebaReplyStatusLabels[draft.status]}
            </Status>
          </div>
          <p className="tieba-reply-meta">
            {draft.model ? `模型 ${draft.model} · ` : ""}生成尝试{" "}
            {draft.generationAttempts} 次 · {tiebaTime(draft.updatedAt)}
          </p>
          {draft.status === "generating" ? (
            <LoadingState label="正在生成回复，关闭窗口后仍会保留处理结果…" />
          ) : null}
          {editable ? (
            <>
              <Field
                label="回复正文"
                hint="20–800字；修改后先保存并检查，再提交。"
              >
                <textarea
                  value={body}
                  disabled={disabled}
                  rows={12}
                  maxLength={10000}
                  aria-label="贴吧回复正文"
                  data-testid="tieba-reply-body"
                  onChange={(event) =>
                    local.update({
                      body: event.target.value,
                      baseBody: changed ? local.value.baseBody : draft.body,
                      version: changed ? local.value.version : draft.version,
                    })
                  }
                />
              </Field>
              <div className="tieba-reply-draft-meta">
                <span data-invalid={invalidLength || undefined}>
                  {body.trim().length} / 800 字
                  {changed ? " · 尚未保存" : " · 已保存"}
                </span>
                <Button
                  quiet
                  size="compact"
                  disabled={disabled || (!changed && !stale)}
                  onClick={reset}
                >
                  恢复已保存正文
                </Button>
              </div>
            </>
          ) : draft.body ? (
            <div className="tieba-reply-saved-body">{draft.body}</div>
          ) : null}
          {draft.message ? (
            <p className="tieba-reply-message">{draft.message}</p>
          ) : null}
          {changed && !editable ? (
            <details className="tieba-reply-local-copy">
              <summary>本窗口保留的未保存文字</summary>
              <p className="muted">
                原回复已进入当前状态，下方文字仅为本窗口暂存，不会替换原提交。
              </p>
              <div className="tieba-reply-saved-body">{body}</div>
              <Button
                size="compact"
                quiet
                onClick={async () => {
                  try {
                    await ipc("system.copyText", { text: body });
                    notify("本窗口暂存文字已复制", "success");
                  } catch {
                    notify("复制未完成，可选择文字手动复制", "error");
                  }
                }}
              >
                复制暂存文字
              </Button>
            </details>
          ) : null}
          {draft.evidence.length ? (
            <details className="tieba-reply-evidence">
              <summary>本条回复的依据</summary>
              <ul>
                {draft.evidence.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {draft.checks.length ? (
            <details className="tieba-reply-checks">
              <summary>程序规则检查 · {draft.checks.length} 项</summary>
              <ul>
                {draft.checks.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <p className="muted">
                检查通过不代表事实、发布效果或平台审核已确认。
              </p>
            </details>
          ) : null}
          {draft.receipt ? (
            <section
              className="tieba-reply-receipt"
              aria-label="官网回复核验结果"
            >
              <h4>官网核验结果</h4>
              <p>{draft.receipt.message}</p>
              <small>
                {draft.receipt.status === "verified"
                  ? "已取得官方楼层证据"
                  : "尚未取得确定的楼层证据"}{" "}
                · {tiebaTime(draft.receipt.checkedAt)}
              </small>
              {draft.receipt.url ? (
                <>
                  <p className="tieba-reply-url">{draft.receipt.url}</p>
                  <Button
                    quiet
                    size="compact"
                    onClick={() => void copy(draft.receipt!.url!)}
                  >
                    复制回执链接
                  </Button>
                </>
              ) : null}
            </section>
          ) : null}
        </section>
      </div>
      <div className="tieba-reply-source-link">
        <span>{candidate.url}</span>
        <Button size="compact" quiet onClick={() => void copy(candidate.url)}>
          复制原帖链接
        </Button>
      </div>
    </Dialog>
  );
}
