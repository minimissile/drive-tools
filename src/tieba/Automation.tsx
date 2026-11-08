import { useEffect, useRef } from "react";
import { z } from "zod";
import {
  tiebaAutomationConfigSchema,
  type TiebaAutomationSnapshot,
  type TiebaAutomationConfig,
} from "../../shared/tieba-automation";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { updateSelection } from "../lib/selection";
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
import { CheckboxField } from "../ui/CheckboxField";
import { Dialog } from "../ui/Dialog";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { tiebaBackendError, useTiebaAction } from "./useTiebaAction";
import { tiebaTime } from "./view-model";
import {
  tiebaAutomationConfigView,
  tiebaAutomationTaskLabels,
  tiebaAutomationTaskKind,
  tiebaAutomationInitialRecommendation,
} from "./console-view";

export function TiebaAutomation({
  workspace,
  openReply,
  refreshRevision = 0,
}: {
  workspace: string;
  openReply(candidateId: string): void;
  refreshRevision?: number;
}) {
  const view = useLocalDraft(
    `tieba-automation-view:${workspace}`,
    { expanded: false, editing: false, history: false, page: 1 },
    (value) =>
      z
        .object({
          expanded: z.boolean(),
          editing: z.boolean(),
          history: z.boolean(),
          page: z.number().int().positive(),
        })
        .parse(value),
  );
  const query = useIpcQuery("tieba.automation.snapshot", undefined, {
    keepPrevious: true,
    refreshInterval: 5000,
    invalidate: refreshRevision,
  });
  const action = useTiebaAction<TiebaAutomationSnapshot>(
    query.setData,
    query.reload,
  );
  const s = query.data,
    disabled = action.busy || !!s?.busy || !!query.error;
  const recommended = s ? tiebaAutomationInitialRecommendation(s) : null;
  const tasks = (s?.tasks ?? []).filter(
    (task) => view.value.history || task.runId === s?.run?.id,
  );
  const page = Math.min(
    view.value.page,
    Math.max(1, Math.ceil(tasks.length / 5)),
  );
  const names = new Map(
    s?.accounts.map((account) => [
      account.id,
      account.alias || account.nickname || "贴吧账号",
    ]),
  );
  return (
    <Panel
      title="自动回帖批次"
      className="tieba-console-panel"
      data-testid="tieba-automation"
      extra={
        <div className="row compact">
          {s ? (
            <Status kind={s.enabled ? "normal" : "warning"}>
              {s.enabled ? "批次已开启" : "已关闭"}
            </Status>
          ) : null}
          <Button
            quiet
            size="compact"
            aria-expanded={view.value.expanded}
            onClick={() => view.update({ expanded: !view.value.expanded })}
            data-testid="tieba-automation-expand"
          >
            {view.value.expanded ? "收起" : "展开批次"}
          </Button>
        </div>
      }
    >
      {!view.value.expanded ? (
        <p className="tieba-console-description">
          {s?.enabled
            ? s.message
            : "默认关闭；选择目标后以低频预设自动准备回复，发布模式需明确开启。"}
        </p>
      ) : (
        <div className="tieba-console-content">
          <QueryError
            error={
              view.value.editing
                ? ""
                : tiebaBackendError(action.error || query.error)
            }
            loading={query.loading}
            onRetry={() => {
              action.clearError();
              query.reload();
            }}
          />
          {!s && !query.error ? (
            <LoadingState label="正在读取回帖批次…" />
          ) : null}
          {s ? (
            <>
              <div className="tieba-console-toolbar">
                <div className="tieba-console-summary">
                  <strong>
                    {s.config.mode === "draft"
                      ? "只准备草稿"
                      : "准备并自动发布"}
                  </strong>
                  <span>
                    已保存 {s.config.targetIds.length} 个目标 ·
                    每日全部目标合计最多 {s.config.dailyLimit} 个主题
                  </span>
                  {s.run ? (
                    <small>
                      本轮 {tiebaTime(s.run.startedAt)} —{" "}
                      {tiebaTime(s.run.deadlineAt)} · 北京时间
                    </small>
                  ) : (
                    <small>
                      固定两小时批次；两条任务间隔45分钟，过期不补跑。
                    </small>
                  )}
                </div>
                {recommended ? (
                  <Button
                    disabled={disabled}
                    data-testid="tieba-automation-save-recommended"
                    onClick={() =>
                      void action.run(
                        () =>
                          ipc("tieba.automation.save", {
                            config: recommended,
                            revision: s.revision,
                          }),
                        "推荐草稿范围已保存，尚未开启付费批次",
                      )
                    }
                  >
                    保存推荐范围（{recommended.targetIds.length}个吧）
                  </Button>
                ) : null}
                <Button
                  disabled={disabled}
                  data-testid="tieba-automation-settings"
                  onClick={() => view.update({ editing: true })}
                >
                  设置范围与模式
                </Button>
                {s.enabled ? (
                  <Button
                    disabled={action.busy || !!query.error}
                    onClick={() =>
                      void action.run(
                        () =>
                          ipc("tieba.automation.toggle", {
                            enabled: false,
                            revision: s.revision,
                            confirmed: true,
                          }),
                        "已停止新回帖任务，原未知结果仅核对",
                      )
                    }
                    data-testid="tieba-automation-stop"
                  >
                    关闭本批次
                  </Button>
                ) : (
                  <Button
                    primary
                    disabled={disabled || !s.config.targetIds.length}
                    onClick={() =>
                      void action.run(
                        () =>
                          ipc("tieba.automation.toggle", {
                            enabled: true,
                            revision: s.revision,
                            confirmed: true,
                          }),
                        (value) => ({
                          text: value.enabled
                            ? "已明确开启本次两小时回帖批次"
                            : value.message,
                          tone: value.enabled ? "success" : "warning",
                        }),
                      )
                    }
                    data-testid="tieba-automation-start"
                  >
                    开启两小时批次
                  </Button>
                )}
              </div>
              <Notice warning>
                开启即授权所选范围内自动调用当前文案模型，费用计入全局美元预算；每日最多{" "}
                {s.config.dailyLimit} 个准备主题，失败尝试也可能计费。
                {s.config.mode === "publish"
                  ? "当前发布模式还包含自动提交官网回复，请先检查目标与模式。"
                  : "当前模式将回复保留为草稿，发布时需另行明确提交。"}
              </Notice>
              <div className="tieba-console-toolbar">
                <p className="tieba-console-description">{s.message}</p>
                <CheckboxField
                  label="显示历史批次"
                  checked={view.value.history}
                  onChange={(event) =>
                    view.update({ history: event.target.checked, page: 1 })
                  }
                />
              </div>
              {tasks.length ? (
                <>
                  <div className="table-scroll">
                    <table
                      className="tieba-automation-table"
                      aria-label="自动回帖批次计划"
                    >
                      <thead>
                        <tr>
                          <th>目标 / 模式</th>
                          <th>计划时间</th>
                          <th>结果</th>
                          <th>处理情况</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tasks.slice((page - 1) * 5, page * 5).map((task) => (
                          <tr key={task.id}>
                            <td>
                              <strong>{task.forumName}吧</strong>
                              <small>
                                {names.get(task.accountId) ?? "历史账号"} ·{" "}
                                {task.mode === "draft" ? "草稿" : "发布"}
                              </small>
                            </td>
                            <td>
                              {tiebaTime(task.plannedAt)}
                              <small>截止 {tiebaTime(task.deadlineAt)}</small>
                            </td>
                            <td>
                              <Status
                                kind={tiebaAutomationTaskKind(task.status)}
                              >
                                {tiebaAutomationTaskLabels[task.status]}
                              </Status>
                            </td>
                            <td>{task.message}</td>
                            <td>
                              {task.status === "uncertain" ? (
                                <Button
                                  quiet
                                  size="compact"
                                  disabled={disabled}
                                  data-testid="tieba-automation-reconcile"
                                  onClick={() =>
                                    void action.run(
                                      () =>
                                        ipc("tieba.automation.reconcile", {
                                          taskId: task.id,
                                        }),
                                      (value) => {
                                        const result = value.tasks.find(
                                          (item) => item.id === task.id,
                                        );
                                        return {
                                          text:
                                            result?.message ??
                                            "原回复结果仍待核对。",
                                          tone:
                                            result?.status === "verified"
                                              ? "success"
                                              : "warning",
                                        };
                                      },
                                    )
                                  }
                                >
                                  核对原结果
                                </Button>
                              ) : task.candidateId ? (
                                <Button
                                  quiet
                                  size="compact"
                                  data-testid="tieba-automation-open-reply"
                                  onClick={() => openReply(task.candidateId!)}
                                >
                                  查看原回复
                                </Button>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={page}
                    pageSize={5}
                    total={tasks.length}
                    onPageChange={(page) => view.update({ page })}
                    label="自动回帖计划分页"
                  />
                </>
              ) : (
                <Empty compact title="暂无本轮回帖计划">
                  保存目标与低频预设后，明确开启一次两小时批次；任务与原结果会留在这里。
                </Empty>
              )}
              {s.logs.items.length ? (
                <details className="tieba-console-details">
                  <summary>批次运行记录 · {s.logs.items.length} 条</summary>
                  <ul>
                    {s.logs.items.slice(0, 20).map((entry, index) => (
                      <li key={index}>{entry.message}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      )}
      {s && view.value.editing ? (
        <AutomationSettings
          key={workspace}
          snapshot={s}
          workspace={workspace}
          busy={disabled}
          error={tiebaBackendError(action.error || query.error)}
          onClose={() => view.update({ editing: false })}
          save={(config) =>
            action.run(
              () =>
                ipc("tieba.automation.save", { config, revision: s.revision }),
              "批次设置已保存并关闭，需要再次明确开启",
            )
          }
        />
      ) : null}
    </Panel>
  );
}

function AutomationSettings({
  snapshot: s,
  workspace,
  busy,
  error,
  onClose,
  save,
}: {
  snapshot: TiebaAutomationSnapshot;
  workspace: string;
  busy: boolean;
  error: string;
  onClose(): void;
  save(config: TiebaAutomationConfig): Promise<TiebaAutomationSnapshot | null>;
}) {
  const recommended = tiebaAutomationInitialRecommendation(s);
  const local = useLocalDraft(
    `tieba-automation-config:${workspace}`,
    {
      config: recommended ?? s.config,
      base: s.config,
      revision: s.revision,
      search: "",
      page: 1,
    },
    (value) =>
      z
        .object({
          config: tiebaAutomationConfigSchema,
          base: tiebaAutomationConfigSchema,
          revision: z.number().int().positive(),
          search: z.string().max(200),
          page: z.number().int().positive(),
        })
        .parse(value),
  );
  const derived = tiebaAutomationConfigView(local.value, s),
    config = derived.config;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = (patch: Partial<TiebaAutomationConfig>) =>
    local.update({
      config: { ...config, ...patch },
      base: derived.changed ? local.value.base : s.config,
      revision: derived.changed ? local.value.revision : s.revision,
    });
  const targets = s.targets.filter(
    (target) =>
      !target.paused &&
      s.accounts.some(
        (account) =>
          account.id === target.accountId && account.uid === target.uid,
      ) &&
      (!local.value.search ||
        target.name
          .toLocaleLowerCase()
          .includes(local.value.search.toLocaleLowerCase())),
  );
  const page = Math.min(
    local.value.page,
    Math.max(1, Math.ceil(targets.length / 8)),
  );
  return (
    <Dialog
      title="自动回帖范围与模式"
      className="tieba-automation-dialog"
      onClose={onClose}
      focus="container"
      footer={
        <>
          <span className="tieba-console-scope">
            保存会关闭当前批次，授权需再次明确开启。
          </span>
          <Button onClick={onClose}>关闭</Button>
          <Button
            disabled={busy || (!derived.changed && !derived.stale)}
            onClick={() =>
              local.update({
                config: s.config,
                base: s.config,
                revision: s.revision,
              })
            }
          >
            恢复已保存设置
          </Button>
          <Button
            primary
            disabled={busy || derived.stale || !derived.changed}
            data-testid="tieba-automation-save"
            onClick={() =>
              void (async () => {
                const result = await save(config);
                if (result && mounted.current)
                  local.update({
                    config: result.config,
                    base: result.config,
                    revision: result.revision,
                  });
              })()
            }
          >
            保存批次设置
          </Button>
        </>
      }
    >
      {error ? <Notice danger>{error}</Notice> : null}
      {local.error ? <Notice warning>{local.error}</Notice> : null}
      {derived.stale ? (
        <Notice warning>
          其他窗口已更新设置，当前草稿保留。请先恢复已保存设置后再调整。
        </Notice>
      ) : null}
      <div className="tieba-console-form-row">
        <Field label="工作模式">
          <Select
            aria-label="自动回帖模式"
            value={config.mode}
            disabled={busy}
            items={[
              { value: "draft", label: "推荐：只准备草稿" },
              { value: "publish", label: "准备并自动发布" },
            ]}
            onValueChange={(mode) =>
              update({ mode: mode as "draft" | "publish" })
            }
          />
        </Field>
        <Field label="低频预设">
          <Select
            aria-label="自动回帖每日数量"
            value={config.dailyLimit}
            disabled={busy}
            items={[
              { value: 1, label: "保守：每日共1个主题" },
              { value: 2, label: "标准：每日共2个主题" },
            ]}
            onValueChange={(value) => update({ dailyLimit: Number(value) })}
          />
        </Field>
      </div>
      <p className="tieba-console-description">
        全部账号与目标合计上限；固定两小时批次，两项间隔45分钟。先选择确实需要参与的目标贴吧。
      </p>
      <SearchField
        label="搜索自动回帖目标"
        value={local.value.search}
        onChange={(search) => local.update({ search, page: 1 })}
        placeholder="搜索吧名"
      />
      {targets.length ? (
        <div className="tieba-automation-targets">
          {targets.slice((page - 1) * 8, page * 8).map((target) => (
            <CheckboxField
              key={target.id}
              label={`${target.name}吧 · ${s.accounts.find((account) => account.id === target.accountId)?.alias ?? "贴吧账号"}`}
              hint={target.source === "observed" ? "待关注" : "关注同步"}
              disabled={busy}
              checked={config.targetIds.includes(target.id)}
              onChange={(event) =>
                update({
                  targetIds: updateSelection(
                    config.targetIds,
                    [target.id],
                    event.target.checked,
                    300,
                  ),
                })
              }
            />
          ))}
        </div>
      ) : (
        <Empty compact title="暂无可用目标">
          先添加贴吧，暂停的目标不能进入新批次。
        </Empty>
      )}
      <Pagination
        page={page}
        pageSize={8}
        total={targets.length}
        onPageChange={(page) => local.update({ page })}
        label="自动回帖目标分页"
      />
    </Dialog>
  );
}
