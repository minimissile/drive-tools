import { useState } from "react";
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
import { OperationsWorkspace } from "./Workspace";
import { useOperation, useOperationAction } from "./hooks";
import { RunPanel } from "./RunPanel";
import { ResultTable } from "./Results";
export default function Publish() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation(),
    model = useOperation("publish"),
    action = useOperationAction();
  const [page, setPage] = useState(1),
    [consent, setConsent] = useState(false);
  const draft = useLocalDraft(
    `panxu-zhidao-publish:${data!.dataPath}`,
    { accountId: "", taskName: "问答模板发布", itemIds: [] as string[] },
    (v) =>
      z
        .object({
          accountId: z.string(),
          taskName: z.string(),
          itemIds: z.array(z.string()).max(100).default([]),
        })
        .parse(v),
  );
  const selected = draft.value.itemIds;
  const setSelected = (itemIds: string[]) => draft.update({ itemIds });
  const accounts = useIpcQuery("zhidao.accounts", undefined, {}),
    templates = useIpcQuery(
      "zhidao.templates",
      { page },
      { keepPrevious: true, refreshInterval: 3000 },
    );
  return (
    <OperationsWorkspace
      title="发布任务"
      description="选择审核后的问答，用具备快捷答题资格的百度知道账号上传。任务创建与平台审核分别记录。"
    >
      <Panel
        title="待发布问答"
        extra={
          <Button quiet onClick={() => navigate("zhidao-templates")}>
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
            <Notice>
              打开编辑按钮核对内容并保存审核状态。标题不超过49字；修改过的内容需要重新审核。
            </Notice>
            <ResultTable
              items={templates.data.items}
              selected={selected}
              onSelect={(ids) => {
                setSelected(ids);
                setConsent(false);
              }}
              editable
              onChanged={templates.reload}
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
        <QueryError
          error={accounts.error}
          loading={accounts.loading}
          onRetry={accounts.reload}
        />
        <div className="operations-form-grid">
          <Field label="发布账号">
            <Select
              value={draft.value.accountId}
              onValueChange={(accountId) => {
                draft.update({ accountId });
                setConsent(false);
              }}
              items={[
                { value: "", label: "选择具有快捷答题资格的账号" },
                ...(accounts.data ?? [])
                  .filter((a) => a.status === "connected" && a.bulkPermission)
                  .map((a) => ({ value: a.id, label: a.alias })),
              ]}
            />
          </Field>
          <Field label="任务名称">
            <input
              value={draft.value.taskName}
              maxLength={100}
              onChange={(e) => {
                draft.update({ taskName: e.target.value });
                setConsent(false);
              }}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          我已审核所选{selected.length}条问答，确认使用此账号真实上传
        </label>
        {draft.error ? <Notice danger>{draft.error}</Notice> : null}
        <div className="operations-actions">
          <Button
            primary
            disabled={
              !selected.length ||
              !consent ||
              !draft.value.accountId ||
              !draft.value.taskName.trim() ||
              !!action.pending ||
              model.running
            }
            onClick={() =>
              void action.run(
                "zhidao.start",
                {
                  kind: "publish",
                  input: {
                    itemIds: selected,
                    accountId: draft.value.accountId,
                    taskName: draft.value.taskName,
                  },
                  authorized: true,
                },
                (run) => {
                  setConsent(false);
                  setSelected([]);
                  model.pick(run);
                },
                "发布任务已开始",
              )
            }
          >
            上传所选问答
          </Button>
          <Button quiet onClick={() => navigate("zhidao-accounts")}>
            检查账号资格
          </Button>
          <span>选中项跨页保留，最多100条</span>
        </div>
      </Panel>
      <RunPanel model={model}>
        {(items) => (
          <ResultTable
            items={items}
            running={model.running}
            onChanged={model.refresh}
          />
        )}
      </RunPanel>
    </OperationsWorkspace>
  );
}
