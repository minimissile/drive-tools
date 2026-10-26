import { useEffect, useState } from "react";
import { z } from "zod";
import { useAppData, useAppNavigation } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useIpcQuery } from "../api/useIpcQuery";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { Pagination } from "../ui/Pagination";
import { CheckboxField } from "../ui/CheckboxField";
import { formatTime } from "../lib/format";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import {
  zhidaoPublishLimit,
  zhidaoContentIssue,
  zhidaoTaskNameLimit,
} from "../../shared/zhidao-publishing";
import { useOperation, useOperationAction } from "./hooks";
import { RunPanel } from "./RunPanel";
import { ResultTable } from "./Results";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { GenerationWorkbench } from "./GenerationWorkbench";
import { useTaskFocus } from "../tasks/TaskFocus";
import { usePublishingView } from "./usePublishingView";
import "./publishing.css";

export default function Publish() {
  const { focus } = useTaskFocus();
  const view = usePublishingView();
  useEffect(() => {
    if (focus?.kind === "publish") view.update({ tab: "upload" });
  }, [focus, view.update]);
  return (
    <OperationsWorkspace
      title="发布任务"
      description="从资源表格生成问答，预览并审核内容，再合并上传到答主工作台。"
    >
      <Tabs value={view.value.tab} onChange={(tab) => view.update({ tab })}>
        <TabList
          label="百度知道发布工作区"
          items={[
            ["generate", "生成问答"],
            ["upload", "审核上传"],
          ]}
        />
        <TabPanel value="generate">
          <GenerationWorkbench onReady={() => view.update({ tab: "upload" })} />
        </TabPanel>
        <TabPanel value="upload">
          <UploadWorkspace />
        </TabPanel>
      </Tabs>
    </OperationsWorkspace>
  );
}

