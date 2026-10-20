import { useState } from "react";
import type { BaiduResearchResult } from "../../../shared/baidu-research";
import { baiduKeywordColumns } from "../../../shared/baidu-keywords";
import { Button, Empty, Field, Notice } from "../../ui/primitives";
import { Pagination } from "../../ui/Pagination";
import { SelectionCheckbox } from "../../ui/SelectionCheckbox";
import { updateSelection } from "../../lib/selection";
import { useAppActions, useAppSelection } from "../../state";
import { baiduMetric } from "./options";
import { formatTime } from "../../lib/format";

const labels: Record<string, string> = {
  ...Object.fromEntries(baiduKeywordColumns),
  rank: "排名",
  wordName: "关键词",
  keywordName: "关键词",
  word: "关键词",
  pay: "消费指数",
  cv: "转化指数",
  pv: "搜索指数",
  businesspointName: "推广业务",
  kwc: "竞争程度",
  matchType: "匹配模式",
  phraseType: "短语模式",
  price: "出价",
  taskId: "任务ID",
  status: "状态",
  submitTime: "创建时间",
  createTime: "创建时间",
  querys: "种子词",
  negativeWords: "排除词根",
  fileName: "关键词文件",
  dimensionName: "分组维度",
  statDate: "日期",
  firstTrend: "行业搜索量",
  trade: "所属行业",
  searchRate: "搜索增长率",
  keyword: "关键词",
  fileSize: "文件大小(KB)",
};
const hidden =
  /^(?:id|wordid|kwc|phraseType|downloadUrl|resultUrl|result|url|bosKey|userId|userid|optid)$/;
