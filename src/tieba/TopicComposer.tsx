import { z } from "zod";
import type { TiebaTopicsSnapshot } from "../../shared/tieba-topics";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
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
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { TopicEditor } from "./TopicEditor";
import { tiebaTopicStatusKind, tiebaTopicStatusLabels } from "./topic-view";
import { tiebaBackendError, useTiebaAction } from "./useTiebaAction";
import { tiebaStartingTarget, tiebaTime } from "./view-model";

export function TiebaTopicComposer({
  workspace,
  onAccounts,
  refreshRevision = 0,
}: {
  workspace: string;
  onAccounts?(): void;
  refreshRevision?: number;
}) {
  const view = useLocalDraft(
    `tieba-topics-view:${workspace}`,
    {
      expanded: false,
      targetId: "",
      targetTouched: false,
      search: "",
      page: 1,
      editorKey: "",
      editorTargetId: "",
    },
    (value) =>
      z
        .object({
          expanded: z.boolean(),
          targetId: z.string().max(150),
          targetTouched: z.boolean().default(false),
          search: z.string().max(200),
          page: z.number().int().positive(),
          editorKey: z.string().max(200),
          editorTargetId: z.string().max(150),
        })
        .parse(value),
  );
  const query = useIpcQuery("tieba.topics.snapshot", undefined, {
    enabled: view.value.expanded || !!view.value.editorKey,
    keepPrevious: true,
    refreshInterval: 5000,
    invalidate: refreshRevision,
  });
  const action = useTiebaAction<TiebaTopicsSnapshot>(
    query.setData,
    query.reload,
  );
  const s = query.data,
    disabled = action.busy || !!s?.busy || !!query.error;
  const starting = tiebaStartingTarget(
    view.value.targetId,
    view.value.targetTouched,
    s?.targets ?? [],
    s?.accounts ?? [],
  );
  const target = starting.target;
  const drafts = (s?.drafts ?? []).filter(
    (draft) =>
      (!target || draft.targetId === target.id) &&
      (!view.value.search ||
        `${draft.title} ${draft.forumName}`
          .toLocaleLowerCase()
          .includes(view.value.search.toLocaleLowerCase())),
  );
  const page = Math.min(
    view.value.page,
    Math.max(1, Math.ceil(drafts.length / 5)),
  );
  const activeDraft = s?.drafts.find(
    (draft) => `draft:${draft.id}` === view.value.editorKey,
  );
  const activeTarget = s?.targets.find(
    (target) =>
      target.id === (activeDraft?.targetId ?? view.value.editorTargetId),
  );
  const editorExists = view.value.editorKey.startsWith("new:") || !!activeDraft;
  return (
    <Panel
      title="主题与图文"
      className="tieba-console-panel"
      data-testid="tieba-topics"
      extra={
        <Button
          quiet
          size="compact"
          aria-expanded={view.value.expanded}
          data-testid="tieba-topics-expand"
          onClick={() => view.update({ expanded: !view.value.expanded })}
        >
          {view.value.expanded ? "收起" : "展开主题创作"}
        </Button>
      }
    >
      {!view.value.expanded ? (
        <p className="tieba-console-description">
          依据本人或获授权材料创作主题，保存本地图片、核对吧规，再明确提交。
        </p>
      ) : (
        <div className="tieba-console-content">
          <QueryError
            error={
              view.value.editorKey
                ? ""
                : tiebaBackendError(action.error || query.error)
            }
            loading={query.loading}
            onRetry={() => {
              action.clearError();
              query.reload();
            }}
          />
          {view.error ? <Notice warning>{view.error}</Notice> : null}
          {!s && !query.error ? (
            <LoadingState label="正在读取本地主题草稿…" />
          ) : null}
          {s ? (
            <>
              {!starting.available.length && s.targets.length ? (
                <Notice warning>
                  已有创作目标暂不可用：请先核实所属账号登录状态，并检查目标是否暂停。
                  {onAccounts ? (
                    <Button size="compact" onClick={onAccounts}>
                      检查账号登录
                    </Button>
                  ) : null}
                </Notice>
              ) : null}
              {starting.needsRecovery ? (
                <Notice warning>
                  原创作目标已暂停、删除或账号尚未核实，原稿与输入仍保留。
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
              <div className="tieba-console-toolbar">
                <Field label="创作目标贴吧">
                  <Select
                    aria-label="主题发布目标贴吧"
                    value={target?.id ?? ""}
                    disabled={disabled}
                    items={[
                      {
                        value: "",
                        label:
                          !starting.available.length && s.targets.length
                            ? "账号待核验或目标已暂停"
                            : "选择目标贴吧",
                      },
                      ...starting.available.map((target) => ({
                        value: target.id,
                        label: `${target.name}吧 · ${s.accounts.find((account) => account.id === target.accountId)?.alias ?? "贴吧账号"}`,
                      })),
                    ]}
                    onValueChange={(targetId) =>
                      view.update({ targetId, targetTouched: true, page: 1 })
                    }
                  />
                </Field>
                <Button
                  primary
                  disabled={disabled || !target}
                  data-testid="tieba-topic-new"
                  onClick={() =>
                    target &&
                    view.update({
                      editorKey: `new:${crypto.randomUUID()}`,
                      editorTargetId: target.id,
                    })
                  }
                >
                  新建主题草稿
                </Button>
                <SearchField
                  label="搜索主题草稿"
                  placeholder="搜索标题或吧名"
                  value={view.value.search}
                  onChange={(search) => view.update({ search, page: 1 })}
                  className="tieba-console-search"
                />
              </div>
              <p className="tieba-console-description">
                保存与编辑在本地进行；AI生成使用当前文案模型和全局预算，官网发布由你逐稿明确提交。
              </p>
              {drafts.length ? (
                <>
                  <div className="table-scroll">
                    <table
                      className="tieba-topic-table"
                      aria-label="主题与图文草稿"
                    >
                      <thead>
                        <tr>
                          <th>主题 / 目标吧</th>
                          <th>图片 / 来源</th>
                          <th>状态</th>
                          <th>更新与结果</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {drafts.slice((page - 1) * 5, page * 5).map((draft) => (
                          <tr key={draft.id}>
                            <td>
                              <strong>{draft.title || "未命名主题"}</strong>
                              <small>
                                {draft.forumName}吧 ·{" "}
                                {s.accounts.find(
                                  (account) => account.id === draft.accountId,
                                )?.alias ?? "历史账号"}
                              </small>
                            </td>
                            <td>
                              {draft.images.length} 张图片
                              <small>
                                {draft.source.kind === "owned"
                                  ? "本人材料"
                                  : "获授权材料"}
                              </small>
                            </td>
                            <td>
                              <Status kind={tiebaTopicStatusKind(draft.status)}>
                                {tiebaTopicStatusLabels[draft.status]}
                              </Status>
                            </td>
                            <td>
                              {draft.message}
                              <small>{tiebaTime(draft.updatedAt)}</small>
                            </td>
                            <td>
                              <Button
                                quiet
                                size="compact"
                                data-testid="tieba-topic-open"
                                onClick={() => {
                                  action.clearError();
                                  view.update({
                                    editorKey: `draft:${draft.id}`,
                                    editorTargetId: draft.targetId,
                                  });
                                }}
                              >
                                查看与编辑
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={page}
                    pageSize={5}
                    total={drafts.length}
                    onPageChange={(page) => view.update({ page })}
                    label="主题草稿分页"
                  />
                </>
              ) : (
                <Empty
                  compact
                  title={view.value.search ? "没有匹配的主题" : "暂无主题草稿"}
                >
                  选择目标后新建草稿，补充本人材料与引用依据，再准备标题、正文和图片。
                </Empty>
              )}
            </>
          ) : null}
        </div>
      )}
      {s && view.value.editorKey && activeTarget && editorExists ? (
        <TopicEditor
          key={view.value.editorKey}
          workspace={workspace}
          editorKey={view.value.editorKey}
          target={activeTarget}
          initialDraftId={activeDraft?.id ?? ""}
          snapshot={s}
          busy={disabled}
          error={tiebaBackendError(action.error || query.error)}
          close={() => view.update({ editorKey: "" })}
          run={action.run}
        />
      ) : null}
      {s && view.value.editorKey && (!activeTarget || !editorExists) ? (
        <Notice warning>
          原目标或主题暂时无法读取，编辑入口和本地输入已保留。请重新读取本地状态，不会创建替代稿。
        </Notice>
      ) : null}
    </Panel>
  );
}
