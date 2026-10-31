import { useEffect, useMemo, useState } from "react";
import { Download, GitBranch, Maximize2, Table2 } from "lucide-react";
import { z } from "zod";
import {
  discoveryWordKey,
  type DiscoveryRun,
} from "../../shared/baidu-discovery";
import type { QuestionDraftInsertResult } from "../../shared/zhidao-publishing";
import { useAppNavigation } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { updateSelection } from "../lib/selection";
import {
  Button,
  Empty,
  LoadingState,
  Notice,
  Panel,
  SearchField,
} from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { Pagination } from "../ui/Pagination";
import { Select } from "../ui/Select";
import { usePublishingView } from "../zhidao/usePublishingView";
import { DiscoveryWordTable } from "./DiscoveryWordTable";
import { DiscoveryInsertDialog } from "./DiscoveryInsertDialog";
import type { DiscoveryModel } from "./useBaiduDiscovery";

const viewSchema = z.object({
  search: z.string(),
  source: z.string(),
  page: z.number().int().positive(),
  selected: z.array(z.string()).max(10000),
  format: z.enum(["csv", "txt"]).default("csv"),
});
export function DiscoveryResults({
  workspace,
  run,
  model,
}: {
  workspace: string;
  run: DiscoveryRun;
  model: DiscoveryModel;
}) {
  const draft = useLocalDraft(
    `panxu-baidu-discovery-results:${workspace}:${run.id}`,
    {
      search: "",
      source: "all",
      page: 1,
      selected: [] as string[],
      format: "csv" as "csv" | "txt",
    },
    (value) => viewSchema.parse(value),
  );
  const { value, update } = draft;
  const [fullscreen, setFullscreen] = useState(false);
  const [inserting, setInserting] = useState<string[] | null>(null);
  const [inserted, setInserted] = useState<QuestionDraftInsertResult | null>(
    null,
  );
  const publishing = usePublishingView();
  const { navigate } = useAppNavigation();
  const selected = useMemo(() => new Set(value.selected), [value.selected]);
  const queried = useMemo(
    () => new Set(run.queries.map((query) => discoveryWordKey(query.word))),
    [run.queries],
  );
  const words = useMemo(
    () =>
      run.words.filter(
        (word) =>
          (!value.search ||
            word.word
              .toLocaleLowerCase()
              .includes(value.search.trim().toLocaleLowerCase())) &&
          (value.source === "all" ||
            word.origins.some((origin) => origin.source === value.source)),
      ),
    [run.words, value.search, value.source],
  );
  const page = Math.min(value.page, Math.max(1, Math.ceil(words.length / 30)));
  const rows = words.slice((page - 1) * 30, page * 30);
  const selectedWords = run.words.filter((word) => selected.has(word.key));
  const expandable = selectedWords.filter(
    (word) => !queried.has(word.key) && word.origins[0]?.depth < 3,
  );
  useEffect(() => {
    const keys = new Set(run.words.map((word) => word.key));
    const retained = value.selected.filter((key) => keys.has(key));
    if (retained.length !== value.selected.length || value.page !== page)
      update({ selected: retained, page });
  }, [run.words, value.selected, value.page, page, update]);
  const goToQuestions = () => {
    publishing.update({ tab: "upload" });
    setFullscreen(false);
    navigate("zhidao-publish");
  };
  const content = (
    <>
      <div className="baidu-discovery-result-controls">
        <div className="baidu-discovery-toolbar">
          <SearchField
            value={value.search}
            onChange={(search) => update({ search, page: 1 })}
            label="筛选采集关键词"
            placeholder="筛选关键词…"
          />
          <Select
            aria-label="筛选采集来源"
            value={value.source}
            items={[
              { value: "all", label: "全部来源" },
              { value: "suggest", label: "下拉联想词" },
              { value: "related", label: "相关搜索" },
            ]}
            onValueChange={(source) => update({ source, page: 1 })}
          />
        </div>
        <div className="baidu-discovery-selection">
          <div className="baidu-discovery-selection-count">
            <span>已选 {selectedWords.length} 个</span>
            {selectedWords.length ? (
              <Button
                quiet
                size="compact"
                onClick={() => update({ selected: [] })}
              >
                清空
              </Button>
            ) : null}
          </div>
          <div className="baidu-discovery-result-actions">
            {selectedWords.length ? (
              <Button
                disabled={
                  !!model.pending ||
                  model.running ||
                  run.status !== "completed" ||
                  !expandable.length
                }
                onClick={() =>
                  void model.expand(expandable.map((word) => word.word))
                }
              >
                <GitBranch size={14} />
                继续扩词
              </Button>
            ) : null}
            <Select
              aria-label="关键词导出格式"
              value={value.format}
              items={[
                { value: "csv", label: "CSV 表格" },
                { value: "txt", label: "TXT 文本" },
              ]}
              onValueChange={(format) =>
                update({ format: format as "csv" | "txt" })
              }
            />
            <Button
              disabled={!!model.pending || !run.words.length}
              onClick={() =>
                void model.export(
                  value.format,
                  selectedWords.length
                    ? selectedWords.map((word) => word.word)
                    : undefined,
                )
              }
            >
              <Download size={14} />
              {selectedWords.length ? "导出所选" : "导出全部"}
            </Button>
            <Button
              primary
              disabled={!!model.pending || model.running || !run.words.length}
              onClick={() =>
                setInserting(
                  (selectedWords.length ? selectedWords : run.words).map(
                    (word) => word.key,
                  ),
                )
              }
            >
              <Table2 size={14} />
              {selectedWords.length ? "配资料并插入所选" : "配资料并插入全部"}
            </Button>
          </div>
        </div>
      </div>
      {inserted ? (
        <div className="baidu-discovery-insert-result" role="status">
          <span>
            已插入 {inserted.added} 条问答
            {inserted.duplicates
              ? `，跳过 ${inserted.duplicates} 条重复问题`
              : ""}
            。
            {inserted.titleIssues
              ? `${inserted.titleIssues} 条标题需在审核前修改。`
              : "请核对问题与回答是否匹配，再审核上传。"}
          </span>
          <Button quiet size="compact" onClick={goToQuestions}>
            前往审核上传
          </Button>
        </div>
      ) : null}
      {model.resultError ? <Notice danger>{model.resultError}</Notice> : null}
      {!run.words.length && run.status === "running" ? (
        <LoadingState label="等待首批采集结果…" compact />
      ) : !run.words.length ? (
        <Empty
          title={
            run.removedKeys.length ? "本轮关键词已清理完" : "本轮尚无采集结果"
          }
          compact
        >
          {run.removedKeys.length
            ? "可切换历史任务，或新建采集。删除的词不会在本轮再次出现。"
            : run.status === "completed"
              ? "百度本次未返回推荐词，可以换一组初始词重新采集。"
              : "已保留断点，请完成验证或处理读取问题后继续。"}
        </Empty>
      ) : !words.length ? (
        <Empty
          title="没有符合筛选条件的词"
          compact
          action={
            <Button
              quiet
              onClick={() => update({ search: "", source: "all", page: 1 })}
            >
              清除筛选
            </Button>
          }
        />
      ) : (
        <>
          <DiscoveryWordTable
            words={rows}
            selected={selected}
            queried={queried}
            disabled={!!model.pending}
            onSelect={(key, checked) =>
              update({
                selected: updateSelection(value.selected, [key], checked),
              })
            }
            onSelectPage={(checked) =>
              update({
                selected: updateSelection(
                  value.selected,
                  rows.map((word) => word.key),
                  checked,
                ),
              })
            }
            onRemove={model.removeWord}
          />
          <Pagination
            label="采词结果分页"
            page={page}
            pageSize={30}
            total={words.length}
            onPageChange={(page) => update({ page })}
          />
        </>
      )}
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
      {inserting ? (
        <DiscoveryInsertDialog
          key={run.id}
          workspace={workspace}
          run={run}
          keys={inserting}
          onClose={() => setInserting(null)}
          onInserted={(result) => {
            setInserted(result);
            setInserting(null);
          }}
        />
      ) : null}
    </>
  );
  return (
    <>
      {fullscreen ? (
        <Dialog
          title={`去重关键词 · ${run.words.length} 个词`}
          size="fullscreen"
          focus="container"
          className="baidu-discovery-fullscreen"
          onClose={() => setFullscreen(false)}
        >
          {content}
        </Dialog>
      ) : (
        <Panel
          title="去重关键词"
          className="baidu-discovery-results"
          extra={
            <div className="baidu-discovery-panel-actions">
              <small>{run.words.length.toLocaleString()} 个词 · 已去重</small>
              <Button quiet size="compact" onClick={() => setFullscreen(true)}>
                <Maximize2 size={14} />
                列表全屏
              </Button>
            </div>
          }
        >
          {content}
        </Panel>
      )}
    </>
  );
}
