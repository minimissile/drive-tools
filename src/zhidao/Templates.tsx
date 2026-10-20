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
  SearchField,
} from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { updateSelection } from "../lib/selection";
import { OperationsWorkspace } from "./Workspace";
import { useOperation, useOperationAction } from "./hooks";
import { RunPanel } from "./RunPanel";
import { ResultTable } from "./Results";
export default function Templates() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation(),
    model = useOperation("template"),
    action = useOperationAction();
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(1);
  const draft = useLocalDraft(
    `panxu-template:${data!.dataPath}`,
    { verifyFacts: false, copyIds: [] as string[] },
    (v) =>
      z
        .object({
          verifyFacts: z.boolean(),
          copyIds: z.array(z.string()).max(100).default([]),
        })
        .parse(v),
  );
  const selected = draft.value.copyIds;
  const setSelected = (copyIds: string[]) => draft.update({ copyIds });
  const targets = useIpcQuery(
    "zhidao.targets",
    { query, page },
    { keepPrevious: true, delay: 180 },
  );
  return (
    <OperationsWorkspace
      title="问答模板"
      description="选择已核验的本人百度网盘分享，生成问题标题与 HTML 回答，编辑审核后导出或发布。"
    >
      <Panel
        title="选择本人资料"
        extra={
          <Button quiet onClick={() => navigate("drive-files")}>
            从网盘文件生成分享
          </Button>
        }
      >
        <SearchField
          value={query}
          onChange={(value) => {
            setQuery(value);
            setPage(1);
          }}
          label="搜索模板资料"
          placeholder="搜索已核验的资料名称"
        />
        <QueryError
          error={targets.error}
          loading={targets.loading}
          onRetry={targets.reload}
        />
        {!targets.data && !targets.error ? (
          <LoadingState label="正在读取本人资源…" />
        ) : targets.data?.items.length ? (
          <>
            <div className="operations-targets">
              <label className="check">
                <SelectionCheckbox
                  aria-label="选择本页资料"
                  selected={
                    targets.data.items.filter((i) =>
                      selected.includes(i.copyId),
                    ).length
                  }
                  total={targets.data.items.length}
                  onChange={(e) =>
                    setSelected(
                      updateSelection(
                        selected,
                        targets.data!.items.map((i) => i.copyId),
                        e.target.checked,
                        100,
                      ),
                    )
                  }
                />
                选择本页
              </label>
              {targets.data.items.map((item) => (
                <label className="operation-target" key={item.copyId}>
                  <input
                    type="checkbox"
                    checked={selected.includes(item.copyId)}
                    onChange={(e) =>
                      setSelected(
                        updateSelection(
                          selected,
                          [item.copyId],
                          e.target.checked,
                          100,
                        ),
                      )
                    }
                  />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.url}</small>
                  </span>
                </label>
              ))}
            </div>
            <Pagination
              page={page}
              pageSize={25}
              total={targets.data.total}
              onPageChange={setPage}
              label="模板资源分页"
            />
          </>
        ) : targets.data ? (
          <Empty
            title={
              query ? "没有匹配的本人资源" : "还没有可生成模板的本人百度分享"
            }
            action={
              <Button onClick={() => navigate("batch")}>去转存资料</Button>
            }
          >
            资料需完成本人转存、分享和有效性核验；也可以从网盘文件入口分享已有文件。
          </Empty>
        ) : null}
        <label className="check">
          <input
            type="checkbox"
            checked={draft.value.verifyFacts}
            onChange={(e) => draft.update({ verifyFacts: e.target.checked })}
          />
          生成前检索公开网页核对资料（保留证据）
        </label>
        {draft.error ? <Notice danger>{draft.error}</Notice> : null}
        <div className="operations-actions">
          <span>已选{selected.length}份资料，跨页保留，最多100份</span>
          <Button
            primary
            disabled={!selected.length || !!action.pending || model.running}
            onClick={() =>
              void action.run(
                "zhidao.start",
                {
                  kind: "template",
                  input: {
                    copyIds: selected,
                    verifyFacts: draft.value.verifyFacts,
                  },
                  authorized: true,
                },
                model.pick,
                "模板生成任务已开始",
              )
            }
          >
            生成问答模板
          </Button>
          <Button quiet onClick={() => navigate("zhidao-publish")}>
            去审核并发布
          </Button>
        </div>
      </Panel>
      <RunPanel model={model}>
        {(items) => (
          <ResultTable
            items={items}
            editable
            running={model.running}
            onChanged={model.refresh}
          />
        )}
      </RunPanel>
    </OperationsWorkspace>
  );
}
