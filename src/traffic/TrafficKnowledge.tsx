import { Select } from "../ui/Select";
import { updateSelection } from "../lib/selection";
import { keywordMetrics } from "./knowledge";
import { useIpcQuery } from "../api/useIpcQuery";
import { QueryError } from "../ui/QueryError";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { useEffect, useState } from "react";
import { Archive, ArrowRight, Download, RefreshCw, Search } from "lucide-react";
import {
  Button,
  Empty,
  Field,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { formatTime } from "../lib/format";
import { useAppActions, useAppActivity } from "../state";
import { endpointSpecs } from "../../shared/platforms";
import type { Endpoint } from "../../shared/types";
import { baiduKeywordColumns } from "../../shared/baidu-keywords";
import type {
  KnowledgeDetail,
  KnowledgeFilter,
} from "../../shared/traffic-knowledge";
const phaseName: Record<string, string> = {
  query: "查询",
  submit: "提交分析",
  poll: "获取分析结果",
  legacy: "历史恢复",
};
const metricName: Record<string, string> = {
  ...Object.fromEntries(baiduKeywordColumns),
  index: "百度PC指数",
  mobile_index: "百度移动指数",
  douyin_index: "抖音指数",
  toutiao_index: "头条指数",
  kuaishou_index: "快手指数",
  weibo_index: "微博指数",
  haosou_index: "360指数",
  bidword_pcpv: "百度PC搜索量",
  bidword_wisepv: "百度移动搜索量",
  long_keyword_count: "长尾词数",
  sem_price: "竞价参考",
  event_hot_exp: "事件热度",
  baidu_pc_exp: "百度PC热度",
  baidu_move_exp: "百度移动热度",
};
const statusName: Record<string, string> = {
  requested: "请求中 / 尚未确认",
  received: "响应已归档",
  pending: "分析中",
  success: "成功",
  uncertain: "结果或费用待核",
  recovered: "旧记录恢复",
};
export default function TrafficKnowledge({
  onAppend,
}: {
  onAppend(words: string[]): void;
}) {
  const { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const [input, setInput] = useState(""),
    [filter, setFilter] = useState<KnowledgeFilter>({
      search: "",
      endpoint: "",
      platform: "",
      page: 1,
      view: "items",
    }),
    [detail, setDetail] = useState<KnowledgeDetail | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [poolName, setPoolName] = useState("");
  const {
    data: result,
    loading,
    error,
    reload,
  } = useIpcQuery("traffic.knowledge.list", filter, { keepPrevious: true });
  useEffect(() => {
    setSelected([]);
    setDetail(null);
  }, [filter]);
  const inspect = async (id: string) => {
    const r = await command("traffic.knowledge.detail", {
      id,
    });
    if (r) setDetail(r);
  };
  const chosen = result?.items.filter((i) => selected.includes(i.id)) ?? [];
  const update = (patch: Partial<KnowledgeFilter>) =>
    setFilter((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  return (
    <Tabs
      className="traffic-knowledge"
      value={filter.view}
      onChange={(view) => update({ view })}
    >
      <Notice>
        百度关键词中月均搜索量大于10的新词自动收录；同来源、同词展示最新指标并保留历史，已收录词降至10及以下仍更新数据。5118响应继续长期归档。刷新本地不会请求外部接口。
      </Notice>
      {result ? (
        <div className="stat-strip usage-strip">
          <div>
            归档查询<strong>{result.summary.queries}</strong>
            <small>
              其中 {result.summary.responses} 条有响应，{result.summary.legacy}{" "}
              条为旧记录恢复
            </small>
          </div>
          <div>
            累计独立词语<strong>{result.summary.words}</strong>
            <small>另有 {result.summary.hotspots} 个独立热点</small>
          </div>
          <div>
            历史观察记录<strong>{result.summary.observations}</strong>
            <small>同一词不同时点的指标分别保留</small>
          </div>
        </div>
      ) : null}
      <Panel
        title="本地流量知识库"
        extra={
          <Button
            onClick={() => {
              setSelected([]);
              setDetail(null);
              reload();
            }}
            disabled={loading}
          >
            {loading ? (
              <Loading label="正在刷新…" />
            ) : (
              <>
                <RefreshCw size={15} />
                刷新本地
              </>
            )}
          </Button>
        }
      >
        <form
          className="knowledge-filters"
          onSubmit={(e) => {
            e.preventDefault();
            update({ search: input });
          }}
        >
          <Field label="搜索归档词语或种子词">
            <input
              aria-label="搜索本地知识库"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如：Obsidian、怎么使用"
            />
          </Field>
          <Field label="接口来源">
            <Select
              aria-label="知识库接口来源"
              value={filter.endpoint}
              onValueChange={(nextValue) =>
                update({
                  endpoint: nextValue as KnowledgeFilter["endpoint"],
                })
              }
              items={[
                { value: "", label: "全部接口" },
                ...Object.entries(endpointSpecs).map(([key, s]) => ({
                  value: key,
                  label: s.name,
                })),
                { value: "baidu-keywords", label: "百度营销 · 关键词规划师" },
              ]}
            />
          </Field>
          <Field label="平台代码（可选）">
            <input
              value={filter.platform}
              aria-label="知识库平台"
              placeholder="例如 baidu / douyin"
              onChange={(e) => update({ platform: e.target.value })}
            />
          </Field>
          <Button type="submit" primary disabled={loading}>
            <Search size={15} />
            搜索本地
          </Button>
        </form>
        <div className="knowledge-toolbar">
          <TabList
            label="知识库视图"
            items={[
              ["items", "词语与热点"],
              ["queries", "查询档案"],
            ]}
          />
          <Button
            disabled={busy > 0}
            onClick={async () => {
              const p = await command("traffic.knowledge.export", filter);
              if (p) notify(`知识库已导出：${p}`, "success");
            }}
          >
            <Download size={15} />
            导出筛选后的全部观察 CSV
          </Button>
        </div>
        <small>
          同来源、同词及平台合并为一条最新记录；首次收录与最近采集分别展示，导出保留历史观察。更新随下一次手动检索成功后入库，不自动消耗接口配额。
        </small>
        <TabPanel value={filter.view}>
          <QueryError
            error={error}
            loading={loading}
            onRetry={reload}
            title="本地知识库暂未读取成功"
          />
          {loading && !result?.total ? (
            <LoadingState label="正在读取本地知识库…" />
          ) : result && result.total ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {(filter.view === "items"
                      ? [
                          "选择",
                          "词语 / 热点",
                          "来源 / 平台",
                          "首次收录 / 最近采集",
                          "历史观察",
                          "指标 / 来源档案",
                        ]
                      : [
                          "时间",
                          "接口 / 阶段",
                          "种子词 / 平台",
                          "状态",
                          "词条数",
                          "档案",
                        ]
                    ).map((t) => (
                      <th key={t}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filter.view === "items"
                    ? result.items.map((i) => (
                        <tr key={i.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`选择知识库词 ${i.word}`}
                              checked={selected.includes(i.id)}
                              onChange={(e) =>
                                setSelected((prev) =>
                                  updateSelection(
                                    prev,
                                    [i.id],
                                    e.target.checked,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td>
                            <strong>{i.word}</strong>
                            <br />
                            <small>
                              {i.kind === "hotspot" ? "热点线索" : "关键词"}
                            </small>
                          </td>
                          <td>
                            {i.source}
                            <br />
                            <small>{i.platform ?? "未限定平台"}</small>
                          </td>
                          <td>
                            <small>
                              首次：
                              {i.firstObservedAt
                                ? formatTime(i.firstObservedAt)
                                : "未知"}
                            </small>
                            <br />
                            最近：
                            {i.observedAt
                              ? formatTime(i.observedAt)
                              : "采集时间未知"}
                            <br />
                            <small>
                              源更新：{i.sourceUpdatedAt ?? "未提供"}
                            </small>
                          </td>
                          <td>
                            {i.observations}
                            <br />
                            <Button
                              onClick={() => {
                                setInput(i.word);
                                update({ search: i.word, view: "queries" });
                              }}
                            >
                              查看历史
                            </Button>
                          </td>
                          <td>
                            <div className="knowledge-metrics">
                              {Object.entries(i.metrics)
                                .slice(0, 5)
                                .map(([k, v]) => (
                                  <small key={k}>
                                    {metricName[k] ?? k}：{String(v)}
                                  </small>
                                ))}
                              {!Object.keys(i.metrics).length ? (
                                <small>未提供指标</small>
                              ) : null}
                            </div>
                            <Button onClick={() => void inspect(i.queryId)}>
                              <Archive size={14} />
                              查看来源档案
                            </Button>
                          </td>
                        </tr>
                      ))
                    : result.queries.map((q) => (
                        <tr key={q.id}>
                          <td>
                            {q.receivedAt
                              ? formatTime(q.receivedAt)
                              : q.startedAt
                                ? formatTime(q.startedAt)
                                : "时间未知"}
                          </td>
                          <td>
                            {(q.endpoint === "baidu-keywords"
                              ? "百度营销 · 关键词规划师"
                              : endpointSpecs[q.endpoint as Endpoint]?.name) ??
                              q.endpoint}
                            <br />
                            <small>{phaseName[q.phase] ?? q.phase}</small>
                          </td>
                          <td>
                            {q.seeds.join("、") || "未记录 / 未限定"}
                            <br />
                            <small>{q.platform}</small>
                          </td>
                          <td>
                            {statusName[q.status] ?? q.status}
                            {q.legacy ? <small>历史恢复</small> : null}
                          </td>
                          <td>{q.count}</td>
                          <td>
                            <Button onClick={() => void inspect(q.id)}>
                              {q.endpoint === "baidu-keywords"
                                ? "查看收录档案"
                                : "查看完整响应"}
                            </Button>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          ) : error ? null : (
            <Empty title="暂无匹配的知识库资料">
              新查询会自动归档，已有本地缓存和分析结果会在升级时恢复。
            </Empty>
          )}
          <div className="knowledge-toolbar">
            <small>
              {loading
                ? "本地历史记录"
                : result
                  ? `共 ${result.total} 项 · 第 ${filter.page} 页`
                  : "分页信息暂不可用"}
            </small>
            <div className="inline-actions">
              <Button
                disabled={loading || filter.page === 1}
                onClick={() => update({ page: filter.page - 1 })}
              >
                上一页
              </Button>
              <Button
                disabled={
                  loading ||
                  !result ||
                  filter.page * result.pageSize >= result.total
                }
                onClick={() => update({ page: filter.page + 1 })}
              >
                下一页
              </Button>
            </div>
          </div>
          {chosen.length ? (
            <div className="knowledge-selection">
              <strong>已选 {chosen.length} 项</strong>
              <Button onClick={() => onAppend(chosen.map((i) => i.word))}>
                <ArrowRight size={15} />
                带入找词 / AI联想
              </Button>
              <input
                aria-label="知识库新词池名称"
                placeholder="流量池名称"
                value={poolName}
                onChange={(e) => setPoolName(e.target.value)}
              />
              <Button
                disabled={busy > 0 || chosen.some((i) => i.kind !== "word")}
                onClick={async () => {
                  const r = await command(
                    "pool.save",
                    {
                      name: poolName.trim() || "历史发现词池",
                      resourceId: null,
                      keywords: chosen.map((i) => ({
                        id: i.id,
                        word: i.word,
                        platform: i.platform,
                        source: i.source,
                        metrics: keywordMetrics(i.metrics),
                        sourceUpdatedAt: i.sourceUpdatedAt,
                        fetchedAt: i.observedAt ?? "",
                      })),
                    },
                    "已从知识库建立词池",
                  );
                  if (r) {
                    setSelected([]);
                    setPoolName("");
                  }
                }}
              >
                保存为流量池
              </Button>
            </div>
          ) : null}
        </TabPanel>
      </Panel>
      {detail ? (
        <Panel
          title="查询来源档案"
          extra={<Button onClick={() => setDetail(null)}>关闭档案</Button>}
        >
          <p>
            {(detail.query.endpoint === "baidu-keywords"
              ? "百度营销 · 关键词规划师"
              : endpointSpecs[detail.query.endpoint as Endpoint]?.name) ??
              "历史接口未知"}{" "}
            · {statusName[detail.query.status] ?? detail.query.status} ·{" "}
            {detail.query.count} 条观察
          </p>
          <small>
            {detail.query.message}{" "}
            {detail.query.endpoint === "baidu-keywords"
              ? "以下为本次符合收录规则的词条及更新数据，不包含登录凭据。"
              : detail.query.legacy
                ? "以下为当时仍保留的历史内容，可能不是完整原始响应。"
                : "凭据字段已隐藏；接口新增字段仍保留在完整响应中。"}
          </small>
          <Field label="查询参数与种子词">
            <pre className="knowledge-json">
              {JSON.stringify(
                {
                  parameters: detail.query.request,
                  seeds: detail.query.seeds,
                  httpStatus: detail.query.httpStatus,
                  receivedAt: detail.query.receivedAt,
                },
                null,
                2,
              )}
            </pre>
          </Field>
          <Field label="完整归档响应">
            <textarea
              aria-label="完整归档响应"
              className="knowledge-response"
              readOnly
              value={
                detail.response ??
                "本次未取得完整响应。请核对网络或远端任务；应用不会自动重试。"
              }
            />
          </Field>
          <Button
            onClick={async () => {
              const p = await command("traffic.knowledge.exportQuery", {
                id: detail.query.id,
              });
              if (p) notify(`查询档案已导出：${p}`, "success");
            }}
          >
            <Download size={15} />
            导出此查询 JSON
          </Button>
        </Panel>
      ) : null}
      {result ? (
        <Panel title="本地样本规律">
          <Notice>
            这是你在本工具中查询和积累的样本，不是平台真实用户搜索日志。下列意图按字面规则粗分，可重叠，不能据此推断全网需求或因果趋势。
          </Notice>
          <div className="knowledge-patterns">
            {result.patterns.map((p) => (
              <div key={p.name}>
                <small>{p.name}</small>
                <strong>{p.count}</strong>
                <span>个独立词语含相关表达</span>
              </div>
            ))}
          </div>
          <h4>常用查询主题</h4>
          {result.seeds.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>种子词</th>
                    <th>有响应的查询 / 提交次数</th>
                    <th>关联观察数</th>
                  </tr>
                </thead>
                <tbody>
                  {result.seeds.map((s) => (
                    <tr key={s.word}>
                      <td>{s.word}</td>
                      <td>{s.queries}</td>
                      <td>{s.results}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <small>还没有可统计的新查询主题。旧恢复记录不纳入查询频次。</small>
          )}
          <small>
            多种子搜索量任务的每个种子关联整批结果；观察数用于追溯资料，不代表该词的搜索次数。
          </small>
        </Panel>
      ) : null}
    </Tabs>
  );
}