function UploadWorkspace() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation(),
    model = useOperation("publish"),
    action = useOperationAction();
  const [page, setPage] = useState(1),
    [consent, setConsent] = useState(false),
    [checkError, setCheckError] = useState("");
  const draft = useLocalDraft(
    `panxu-zhidao-publish:${data!.dataPath}`,
    { accountId: "", taskName: "问答模板发布", itemIds: [] as string[] },
    (value) =>
      z
        .object({
          accountId: z.string(),
          taskName: z.string(),
          itemIds: z.array(z.string()).max(zhidaoPublishLimit).default([]),
        })
        .parse(value),
  );
  const selected = draft.value.itemIds;
  const accounts = useIpcQuery("zhidao.accounts", undefined, {
    keepPrevious: true,
  });
  const templates = useIpcQuery(
    "zhidao.templates",
    { page },
    { keepPrevious: true, refreshInterval: 3000 },
  );
  const preview = useIpcQuery(
    "zhidao.publish.preview",
    { itemIds: selected, accountId: draft.value.accountId },
    { enabled: selected.length > 0, refreshInterval: 3000 },
  );
  const account = accounts.data?.find(
    (item) => item.id === draft.value.accountId,
  );
  const rights = account?.publishingRights;
  const busy = !!action.pending || model.running;
  const taskName = draft.value.taskName.trim();
  const nameInvalid = !taskName || taskName.length > zhidaoTaskNameLimit;
  const accountIssue = accounts.error
    ? "账号读取失败，请重试后上传。"
    : !draft.value.accountId
      ? "选择发布账号后，检查批量上传权限与剩余额度。"
      : !accounts.data
        ? "正在读取账号…"
        : !account
          ? "原账号已移除，请重新选择发布账号。"
          : account.status !== "connected"
            ? "账号尚未检查或登录已失效，请登录后刷新资格。"
            : rights?.isBanned
              ? "此账号的批量上传权益受限，请在答主工作台核对。"
              : account.bulkPermission !== true
                ? "批量上传权限尚未确认，请刷新资格与额度。"
                : rights?.remainingQuota !== null &&
                    rights?.remainingQuota !== undefined &&
                    rights.remainingQuota < selected.length
                  ? `剩余额度${rights.remainingQuota}条，不足以上传所选${selected.length}条问答。`
                  : "";
  const previewIssue = preview.data?.errors.join(" ") ?? "";
  const canSubmit =
    selected.length > 0 &&
    consent &&
    !busy &&
    !nameInvalid &&
    !accountIssue &&
    !!preview.data &&
    !preview.error &&
    !previewIssue;
  useEffect(() => {
    setConsent(false);
  }, [
    draft.value.accountId,
    draft.value.taskName,
    selected.join(","),
    preview.data?.revision,
  ]);
  return (
    <div className="publish-upload-workspace">
      <Panel
        title="上传设置"
        extra={
          <Button
            quiet
            disabled={busy}
            onClick={() => navigate("zhidao-accounts")}
          >
            管理发布账号
          </Button>
        }
      >
        <QueryError
          error={accounts.error}
          loading={accounts.loading}
          onRetry={accounts.reload}
        />
        <div className="operations-form-grid">
          <Field label="发布账号">
            <Select
              disabled={busy || !accounts.data}
              value={draft.value.accountId}
              onValueChange={(accountId) => {
                draft.update({ accountId });
                setCheckError("");
              }}
              items={[
                { value: "", label: "选择百度知道账号" },
                ...(draft.value.accountId && !account
                  ? [
                      {
                        value: draft.value.accountId,
                        label: accounts.error
                          ? "账号暂未读取"
                          : accounts.data
                            ? "原账号已移除，请重新选择"
                            : "正在读取账号…",
                        disabled: true,
                      },
                    ]
                  : []),
                ...(accounts.data ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.alias}${item.bulkPermission === true ? " · 可批量上传" : " · 待检查资格"}`,
                })),
              ]}
            />
          </Field>
          <Field
            label="任务名称"
            hint={`${draft.value.taskName.length} / ${zhidaoTaskNameLimit}字；与官方上传记录中的名称一致`}
          >
            <input
              aria-label="任务名称"
              value={draft.value.taskName}
              maxLength={zhidaoTaskNameLimit}
              disabled={busy}
              aria-invalid={nameInvalid || undefined}
              onChange={(event) =>
                draft.update({ taskName: event.target.value })
              }
            />
          </Field>
        </div>
        <div className="publish-account-status">
          <div>
            {account?.status === "connected" &&
            account.bulkPermission === true &&
            !rights?.isBanned ? (
              <strong>具有批量上传权限</strong>
            ) : (
              <strong>资格待确认</strong>
            )}
            <span>
              剩余额度{" "}
              {rights?.remainingQuota == null
                ? "待查询"
                : `${rights.remainingQuota.toLocaleString()} 条`}
            </span>
            {account?.checkedAt ? (
              <small>
                上次检查 {formatTime(account.checkedAt)} · 上传前会再次核对
              </small>
            ) : null}
          </div>
          <Button
            disabled={!account || busy || !!accounts.error}
            onClick={() => {
              setConsent(false);
              setCheckError("");
              void action.run(
                "zhidao.account.check",
                { id: draft.value.accountId },
                () => accounts.reload(),
                undefined,
                (error) => setCheckError(error.message),
              );
            }}
          >
            {action.pending === "zhidao.account.check"
              ? "正在检查…"
              : "刷新资格与额度"}
          </Button>
        </div>
        {checkError ? (
          <Notice danger>{checkError}</Notice>
        ) : !accounts.error && accountIssue ? (
          <Notice warning>{accountIssue}</Notice>
        ) : null}
        {nameInvalid ? (
          <Notice warning>任务名称需填写1–15字，请修改后上传。</Notice>
        ) : null}
        <QueryError
          error={preview.error}
          loading={preview.loading}
          onRetry={preview.reload}
        />
        {previewIssue ? (
          <Notice warning>{previewIssue} 可清空选择后重新审核、选择。</Notice>
        ) : null}
        <CheckboxField
          checked={consent}
          disabled={
            busy ||
            !selected.length ||
            !!accountIssue ||
            !preview.data ||
            !!preview.error ||
            !!previewIssue ||
            nameInvalid
          }
          onChange={(event) => setConsent(event.target.checked)}
          label={
            selected.length
              ? `我已审核所选${selected.length}条问答，确认使用此账号真实上传`
              : "请先审核并选择下方问答"
          }
          hint={
            selected.length
              ? "本次合并为一份 Excel、创建一个平台任务。上传后仍需等待平台审核。"
              : "点击问答的勾选框或「审核并选择」，核对内容后会自动选中。"
          }
        />
        {draft.error ? <Notice danger>{draft.error}</Notice> : null}
        <div className="operations-actions publish-actions">
          <Button
            primary
            disabled={!canSubmit}
            onClick={() =>
              void action.run(
                "zhidao.start",
                {
                  kind: "publish",
                  input: {
                    itemIds: selected,
                    accountId: draft.value.accountId,
                    taskName,
                    selectionRevision: preview.data!.revision,
                  },
                  authorized: true,
                },
                (run) => {
                  setConsent(false);
                  draft.update({ itemIds: [] });
                  model.pick(run);
                },
                "发布任务已开始",
              )
            }
          >
            {action.pending === "zhidao.start"
              ? "正在创建任务…"
              : "上传所选问答"}
          </Button>
          <span>
            已选 {selected.length} / {zhidaoPublishLimit} 条 · 跨页保留
          </span>
          <Button
            quiet
            disabled={!selected.length || busy}
            onClick={() => draft.update({ itemIds: [] })}
          >
            清空选择
          </Button>
        </div>
      </Panel>
      <Panel
        title="待发布问答"
        extra={
          <Button
            quiet
            disabled={busy}
            onClick={() => navigate("zhidao-templates")}
          >
            生成更多模板
          </Button>
        }
      >
        <QueryError
          error={templates.error}
          loading={templates.loading}
          onRetry={templates.reload}
        />
        {!templates.data && !templates.error ? (
          <LoadingState label="正在读取问答模板…" />
        ) : templates.data?.items.length ? (
          <>
            <p className="publish-selection-help">
              点击勾选框或「审核并选择」核对内容，确认后自动选中。全选仅选择本页已审核问答；问题标题不超过49字。
            </p>
            <ResultTable
              items={templates.data.items}
              selected={selected}
              onSelect={(itemIds) => draft.update({ itemIds })}
              selectable={(item) => item.reviewed && !zhidaoContentIssue(item)}
              reviewSelection
              editable
              running={busy}
              onChanged={() => {
                setConsent(false);
                templates.reload();
                preview.reload();
              }}
            />
            <Pagination
              page={page}
              pageSize={25}
              total={templates.data.total}
              onPageChange={setPage}
              label="待发布问答分页"
            />
          </>
        ) : templates.data ? (
          <Empty
            title="还没有待发布问答"
            action={
              <Button onClick={() => navigate("zhidao-templates")}>
                生成问答模板
              </Button>
            }
          >
            也可以先在智能问答中创作回答，再编辑成适合批量上传的问答。
          </Empty>
        ) : null}
      </Panel>
      <RunPanel model={model}>
        {(items) => (
          <ResultTable
            items={items}
            publication
            running={model.running}
            onChanged={model.refresh}
          />
        )}
      </RunPanel>
    </div>
  );
}
