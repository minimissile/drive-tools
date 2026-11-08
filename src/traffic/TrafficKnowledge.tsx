import { useState } from "react";
import {
  ArrowRight,
  BookmarkPlus,
  Copy,
  Download,
  RefreshCw,
} from "lucide-react";
import type { KnowledgeFilter } from "../../shared/traffic-knowledge";
import { useAppActions, useAppActivity } from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { formatTime } from "../lib/format";
import {
  knowledgePlatforms,
  knowledgePlatformName,
  knowledgeSources,
  primaryKeywordMetric,
} from "./knowledge";
import { libraryEntryKey, useTrafficLibrary } from "./useTrafficLibrary";
import { TrafficKnowledgeDetails } from "./TrafficKnowledgeDetails";
import { TrafficQueryArchive } from "./TrafficQueryArchive";

export default function TrafficKnowledge({
  onAppend,
  onOpenPools,
}: {
  onAppend(words: string[]): void;
  onOpenPools(): void;
}) {
  const model = useTrafficLibrary();
  const {
    data: result,
    loading,
    error,
    reload,
    filter,
    updateFilter,
    selected,
    select,
  } = model;
  const { command, notify } = useAppActions();
  const { busy } = useAppActivity();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const items = result?.items ?? [];
  const selectedKeys = new Set(selected.map(libraryEntryKey));
  const allPage =
    items.length > 0 &&
    items.every((item) => selectedKeys.has(libraryEntryKey(item)));
  const words = [
    ...new Map(
      selected.map((item) => [
        item.word.normalize("NFKC").trim().toLowerCase(),
        item.word,
      ]),
    ).values(),
  ];
  const copiedText = words.join("\n");
  const poolAllowed =
    selected.length > 0 && selected.every((item) => item.kind === "word");
  const platforms =
    filter.platform &&
    !knowledgePlatforms.some((item) => item.value === filter.platform)
      ? [
          ...knowledgePlatforms,
          { value: filter.platform, label: filter.platform },
        ]
      : knowledgePlatforms;
  return (
    <div className="traffic-knowledge">
      <Panel
        title="关键词库"
        extra={
          <div className="row compact">
            <small>
              {result ? `${result.total.toLocaleString()}项` : "正在读取…"}
            </small>
            <Button quiet size="compact" disabled={loading} onClick={reload}>
              <RefreshCw size={14} className={loading ? "spin" : undefined} />
              刷新
            </Button>
          </div>
        }
      >
        <form
          className="knowledge-filters"
          onSubmit={(event) => {
            event.preventDefault();
            updateFilter({ search: model.input.trim() });
          }}
        >
          <Field label="搜索关键词">
            <input
              aria-label="搜索词库"
              maxLength={200}
              placeholder="输入想找的词…"
              value={model.input}
              onChange={(event) => model.setInput(event.target.value)}
            />
          </Field>
          <Field label="来源">
            <Select
              aria-label="词库来源"
              value={filter.endpoint}
              items={knowledgeSources}
              onValueChange={(endpoint) =>
                updateFilter({
                  endpoint: endpoint as KnowledgeFilter["endpoint"],
                })
              }
            />
          </Field>
          <Field label="平台">
            <Select
              aria-label="词库平台"
              value={filter.platform}
              items={platforms}
              onValueChange={(platform) => updateFilter({ platform })}
            />
          </Field>
          <Field label="排序">
            <Select
              aria-label="词库排序"
              value={filter.sort}
              items={[
                { value: "recent", label: "最近采集优先" },
                { value: "monthly", label: "月搜索量从高到低" },
                { value: "word", label: "按关键词排序" },
              ]}
              onValueChange={(sort) =>
                updateFilter({ sort: sort as KnowledgeFilter["sort"] })
              }
            />
          </Field>
          <Button primary type="submit" disabled={loading}>
            搜索
          </Button>
        </form>
        <div className="knowledge-filter-options">
          <Select
            aria-label="搜索量依据"
            value={filter.volume}
            items={[
              { value: "", label: "全部搜索量" },
              { value: "measured", label: "有实测月搜索量" },
              { value: "default", label: "默认月搜索量" },
              { value: "unknown", label: "未提供月搜索量" },
            ]}
            onValueChange={(volume) =>
              updateFilter({ volume: volume as KnowledgeFilter["volume"] })
            }
          />
          <Select
            aria-label="词条类型"
            value={filter.kind}
            items={[
              { value: "", label: "全部类型" },
              { value: "word", label: "关键词" },
              { value: "longtail", label: "长尾流量池" },
              { value: "hotspot", label: "热点" },
            ]}
            onValueChange={(kind) =>
              updateFilter({ kind: kind as KnowledgeFilter["kind"] })
            }
          />
          <small>
            {filter.kind === "longtail"
              ? "归集百度批量扩词与5118长尾词；默认搜索量不代表实测。"
              : "同词的不同来源分别保留；默认搜索量不代表实测。"}
          </small>
          {filter.search ||
          filter.endpoint ||
          filter.platform ||
          filter.volume ||
          filter.kind ? (
            <Button
              quiet
              size="compact"
              onClick={() => {
                model.setInput("");
                updateFilter({
                  search: "",
                  endpoint: "",
                  platform: "",
                  volume: "",
                  kind: "",
                });
              }}
            >
              清除筛选
            </Button>
          ) : null}
        </div>
        {model.draftError ? <Notice warning>{model.draftError}</Notice> : null}
        <QueryError
          title="所选词条暂未核对"
          error={model.selectionError}
          loading={model.selectionLoading}
          onRetry={model.retrySelection}
        />
        {model.missingSelectionCount ? (
          <Notice warning>
            {model.missingSelectionCount}
            项所选词的采集记录已不可用，文本与原指标快照仍保留，可复制或保存。
          </Notice>
        ) : null}
        <div className="knowledge-selection" aria-label="词库批量操作">
          <div className="knowledge-selection-summary">
            <strong>
              {selected.length
                ? `已选 ${selected.length} 项`
                : "勾选词条后批量复用"}
            </strong>
            {selected.length ? (
              <>
                <small>跨页保留 · {words.length}个词</small>
                <Button quiet size="compact" onClick={model.clear}>
                  清空选择
                </Button>
              </>
            ) : (
              <small>支持跨页选择，最多1000项</small>
            )}
          </div>
          <div className="row compact">
            <Button
              size="compact"
              disabled={!words.length || copiedText.length > 100000 || busy > 0}
              title="最多复制10万字；超出时请分批选择"
              onClick={async () => {
                const copied = await command("system.copyText", {
                  text: copiedText,
                });
                if (copied)
                  notify(`已复制${words.length}个去重词。`, "success");
              }}
            >
              <Copy size={14} />
              复制词
            </Button>
            <Button
              size="compact"
              disabled={
                !words.length ||
                words.length > 50 ||
                words.some((word) => word.length > 100)
              }
              title="最多50个词，每词最多100字；只带入查询框，不自动请求接口"
              onClick={() => onAppend(words)}
            >
              <ArrowRight size={14} />
              带入找词
            </Button>
          </div>
          {selected.length ? (
            <div className="knowledge-pool-actions">
              <input
                aria-label="词库新词池名称"
                placeholder="词池名称（可选）"
                maxLength={100}
                value={model.poolName}
                onChange={(event) => model.setPoolName(event.target.value)}
              />
              <Button
                primary
                size="compact"
                disabled={!poolAllowed || busy > 0}
                onClick={async () => {
                  if (await model.savePool()) setSaved(true);
                }}
              >
                <BookmarkPlus size={14} />
                保存为词池
              </Button>
              {!poolAllowed ? (
                <small>热点可复制或带入找词；词池仅收录关键词。</small>
              ) : null}
              {words.length > 50 ? (
                <small>
                  当前超过50词，带入找词请分批；仍可复制或保存词池。
                </small>
              ) : null}
            </div>
          ) : null}
          {saved ? (
            <Button quiet size="compact" onClick={onOpenPools}>
              查看已保存词池 <ArrowRight size={14} />
            </Button>
          ) : null}
        </div>
        <QueryError
          title="词库暂未读取成功"
          error={error}
          loading={loading}
          onRetry={reload}
        />
        {loading && !result ? (
          <LoadingState label="正在读取词库…" />
        ) : result && items.length ? (
          <div className="table-scroll">
            <table
              className="knowledge-entries"
              aria-label="词库列表"
              aria-busy={loading}
            >
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="全选本页词条"
                      checked={allPage}
                      disabled={loading}
                      ref={(node) => {
                        if (node)
                          node.indeterminate =
                            !allPage &&
                            items.some((item) =>
                              selectedKeys.has(libraryEntryKey(item)),
                            );
                      }}
                      onChange={(event) => select(items, event.target.checked)}
                    />
                  </th>
                  <th>关键词</th>
                  <th>来源 / 平台</th>
                  <th>核心指标</th>
                  <th>最近采集</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const key = libraryEntryKey(item),
                    metric = primaryKeywordMetric(item.metrics);
                  return (
                    <tr
                      key={key}
                      data-selected={selectedKeys.has(key) || undefined}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择词条 ${item.word}`}
                          checked={selectedKeys.has(key)}
                          disabled={loading}
                          onChange={(event) =>
                            select([item], event.target.checked)
                          }
                        />
                      </td>
                      <td>
                        <strong>{item.word}</strong>
                        {item.kind === "hotspot" ? <small>热点</small> : null}
                      </td>
                      <td>
                        {item.source}
                        <small>{knowledgePlatformName(item.platform)}</small>
                      </td>
                      <td>
                        <span>{metric.value}</span>
                        <small>
                          {metric.label}
                          {metric.note ? ` · ${metric.note}` : ""}
                        </small>
                      </td>
                      <td>
                        {item.observedAt
                          ? formatTime(item.observedAt)
                          : "时间未记录"}
                        <small>{item.observations}次采集</small>
                      </td>
                      <td>
                        <Button
                          quiet
                          size="compact"
                          disabled={loading}
                          aria-label={`查看词条 ${item.word}`}
                          onClick={() => model.setDetail(item)}
                        >
                          详情
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : !error && !loading ? (
          <Empty
            title={
              filter.search ||
              filter.endpoint ||
              filter.platform ||
              filter.volume ||
              filter.kind
                ? "没有符合筛选的词条"
                : "还没有收录词条"
            }
          >
            {filter.search ||
            filter.endpoint ||
            filter.platform ||
            filter.volume ||
            filter.kind
              ? "调整搜索或筛选条件，已收录的词仍保留在词库中。"
              : "通过百度扩词或找词工具采集，结果会自动积累到这里。"}
          </Empty>
        ) : null}
        {result ? (
          <Pagination
            label="词库分页"
            page={filter.page}
            pageSize={result.pageSize}
            total={result.total}
            disabled={loading}
            onPageChange={model.changePage}
          />
        ) : null}
      </Panel>
      <details
        className="knowledge-archive"
        onToggle={(event) => setArchiveOpen(event.currentTarget.open)}
      >
        <summary>查询档案与入库说明</summary>
        {archiveOpen ? (
          <>
            <p>
              百度新词月搜索量至少10时收录；批量扩词默认10，非实测。同来源保留每次观察，已收录词后续低于10仍更新。词池是你整理的选词快照，不会随新采集改变。
            </p>
            <div className="knowledge-toolbar">
              <small>
                档案与导出沿用当前筛选，包含历史观察，数量可能多于最新词条。
              </small>
              <Button
                disabled={busy > 0}
                onClick={async () => {
                  const path = await command(
                    "traffic.knowledge.export",
                    filter,
                  );
                  if (path) notify(`历史观察已导出：${path}`, "success");
                }}
              >
                <Download size={14} />
                导出历史 CSV
              </Button>
            </div>
            <TrafficQueryArchive filter={filter} />
          </>
        ) : null}
      </details>
      {model.detail ? (
        <TrafficKnowledgeDetails
          item={model.detail}
          onClose={() => model.setDetail(null)}
        />
      ) : null}
    </div>
  );
}