export function BaiduResearchResults({
  result,
  onExpand,
  onFlow,
  onOpenKnowledge,
}: {
  result: BaiduResearchResult;
  onExpand(words: string[]): void;
  onFlow(words: string[]): void;
  onOpenKnowledge(): void;
}) {
  const { command, notify } = useAppActions(),
    { resource } = useAppSelection();
  const [filter, setFilter] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string[]>([]),
    [saving, setSaving] = useState(false),
    [name, setName] = useState("");
  const rows = result.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      Object.entries(row).some(
        ([k, v]) =>
          !hidden.test(k) &&
          String(v ?? "")
            .toLowerCase()
            .includes(filter.trim().toLowerCase()),
      ),
    );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / 25))),
    slice = rows.slice((current - 1) * 25, current * 25);
  const columns = [
    ...new Set(result.rows.flatMap((r) => Object.keys(r))),
  ].filter((k) => !hidden.test(k));
  const task = ["massList", "groupList"].includes(result.input.operation);
  const keywordFor = (index: number) => {
    const row = result.rows[index],
      word = row.wordName ?? row.keywordName ?? row.word ?? row.keyword;
    return result.keywords.find((k) => k.word === word);
  };
  const words = result.keywords.filter((k) => selected.includes(k.id));
  const choose = (ids: string[], checked: boolean) =>
    setSelected((p) => updateSelection(p, ids, checked, 1000));
  const dates =
    result.input.operation === "industryTrend"
      ? result.rows.filter((r) => typeof r.firstTrend === "number")
      : [];
  const numbers = dates.map((r) => r.firstTrend as number),
    max = Math.max(...numbers, 1),
    min = Math.min(...numbers, 0);
  const path = numbers
    .map(
      (v, i) =>
        `${i ? "L" : "M"}${24 + (i / (numbers.length - 1 || 1)) * 752},${150 - ((v - min) / (max - min || 1)) * 120}`,
    )
    .join(" ");
  return (
    <div className="baidu-research-results">
      <p className="muted">
        {result.input.operation === "rank"
          ? {
              cost: "高消费词榜",
              conversion: "高转化词榜",
              search: "热搜词榜",
            }[result.input.tab]
          : result.input.operation === "industryWords"
            ? { hotWord: "热搜词", newWord: "新增词", boomingWord: "激增词" }[
                result.input.wordType
              ]
            : result.input.operation === "industryTrend"
              ? "行业搜索趋势"
              : result.input.operation === "flow"
                ? `${result.input.words.length}个关键词 · ${result.input.device === 1 ? "计算机" : result.input.device === 2 ? "移动" : "全部设备"}`
                : "最近读取的百度任务"}
        {result.input.operation.startsWith("industry")
          ? ` · ${result.input.trades.join(" / ")} · ${result.input.startDate} 至 ${result.input.endDate}`
          : ""}
      </p>
      <div className="row spread">
        <div>
          <strong>{result.rows.length.toLocaleString()} 条已返回</strong>
          <small>
            {" "}
            · 百度报告 {result.total.toLocaleString()} 条 ·{" "}
            {formatTime(result.fetchedAt)}
          </small>
        </div>
        <Button
          quiet
          onClick={() =>
            void command(
              "baiduResearch.export",
              { accountId: result.input.accountId, resultId: result.id },
              "结果已导出",
            )
          }
        >
          导出当前结果
        </Button>
      </div>
      {result.warning ? <Notice warning>{result.warning}</Notice> : null}
      {result.knowledge ? (
        <Notice>
          月均搜索量大于10：{result.knowledge.indexed}词已入库或更新；另更新
          {result.knowledge.refreshedBelowThreshold}个已收录的低搜索量词。
          <Button quiet onClick={onOpenKnowledge}>
            查看本地词库
          </Button>
        </Notice>
      ) : null}
      {result.input.operation === "rank" ? (
        <Notice>
          消费、转化、搜索指数均为榜单指标，不等于月均搜索量。可选词继续拓词，获取月均搜索量后按规则入库。
        </Notice>
      ) : null}
      {result.input.operation === "industryWords" ? (
        <Notice>
          行业热词与增长率不等于月均搜索量；选词拓词后可补充月搜索数据。
        </Notice>
      ) : null}
      {dates.length > 1 ? (
        <figure className="baidu-trend">
          <figcaption>
            行业搜索趋势 · {min.toLocaleString()} — {max.toLocaleString()}
          </figcaption>
          <svg role="img" aria-label="行业搜索趋势折线图" viewBox="0 0 800 180">
            <path d={path} fill="none" stroke="var(--blue)" strokeWidth="2.5" />
            <text x="24" y="175">
              {String(dates[0].statDate)}
            </text>
            <text x="650" y="175">
              {String(dates.at(-1)?.statDate)}
            </text>
          </svg>
        </figure>
      ) : null}
      <Field label="筛选已返回内容">
        <input
          aria-label="筛选百度工具结果"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
          placeholder="关键词、业务或任务ID"
        />
      </Field>
      {!rows.length ? (
        <Empty title={result.rows.length ? "没有匹配的结果" : "暂无结果"}>
          {result.rows.length
            ? "调整筛选条件后重试。"
            : "本次百度返回了空列表。"}
        </Empty>
      ) : (
        <>
          <div className="baidu-keyword-table-scroll">
            <table className="baidu-keyword-table">
              <thead>
                <tr>
                  {result.keywords.length ? (
                    <th>
                      <SelectionCheckbox
                        aria-label="选择本页百度工具关键词"
                        selected={
                          slice.filter(({ index }) =>
                            selected.includes(keywordFor(index)?.id ?? ""),
                          ).length
                        }
                        total={
                          slice.filter(({ index }) => !!keywordFor(index))
                            .length
                        }
                        onChange={(e) =>
                          choose(
                            slice.flatMap(({ index }) => {
                              const k = keywordFor(index);
                              return k ? [k.id] : [];
                            }),
                            e.target.checked,
                          )
                        }
                      />
                    </th>
                  ) : null}
                  {columns.map((k) => (
                    <th key={k}>{labels[k] ?? k}</th>
                  ))}
                  {task ? <th>操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {slice.map(({ row, index }) => {
                  const keyword = keywordFor(index);
                  return (
                    <tr key={index}>
                      {result.keywords.length ? (
                        <td>
                          {keyword ? (
                            <input
                              type="checkbox"
                              aria-label={`选择 ${keyword.word}`}
                              checked={selected.includes(keyword.id)}
                              onChange={(e) =>
                                choose([keyword.id], e.target.checked)
                              }
                            />
                          ) : null}
                        </td>
                      ) : null}
                      {columns.map((k) => (
                        <td key={k} data-field={k}>
                          {k === "matchType"
                            ? ((
                                {
                                  "1-1": "精确匹配",
                                  "2-1": "短语匹配",
                                  "3-1": "智能匹配",
                                  "2-3": "智能匹配",
                                } as Record<string, string>
                              )[`${row.matchType}-${row.phraseType}`] ??
                              baiduMetric(row[k], k))
                            : baiduMetric(row[k], k)}
                        </td>
                      ))}
                      {task ? (
                        <td className="baidu-result-actions">
                          <Button
                            quiet
                            disabled={
                              Number(row.status) !== 1 ||
                              saving ||
                              ![
                                row.downloadUrl,
                                row.resultUrl,
                                row.result,
                              ].some(
                                (v) =>
                                  typeof v === "string" &&
                                  v.startsWith("https://"),
                              )
                            }
                            onClick={async () => {
                              setSaving(true);
                              try {
                                await command(
                                  "baiduResearch.download",
                                  {
                                    accountId: result.input.accountId,
                                    resultId: result.id,
                                    row: index,
                                  },
                                  "任务结果已下载",
                                );
                              } finally {
                                setSaving(false);
                              }
                            }}
                          >
                            下载结果
                          </Button>
                          <Button
                            quiet
                            disabled={Number(row.status) !== 1 || saving}
                            onClick={async () => {
                              setSaving(true);
                              try {
                                const stats = await command(
                                  "baiduResearch.collectTask",
                                  {
                                    accountId: result.input.accountId,
                                    resultId: result.id,
                                    row: index,
                                  },
                                );
                                if (stats)
                                  notify(
                                    `已读取${stats.received}词，${stats.indexed}词符合收录规则，另更新${stats.refreshedBelowThreshold}个已有词。`,
                                    "success",
                                  );
                              } finally {
                                setSaving(false);
                              }
                            }}
                          >
                            收录到本地词库
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            label="百度工具结果分页"
            page={current}
            pageSize={25}
            total={rows.length}
            onPageChange={setPage}
          />
        </>
      )}
      {result.keywords.length ? (
        <>
          <div className="row wrap">
            <span>已选 {words.length} / 1000 词</span>
            <Button
              quiet
              disabled={!words.length || words.length > 10}
              onClick={() => onExpand(words.map((k) => k.word))}
            >
              以选中词继续拓词
            </Button>
            <Button
              quiet
              disabled={!words.length}
              onClick={() => onFlow(words.map((k) => k.word))}
            >
              带入流量查询
            </Button>
            <Button
              quiet
              disabled={!selected.length}
              onClick={() => setSelected([])}
            >
              清空选择
            </Button>
          </div>
          <div className="baidu-keyword-save">
            <Field label="保存词池名称">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder="百度流量词池"
              />
            </Field>
            <Button
              disabled={!words.length || saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await command(
                    "pool.save",
                    {
                      name: name.trim() || "百度流量词池",
                      resourceId: resource?.id ?? null,
                      keywords: words,
                    },
                    `已保存${words.length}词到词池`,
                  );
                } finally {
                  setSaving(false);
                }
              }}
            >
              保存选中词到词池
            </Button>
          </div>
          <small>
            跨页保留选择；继续拓词最多10个种子词，流量查询最多1000词。带入后需手动点击查询。
          </small>
        </>
      ) : null}
    </div>
  );
}
