import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { TiebaAutocareSnapshot } from "../../shared/tieba-autocare";
import type { TiebaParticipationSnapshot } from "../../shared/tieba-participation";
import type { FeedbackMessage } from "../lib/feedback";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  SearchField,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { LogWindow } from "../ui/LogWindow";
import { ParticipationEditor } from "./ParticipationEditor";
import {
  tiebaReplyStatusKind,
  tiebaReplyStatusLabels,
} from "./participation-view";
import { tiebaStartingTarget, tiebaTime } from "./view-model";
import "./participation.css";

export function TiebaParticipation({
  workspace,
  autocare,
  request,
  onAccounts,
  refreshRevision = 0,
}: {
  workspace: string;
  autocare: TiebaAutocareSnapshot;
  request?: { candidateId: string; requestId: string } | null;
  onAccounts?(): void;
  refreshRevision?: number;
}) {
  const view = useLocalDraft(
    `tieba-participation-view:${workspace}`,
    {
      expanded: false,
      targetId: "",
      targetTouched: false,
      search: "",
      page: 1,
      activeCandidateId: "",
    },
    (value) =>
      z
        .object({
          expanded: z.boolean(),
          targetId: z.string().max(150),
          targetTouched: z.boolean().default(false),
          search: z.string().max(200),
          page: z.number().int().min(1).max(100000),
          activeCandidateId: z.string().max(150),
        })
        .parse(value),
  );
  const query = useIpcQuery("tieba.participation.snapshot", undefined, {
    enabled: view.value.expanded,
    keepPrevious: true,
    refreshInterval: 3000,
    invalidate: refreshRevision,
  });
  useEffect(() => {
    if (request)
      view.update({ expanded: true, activeCandidateId: request.candidateId });
  }, [request?.requestId, view.update]);
  const { notify } = useAppActions();
  const [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const [follow, setFollow] = useState(true);
  const snapshot = query.data;
  const accounts = new Map(
    (snapshot?.accounts ?? autocare.accounts).map((account) => [
      account.id,
      account,
    ]),
  );
  const starting = tiebaStartingTarget(
    view.value.targetId,
    view.value.targetTouched,
    snapshot?.targets ?? autocare.targets,
    snapshot?.accounts ?? autocare.accounts,
  );
  const targets = starting.available,
    selectedTarget = starting.target;
  const candidates = (snapshot?.candidates ?? []).filter(
    (candidate) =>
      (!selectedTarget || candidate.targetId === selectedTarget.id) &&
      (!view.value.search ||
        candidate.title
          .toLocaleLowerCase()
          .includes(view.value.search.toLocaleLowerCase())),
  );
  const page = Math.min(
    view.value.page,
    Math.max(1, Math.ceil(candidates.length / 5)),
  );
  const activeCandidate = snapshot?.candidates.find(
    (candidate) => candidate.id === view.value.activeCandidateId,
  );
  const disabled = working || !!snapshot?.busy || !!query.error;
  const displayError = (activeCandidate ? "" : error) || query.error;
  const pending = /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(displayError);
  const action = async (
    operation: () => Promise<TiebaParticipationSnapshot>,
    resultMessage:
      string | ((value: TiebaParticipationSnapshot) => FeedbackMessage),
  ) => {
    if (lock.current) return;
    lock.current = true;
    setWorking(true);
    setError("");
    try {
      const result = await operation();
      // Mutations update data, never the active candidate or whether its editor is open.
      query.setData(result);
      const message =
        typeof resultMessage === "string"
          ? { text: resultMessage, tone: "success" as const }
          : resultMessage(result);
      notify(message.text, message.tone);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "操作未完成，请重新读取本地状态。",
      );
      query.reload();
    } finally {
      lock.current = false;
      setWorking(false);
    }
  };
  const retry = () => {
    setError("");
    query.reload();
  };
  const read = (candidateId: string) => {
    view.update({ activeCandidateId: candidateId });
    return action(
      () => ipc("tieba.participation.read", { candidateId }),
      "已读取原帖上下文，请查看可参与状态",
    );
  };
  return (
    <Panel
      title="帖子与回复"
      className="tieba-participation"
      data-testid="tieba-participation"
      extra={
        <Button
          quiet
          size="compact"
          aria-expanded={view.value.expanded}
          aria-controls="tieba-participation-content"
          data-testid="tieba-participation-expand"
          onClick={() => view.update({ expanded: !view.value.expanded })}
        >
          {view.value.expanded ? "收起" : "展开帖子与回复"}
        </Button>
      }
    >
      {!view.value.expanded ? (
        <p className="muted tieba-participation-intro">
          读取目标吧近期帖子，依据完整上下文准备回复；生成和提交由你明确发起。
        </p>
      ) : (
        <div
          id="tieba-participation-content"
          className="tieba-participation-content"
        >
          <QueryError
            error={
              pending
                ? "当前后台尚未加载帖子与回复，请手动应用顶部更新后重试。"
                : displayError
            }
            title={pending ? "回复功能等待应用更新" : "帖子与回复暂不可用"}
            loading={query.loading && !!query.error}
            onRetry={retry}
          />
          {view.error ? <Notice warning>{view.error}</Notice> : null}
          {!snapshot && !query.error ? (
            <LoadingState label="正在读取帖子与回复记录…" />
          ) : null}
          {snapshot ? (
            <>
              {!targets.length && snapshot.targets.length ? (
                <Notice warning>
                  已有目标暂不可用：请先核实所属账号登录状态，并检查目标是否暂停。
                  {onAccounts ? (
                    <Button size="compact" onClick={onAccounts}>
                      检查账号登录
                    </Button>
                  ) : null}
                </Notice>
              ) : null}
              {starting.needsRecovery ? (
                <Notice warning>
                  原选择已暂停、删除或账号尚未核实，请重新选择目标。
                  {starting.fallback ? (
                    <Button
                      size="compact"
                      onClick={() =>
                        view.update({
                          targetId: starting.fallback!.id,
                          targetTouched: true,
                          page: 1,
                        })
                      }
                    >
                      改用首个可用目标
                    </Button>
                  ) : null}
                </Notice>
              ) : null}
              <div className="tieba-participation-toolbar">
                <Field label="目标贴吧">
                  <Select
                    aria-label="回复目标贴吧"
                    value={selectedTarget?.id ?? ""}
                    disabled={disabled}
                    items={[
                      {
                        value: "",
                        label: targets.length
                          ? "选择一个目标贴吧"
                          : snapshot.targets.length
                            ? "账号待核验或目标已暂停"
                            : "请先添加贴吧",
                      },
                      ...targets.map((target) => ({
                        value: target.id,
                        label: `${target.name}吧${target.source === "observed" ? " · 待关注" : ""} · ${accounts.get(target.accountId)?.alias ?? "历史账号"}`,
                      })),
                    ]}
                    onValueChange={(targetId) =>
                      view.update({ targetId, targetTouched: true, page: 1 })
                    }
                  />
                </Field>
                <Button
                  disabled={disabled || !selectedTarget}
                  data-testid="tieba-discover"
                  onClick={() =>
                    selectedTarget &&
                    void action(
                      () =>
                        ipc("tieba.participation.discover", {
                          targetId: selectedTarget.id,
                        }),
                      "已读取近期帖子，候选保存在本地",
                    )
                  }
                >
                  发现近期帖子
                </Button>
                <SearchField
                  label="搜索回复候选帖子"
                  placeholder="搜索帖子标题"
                  value={view.value.search}
                  className="tieba-participation-search"
                  onChange={(search) => view.update({ search, page: 1 })}
                />
              </div>
              <p className="tieba-participation-hint">
                {snapshot.message ||
                  "发现和读取访问官网；AI生成会使用当前文案模型与全局预算。"}
              </p>
              {candidates.length ? (
                <>
                  <div className="table-scroll">
                    <table
                      className="tieba-participation-table"
                      aria-label="贴吧回复候选帖子"
                    >
                      <thead>
                        <tr>
                          <th scope="col">帖子 / 目标吧</th>
                          <th scope="col">上下文</th>
                          <th scope="col">回复状态</th>
                          <th scope="col">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {candidates
                          .slice((page - 1) * 5, page * 5)
                          .map((candidate) => {
                            const draft = snapshot.drafts.find(
                              (item) => item.candidateId === candidate.id,
                            );
                            return (
                              <tr key={candidate.id}>
                                <td>
                                  <strong>{candidate.title}</strong>
                                  <small>
                                    {candidate.forumName}吧 ·{" "}
                                    {accounts.get(candidate.accountId)?.alias ??
                                      "历史账号"}
                                    {candidate.replyCount === null
                                      ? ""
                                      : ` · ${candidate.replyCount}条回复`}
                                  </small>
                                </td>
                                <td>
                                  {candidate.context
                                    ? candidate.context.truncated
                                      ? "未完整读取"
                                      : "已读取"
                                    : "待读取"}
                                  <small>
                                    {candidate.context
                                      ? tiebaTime(candidate.context.checkedAt)
                                      : tiebaTime(candidate.discoveredAt)}
                                  </small>
                                </td>
                                <td>
                                  {draft ? (
                                    <Status
                                      kind={tiebaReplyStatusKind(draft.status)}
                                    >
                                      {tiebaReplyStatusLabels[draft.status]}
                                    </Status>
                                  ) : (
                                    <Status
                                      kind={
                                        candidate.status === "skipped"
                                          ? "warning"
                                          : "normal"
                                      }
                                    >
                                      {candidate.status === "skipped"
                                        ? "已跳过"
                                        : "尚未准备"}
                                    </Status>
                                  )}
                                  <small>
                                    {draft?.message || candidate.message}
                                  </small>
                                </td>
                                <td>
                                  <Button
                                    size="compact"
                                    quiet
                                    disabled={working}
                                    data-testid="tieba-candidate-open"
                                    onClick={() =>
                                      candidate.context || draft
                                        ? view.update({
                                            activeCandidateId: candidate.id,
                                          })
                                        : void read(candidate.id)
                                    }
                                  >
                                    {candidate.context || draft
                                      ? "查看上下文与回复"
                                      : "读取并查看"}
                                  </Button>
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={page}
                    pageSize={5}
                    total={candidates.length}
                    onPageChange={(next) => view.update({ page: next })}
                    label="贴吧回复候选分页"
                  />
                </>
              ) : (
                <Empty
                  compact
                  title={view.value.search ? "没有匹配的帖子" : "暂无回复候选"}
                >
                  {view.value.search
                    ? "换一个标题关键词，或清空搜索。"
                    : "选择已添加的目标贴吧，点击“发现近期帖子”。仅保存候选，不会自动生成或发言。"}
                </Empty>
              )}
              {snapshot.logs.items.length ? (
                <details className="tieba-participation-log">
                  <summary>
                    回复运行记录 · {snapshot.logs.items.length} 条
                  </summary>
                  <LogWindow
                    items={snapshot.logs.items}
                    label="贴吧帖子与回复日志"
                    simple
                    follow={follow}
                    onFollowChange={setFollow}
                    context={(entry) =>
                      entry.accountId
                        ? (accounts.get(entry.accountId)?.alias ?? "历史账号")
                        : "系统"
                    }
                  />
                </details>
              ) : null}
            </>
          ) : null}
          {snapshot && activeCandidate ? (
            <ParticipationEditor
              key={activeCandidate.id}
              workspace={workspace}
              candidate={activeCandidate}
              draft={
                snapshot.drafts.find(
                  (draft) => draft.candidateId === activeCandidate.id,
                ) ?? null
              }
              accountName={
                accounts.get(activeCandidate.accountId)?.alias ?? "历史账号"
              }
              busy={working || snapshot.busy}
              unavailable={!!query.error}
              error={error}
              close={() => view.update({ activeCandidateId: "" })}
              read={() => void read(activeCandidate.id)}
              action={action}
            />
          ) : null}
        </div>
      )}
    </Panel>
  );
}
