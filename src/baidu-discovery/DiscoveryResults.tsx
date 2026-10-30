import { useMemo } from "react";
import { Download, GitBranch } from "lucide-react";
import { z } from "zod";
import {
  discoverySourceLabels,
  discoveryWordKey,
  type DiscoveryRun,
} from "../../shared/baidu-discovery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { updateSelection } from "../lib/selection";
import {
  Button,
  Empty,
  LoadingState,
  Panel,
  SearchField,
} from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { Select } from "../ui/Select";
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
  const format = value.format;
  const selected = useMemo(() => new Set(value.selected), [value.selected]);
  const queried = useMemo(
    () => new Set(run.queries.map((q) => discoveryWordKey(q.word))),
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
            word.origins.some((o) => o.source === value.source)),
      ),
    [run.words, value.search, value.source],
  );
  const page = Math.min(value.page, Math.max(1, Math.ceil(words.length / 30)));
  const rows = words.slice((page - 1) * 30, page * 30),
    all = rows.length > 0 && rows.every((word) => selected.has(word.key));
  const selectedWords = run.words.filter((word) => selected.has(word.key));
  const expandable = selectedWords.filter(
    (word) => !queried.has(word.key) && word.origins[0]?.depth < 3,
  );
  return (
    <Panel
      title="去重关键词"
      extra={
        <small>
          {run.words.length.toLocaleString()} 个词 · 同词保留全部采集来源
        </small>
      }
    >
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
        <Select
          aria-label="关键词导出格式"
          value={format}
          items={[
            { value: "csv", label: "CSV（含来源）" },
            { value: "txt", label: "TXT（仅词）" },
          ]}
          onValueChange={(next) => update({ format: next as "csv" | "txt" })}
        />
        <Button
          disabled={!!model.pending || !run.words.length}
          onClick={() => void model.export(format)}
        >
          <Download size={15} />
          导出全部
        </Button>
      </div>
      <div className="baidu-discovery-selection">
        <span>
          已选 {selectedWords.length} 个
          {expandable.length ? ` · 可扩词 ${expandable.length} 个` : ""}
        </span>
        <Button
          quiet
          size="compact"
          disabled={!value.selected.length}
          onClick={() => update({ selected: [] })}
        >
          清空选择
        </Button>
        <Button
          size="compact"
          disabled={
            !!model.pending ||
            model.running ||
            run.status !== "completed" ||
            !expandable.length
          }
          onClick={() => void model.expand(expandable.map((word) => word.word))}
        >
          <GitBranch size={14} />
          所选词继续扩词
        </Button>
        <Button
          size="compact"
          disabled={!!model.pending || !selectedWords.length}
          onClick={() =>
            void model.export(
              format,
              selectedWords.map((word) => word.word),
            )
          }
        >
          导出所选
        </Button>
      </div>
      {!run.words.length && run.status === "running" ? (
        <LoadingState label="等待首批采集结果…" compact />
      ) : !run.words.length ? (
        <Empty title="尚无采集结果" compact>
          完成验证后继续采集，成功取得的词会自动保存。
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
          <div className="baidu-discovery-table-scroll">
            <table className="baidu-discovery-table">
              <thead>
                <tr>
                  <th>
                    <input
                      aria-label="选择本页关键词"
                      type="checkbox"
                      checked={all}
                      onChange={(e) =>
                        update({
                          selected: updateSelection(
                            value.selected,
                            rows.map((word) => word.key),
                            e.target.checked,
                          ),
                        })
                      }
                    />
                  </th>
                  <th>关键词</th>
                  <th>采集来源</th>
                  <th>来源查询词 / 初始词</th>
                  <th>层级 / 状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((word) => (
                  <tr key={word.key}>
                    <td>
                      <input
                        aria-label={`选择关键词 ${word.word}`}
                        type="checkbox"
                        checked={selected.has(word.key)}
                        onChange={(e) =>
                          update({
                            selected: updateSelection(
                              value.selected,
                              [word.key],
                              e.target.checked,
                            ),
                          })
                        }
                      />
                    </td>
                    <td>
                      <strong>{word.word}</strong>
                    </td>
                    <td>
                      {[...new Set(word.origins.map((o) => o.source))].map(
                        (source) => (
                          <span className="baidu-discovery-source" key={source}>
                            {discoverySourceLabels[source]}
                          </span>
                        ),
                      )}
                    </td>
                    <td
                      title={word.origins
                        .map((o) => `${o.query}（初始词：${o.seed}）`)
                        .join("\n")}
                    >
                      <div className="baidu-discovery-origin">
                        {[...new Set(word.origins.map((o) => o.query))].join(
                          "、",
                        )}
                      </div>
                      <small>
                        初始词：
                        {[...new Set(word.origins.map((o) => o.seed))].join(
                          "、",
                        )}
                      </small>
                    </td>
                    <td>
                      第 {Math.min(...word.origins.map((o) => o.depth))} 层
                      <small>
                        {queried.has(word.key) ? "已纳入查询" : "尚未查询"}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            label="采词结果分页"
            page={page}
            pageSize={30}
            total={words.length}
            onPageChange={(page) => update({ page })}
          />
        </>
      )}
      {draft.error ? <p role="alert">{draft.error}</p> : null}
    </Panel>
  );
}
