import { useState } from "react";
import {
  ArrowRight,
  BookmarkPlus,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { useApp } from "../state";
import {
  Button,
  Empty,
  Field,
  Header,
  Loading,
  Notice,
  Panel,
  ResourcePicker,
  formatMoney,
  formatTime,
} from "../components";
import { endpointSpecs } from "../../shared/platforms";
import type {
  Endpoint,
  Keyword,
  Pool,
  TrafficResult,
} from "../../shared/types";
const sourcePlatform = (id: string) =>
  ({
    xiaohongshu: "小红书",
    douyin: "抖音",
    zhihu: "知乎",
    baidu: "百度PC",
    baidumobile: "百度移动",
    toutiao: "头条",
  })[id] ?? id;
export default function Traffic() {
  const { data, resource, command, navigate, busy, notify, select } = useApp();
  const [manualName, setManualName] = useState(""),
    [manualWords, setManualWords] = useState(""),
    [manualBound, setManualBound] = useState(true);
  const [tab, setTab] = useState<"words" | "hotspots" | "costs">("words"),
    [method, setMethod] = useState<Endpoint>("longtail"),
    [seeds, setSeeds] = useState(""),
    [pages, setPages] = useState(1),
    [platform, setPlatform] = useState("xiaohongshu"),
    [useCache, setUseCache] = useState(true),
    [result, setResult] = useState<TrafficResult | null>(null),
    [queryFeedback, setQueryFeedback] = useState<string | null>(null),
    [allowSuggestionRequest, setAllowSuggestionRequest] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [poolName, setPoolName] = useState(""),
    [hotType, setHotType] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const query = async (endpoint: Endpoint, taskId?: string) => {
    setQueryFeedback(null);
    setResult(null);
    const words = seeds
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await command<TrafficResult>("traffic.query", {
      endpoint,
      seeds: words,
      pages,
      platform,
      useCache,
      type: hotType,
      startTime: start.replace("T", " ") + (start ? ":00" : ""),
      endTime: end.replace("T", " ") + (end ? ":00" : ""),
      taskId,
    });
    if (res) {
      setResult(res);
      setSelected([]);
      if (res.pending)
        notify(
          endpoint === "suggest"
            ? "下拉词分析记录已保存。已有未完成记录会直接复用，不会自动重发请求。"
            : "任务已提交。请至少等待60秒后获取结果，避免重复提交。",
        );
      else if (!res.keywords.length && !res.hotspots.length)
        setQueryFeedback(
          "接口已返回，本次没有候选结果。可在调用与费用中核对请求记录。",
        );
    } else
      setQueryFeedback(
        "查询未完成。请先在“调用与费用”查看接口返回及待核费用，避免重复提交造成再次计费。",
      );
  };
  const extract = async () => {
    if (!resource) return;
    const res = await command<{ keywords: { word: string; intent: string }[] }>(
      "ai.keywords",
      { resourceId: resource.id },
    );
    if (res) setSeeds(res.keywords.map((k) => k.word).join("，"));
  };
  const savePool = async (
    keywords: Keyword[] = result?.keywords.filter((k) =>
      selected.includes(k.id),
    ) ?? [],
  ) => {
    const p = await command<Pool>(
      "pool.save",
      {
        name:
          poolName.trim() || `${resource?.title.slice(0, 20) ?? "新发现"}词池`,
        resourceId: resource?.id ?? null,
        keywords,
      },
      "词池已保存到本地，可用于生成内容。",
    );
    if (p) setPoolName("");
  };
  const { cny, usd } = data!.apiUsage;
  return (
    <>
      <Header
        title="发现新词，也发现新的内容机会。"
        description="5118找词、热点候选和调用台账；按数据来源与实际套餐分别核算。"
      />
      <div className="tabs" role="tablist" aria-label="流量发现功能">
        {[
          ["words", "找词与词池"],
          ["hotspots", "找热点"],
          ["costs", "调用与费用"],
        ].map(([id, name]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id as typeof tab);
              setResult(null);
              setQueryFeedback(null);
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "costs" ? (
        <>
          <Notice warning>
            公开文档尚未确认5118余额或账单查询API。下面是本地请求记录及套餐摊销估算，官方实扣金额保持“未同步”。
          </Notice>
          <div className="stat-strip usage-strip">
            <div>
              5118累计外部请求
              <strong>{cny.requestCount}</strong>
            </div>
            <div>
              5118成功请求摊销
              <strong>{formatMoney(cny.estimatedMicros)}</strong>
              {cny.estimateUnknownCount ? (
                <small>另有{cny.estimateUnknownCount}笔未配置单价</small>
              ) : null}
            </div>
            <div>
              5118待核预留<strong>{formatMoney(cny.pendingMicros)}</strong>
              <small>
                {cny.pendingCount}笔待核
                {cny.pendingUnknownCount
                  ? `，其中${cny.pendingUnknownCount}笔金额未知`
                  : ""}
              </small>
            </div>
          </div>
          <div className="stat-strip usage-strip">
            <div>
              AI累计生成请求<strong>{usd.requestCount}</strong>
            </div>
            <div>
              AI已返回实际费用
              <strong>{formatMoney(usd.confirmedMicros, "USD")}</strong>
              <small>
                {usd.confirmedUnknownCount
                  ? `另有${usd.confirmedUnknownCount}笔金额未返回，不计入已知实费`
                  : "按OpenRouter usage.cost汇总"}
              </small>
            </div>
            <div>
              AI待核预留<strong>{formatMoney(usd.pendingMicros, "USD")}</strong>
              <small>
                {usd.pendingCount}笔待核
                {usd.pendingUnknownCount
                  ? `，其中${usd.pendingUnknownCount}笔金额未知`
                  : ""}
              </small>
            </div>
          </div>
          <small>
            累计统计来自全部本地台账；5118缓存命中{cny.cacheHits}
            次。下表仅展示最近500笔。人民币和美元分别计算，不换汇合并。
          </small>
          <Panel
            title="计费口径"
            extra={
              <Button onClick={() => navigate("settings")}>
                接口与套餐设置
              </Button>
            }
          >
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>接口</th>
                    <th>计费单位</th>
                    <th>你的套餐摊销单价</th>
                    <th>官方实扣/余额</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.plans.map((p) => (
                    <tr key={p.endpoint}>
                      <td>{endpointSpecs[p.endpoint].name}</td>
                      <td>{endpointSpecs[p.endpoint].unit}</td>
                      <td>{formatMoney(p.unitPriceMicros)}</td>
                      <td>未同步</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <small>
              预付套餐的摊销消耗不等于每次新付款。缓存没有外部请求；超时、重试和轮询可能已计费，须对账。
            </small>
          </Panel>
          <Panel
            title="最近500笔调用记录"
            extra={
              <Button
                disabled={busy > 0}
                onClick={async () => {
                  const path = await command<string | null>("api.export");
                  if (path) notify(`费用台账已导出：${path}`);
                }}
              >
                导出全部CSV
              </Button>
            }
          >
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>时间 / 接口</th>
                    <th>外部请求</th>
                    <th>计费单位</th>
                    <th>本地估算</th>
                    <th>官方金额</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.apiCalls.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {formatTime(c.createdAt)}
                        <br />
                        <small>
                          {c.endpoint === "openrouter"
                            ? "OpenRouter（美元）"
                            : (endpointSpecs[c.endpoint as Endpoint]?.name ??
                              c.endpoint)}
                        </small>
                      </td>
                      <td>{c.requestCount}</td>
                      <td>{c.phase === "poll" ? "待核；按1预留" : c.units}</td>
                      <td>
                        {formatMoney(
                          c.estimatedMicros,
                          c.endpoint === "openrouter" ? "USD" : "CNY",
                        )}
                      </td>
                      <td>
                        {c.confirmedMicros == null
                          ? "未返回/未同步"
                          : formatMoney(
                              c.confirmedMicros,
                              c.endpoint === "openrouter" ? "USD" : "CNY",
                            )}
                      </td>
                      <td>
                        <span className="tag">
                          {
                            (
                              {
                                cache: "缓存",
                                success: "请求成功",
                                uncertain: "待核实",
                                reserved: "已预留",
                                failed: "失败",
                              } as Record<string, string>
                            )[c.status]
                          }
                        </span>
                        <small className="table-note">{c.message}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data!.apiCalls.length ? (
                <Empty title="还没有调用记录">
                  配置接口后，实际请求、缓存与预算占用会记录在这里。
                </Empty>
              ) : null}
            </div>
          </Panel>
          <div className="row">
            <Button
              onClick={() =>
                void command("system.external", {
                  url: "https://account.5118.com/signin/myapi",
                })
              }
            >
              打开5118我的API后台
            </Button>
            <small>
              正式对账请核对后台用量；不自动将成功请求认定为确定扣费。
            </small>
          </div>
        </>
      ) : (
        <>
          <ResourcePicker />
          {tab === "hotspots" ? (
            <Notice warning>
              热点雷达有官方接口文档，但现售权限和数据更新时效仍需真实账号验证。启用前请在设置中确认，结果以API实际返回为准。
            </Notice>
          ) : null}
          <Panel
            title={tab === "hotspots" ? "筛选热点线索" : "种子关键词"}
            extra={
              tab === "words" ? (
                <Button
                  disabled={!resource || busy > 0}
                  onClick={() => void extract()}
                >
                  <Sparkles size={14} />
                  AI提取种子词
                </Button>
              ) : null
            }
          >
            <div className="fields">
              <Field
                label={tab === "hotspots" ? "热点关键词" : "查询词"}
                hint={
                  tab === "hotspots"
                    ? "可留空查看所选类型与时间范围"
                    : "逗号或换行分隔"
                }
              >
                <textarea
                  value={seeds}
                  aria-label="查询种子词"
                  onChange={(e) => setSeeds(e.target.value)}
                  placeholder="例如：AI办公，会议纪要，提示词模板"
                />
              </Field>
              {tab === "words" ? (
                <div className="field-pair">
                  <Field label="找词方法">
                    <select
                      aria-label="找词方法"
                      value={method}
                      onChange={(e) => {
                        setMethod(e.target.value as Endpoint);
                        setResult(null);
                        setQueryFeedback(null);
                      }}
                    >
                      <option value="longtail">海量长尾词 v2</option>
                      <option value="suggest">分平台下拉联想词</option>
                      <option value="metrics">批量搜索量 v2（异步）</option>
                    </select>
                  </Field>
                  {method === "longtail" ? (
                    <Field label="每词查询页数">
                      <select
                        aria-label="每词查询页数"
                        value={pages}
                        onChange={(e) => setPages(Number(e.target.value))}
                      >
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n}页 · 每页最多100条
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : method === "suggest" ? (
                    <Field label="数据来源平台">
                      <select
                        aria-label="数据来源平台"
                        value={platform}
                        onChange={(e) => setPlatform(e.target.value)}
                      >
                        <option value="xiaohongshu">小红书</option>
                        <option value="douyin">抖音</option>
                        <option value="zhihu">知乎</option>
                        <option value="baidu">百度PC</option>
                        <option value="baidumobile">百度移动</option>
                        <option value="toutiao">头条</option>
                      </select>
                    </Field>
                  ) : (
                    <Notice>
                      每个关键词计一次，最多50词。提交后保存任务ID，至少60秒后手动提取结果。
                    </Notice>
                  )}
                </div>
              ) : (
                <>
                  <Field
                    label="热点类型"
                    hint="使用接口支持的类型名称；留空为全部"
                  >
                    <input
                      value={hotType}
                      onChange={(e) => setHotType(e.target.value)}
                    />
                  </Field>
                  <div className="field-pair">
                    <Field label="起始时间">
                      <input
                        type="datetime-local"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </Field>
                    <Field label="截止时间">
                      <input
                        type="datetime-local"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                      />
                    </Field>
                  </div>
                </>
              )}
              <div className="row spread">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={useCache}
                    onChange={(e) => setUseCache(e.target.checked)}
                  />
                  优先使用未过期的本地缓存
                </label>
                <Button
                  primary
                  disabled={busy > 0 || (tab === "words" && !seeds.trim())}
                  onClick={() =>
                    void query(tab === "hotspots" ? "radar" : method)
                  }
                >
                  <Search size={15} />
                  {tab === "hotspots" ? "查找热点" : "查询关键词"}
                </Button>
              </div>
              <small>
                每次查询会按接口计次并预留预算。不同平台指标分别展示，未提供的指标不显示为0。
              </small>
            </div>
          </Panel>
          {busy > 0 ? <Loading label="正在查询，请勿重复提交…" /> : null}
          {queryFeedback ? <Notice warning>{queryFeedback}</Notice> : null}
          {tab === "words" &&
          method === "suggest" &&
          data!.suggestionQueries.length ? (
            <Panel title="已保存的下拉词分析">
              <Notice>
                下拉词没有远端任务ID。普通查询会复用未完成记录；继续查询会再次请求原关键词与平台，可能计费。应用限制至少间隔60秒，不自动轮询。
              </Notice>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={allowSuggestionRequest}
                  onChange={(e) => setAllowSuggestionRequest(e.target.checked)}
                />
                我已核对上次调用，接受继续查询可能再次计费
              </label>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>关键词 / 平台</th>
                      <th>分析状态</th>
                      <th>最后请求</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.suggestionQueries.map((q) => (
                      <tr key={q.id}>
                        <td>
                          {q.seed}
                          <br />
                          <small>{sourcePlatform(q.platform)}</small>
                        </td>
                        <td>
                          {q.status === "completed"
                            ? `已完成 · ${q.resultCount}词`
                            : q.status === "pending"
                              ? "数据分析中"
                              : "请求结果待核"}
                          <small className="table-note">{q.message}</small>
                          {!q.canRequest ? (
                            <small className="table-note">
                              此记录的Key已变更，仅可查看已有结果。
                            </small>
                          ) : null}
                        </td>
                        <td>{formatTime(q.lastRequestedAt)}</td>
                        <td>
                          <Button
                            disabled={
                              busy > 0 ||
                              (q.status !== "completed" &&
                                (!allowSuggestionRequest || !q.canRequest))
                            }
                            onClick={async () => {
                              const request = q.status !== "completed";
                              setAllowSuggestionRequest(false);
                              setQueryFeedback(null);
                              const res = await command<TrafficResult>(
                                request
                                  ? "traffic.resumeSuggestion"
                                  : "traffic.suggestionResult",
                                request
                                  ? { id: q.id, chargeAcknowledged: true }
                                  : { id: q.id },
                              );
                              if (res) {
                                setResult(res);
                                setSelected([]);
                                if (res.pending)
                                  setQueryFeedback(
                                    "5118仍在分析，记录已保留；本次费用待核，不会自动继续请求。",
                                  );
                              }
                            }}
                          >
                            {q.status === "completed"
                              ? "查看已存结果"
                              : "继续查询（可能计费）"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
          {tab === "words" &&
          method === "metrics" &&
          data!.asyncQueries.length ? (
            <Panel title="已保存的搜索量任务">
              {data!.asyncQueries.map((q) => (
                <div className="row spread" key={q.taskId}>
                  <span>
                    {q.seeds.join("、")}
                    <small>
                      {" "}
                      {formatTime(q.createdAt)} ·{" "}
                      {q.status === "completed"
                        ? "已完成"
                        : q.status === "uncertain"
                          ? "提交结果待核，已拦截重复查询"
                          : q.status === "released"
                            ? "已人工解除拦截"
                            : "待获取"}
                    </small>
                  </span>
                  {q.status === "uncertain" ? (
                    <Button
                      disabled={busy > 0}
                      onClick={() =>
                        void command(
                          "traffic.releaseSubmission",
                          { taskId: q.taskId },
                          "已解除拦截。再次提交可能计费，上次预留费用仍保留。",
                        )
                      }
                    >
                      已在5118核对，允许重新提交
                    </Button>
                  ) : q.status === "released" ? null : (
                    <Button
                      disabled={busy > 0}
                      onClick={() => void query("metrics", q.taskId)}
                    >
                      {q.status === "completed"
                        ? "查看已存结果"
                        : "获取任务结果"}
                    </Button>
                  )}
                </div>
              ))}
            </Panel>
          ) : null}
          {method === "metrics" && result?.pending ? (
            <Panel title="数据正在获取中">
              <p>任务ID：{result.taskId}</p>
              <Notice>
                稍后获取同一任务的结果，不要重新提交相同关键词。轮询计次规则尚待核实。
              </Notice>
              <Button
                disabled={busy > 0}
                onClick={() => void query("metrics", result.taskId)}
              >
                <RefreshCw size={14} />
                获取已有任务结果
              </Button>
            </Panel>
          ) : null}
          {tab === "words" && result?.keywords.length ? (
            <>
              <div className="section-heading">
                <h2>关键词结果 · {result.keywords.length} 个</h2>
                <small>
                  {result.fromCache
                    ? "本地缓存，保留原采集时间"
                    : "5118返回数据"}
                </small>
              </div>
              <div className="table-scroll bordered">
                <table>
                  <thead>
                    <tr>
                      <th>
                        <input
                          aria-label="全选关键词"
                          type="checkbox"
                          checked={selected.length === result.keywords.length}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? result.keywords.map((k) => k.id)
                                : [],
                            )
                          }
                        />
                      </th>
                      <th>关键词</th>
                      <th>来源平台</th>
                      <th>流量指数</th>
                      <th>抖音指数</th>
                      <th>PC检索量</th>
                      <th>来源更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.keywords.map((k) => (
                      <tr key={k.id}>
                        <td>
                          <input
                            aria-label={`选择${k.word}`}
                            type="checkbox"
                            checked={selected.includes(k.id)}
                            onChange={(e) =>
                              setSelected((ids) =>
                                e.target.checked
                                  ? [...ids, k.id]
                                  : ids.filter((id) => id !== k.id),
                              )
                            }
                          />
                        </td>
                        <td>{k.word}</td>
                        <td>{k.platform ?? k.source}</td>
                        <td>{k.metrics.index ?? "未提供"}</td>
                        <td>{k.metrics.douyin_index ?? "未提供"}</td>
                        <td>{k.metrics.bidword_pcpv ?? "未提供"}</td>
                        <td>
                          {k.sourceUpdatedAt ?? "未提供"}
                          <br />
                          <small>获取：{formatTime(k.fetchedAt)}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ margin: "16px 0" }}>
                <input
                  className="grow"
                  placeholder="词池名称"
                  aria-label="词池名称"
                  value={poolName}
                  onChange={(e) => setPoolName(e.target.value)}
                />
                <span className="muted">已选{selected.length}词</span>
                <Button
                  primary
                  disabled={!selected.length || busy > 0}
                  onClick={() => void savePool()}
                >
                  <BookmarkPlus size={15} />
                  保存词池
                </Button>
              </div>
            </>
          ) : null}
          {tab === "hotspots" && result?.hotspots.length
            ? result.hotspots.map((h) => (
                <Panel
                  key={h.id}
                  title={h.title}
                  extra={<span className="tag">{h.type || "未提供类型"}</span>}
                >
                  <div className="property">
                    <span>来源更新时间</span>
                    <span>{h.sourceUpdatedAt ?? "未提供"}</span>
                  </div>
                  <div className="property">
                    <span>本地获取时间</span>
                    <span>{formatTime(h.fetchedAt)}</span>
                  </div>
                  {h.events.length ? (
                    <details>
                      <summary>查看事件发展脉络</summary>
                      <pre className="safe-json">
                        {JSON.stringify(h.events, null, 2)}
                      </pre>
                    </details>
                  ) : (
                    <p className="muted">
                      接口未提供事件脉络，请自行核实热点事实。
                    </p>
                  )}
                  <div className="row">
                    <Button
                      onClick={() => {
                        setSeeds(h.title);
                        setTab("words");
                        setMethod("longtail");
                        setResult(null);
                      }}
                    >
                      作为种子词 <ArrowRight size={14} />
                    </Button>
                    <Button
                      quiet
                      onClick={() =>
                        void savePool([
                          {
                            id: h.id,
                            word: h.title,
                            source: "5118 热点雷达",
                            platform: null,
                            metrics: {},
                            sourceUpdatedAt: h.sourceUpdatedAt,
                            fetchedAt: h.fetchedAt,
                          },
                        ])
                      }
                    >
                      收藏到词池
                    </Button>
                  </div>
                </Panel>
              ))
            : null}
          {result &&
          !result.pending &&
          !result.keywords.length &&
          !result.hotspots.length ? (
            <Empty title="没有返回匹配数据">
              可以缩短关键词、更换平台或调整时间范围。请求记录和费用状态已保留。
            </Empty>
          ) : null}
          <Panel title="手工整理词池">
            <Field label="手工词池名称">
              <input
                aria-label="手工词池名称"
                value={manualName}
                maxLength={100}
                onChange={(e) => setManualName(e.target.value)}
              />
            </Field>
            <Field label="关键词" hint="逗号或换行分隔，去重保存，最多1000词">
              <textarea
                aria-label="手工词池关键词"
                value={manualWords}
                maxLength={200000}
                onChange={(e) => setManualWords(e.target.value)}
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={manualBound}
                disabled={!resource}
                onChange={(e) => setManualBound(e.target.checked)}
              />
              关联当前资源
              {resource ? `：${resource.title}` : "（请先选择资源）"}
            </label>
            <Button
              disabled={!manualName.trim() || !manualWords.trim() || busy > 0}
              onClick={async () => {
                const saved = await command<Pool>(
                  "pool.manual",
                  {
                    name: manualName,
                    words: manualWords,
                    resourceId: manualBound ? (resource?.id ?? null) : null,
                  },
                  "手工词池已保存在本地，未调用付费接口。",
                );
                if (saved) {
                  setManualName("");
                  setManualWords("");
                }
              }}
            >
              保存手工词池
            </Button>
            <small>
              手工词不附流量指数；复制已有词池进行整理时会另存副本，原稿引用保持有效。
            </small>
          </Panel>
          <Panel
            title="我的词池"
            extra={
              <Button
                quiet
                disabled={!data!.pools.length}
                onClick={() => navigate("studio")}
              >
                去创作 <ArrowRight size={14} />
              </Button>
            }
          >
            {data!.pools.length ? (
              <div className="pool-list">
                {data!.pools.map((p) => (
                  <div key={p.id}>
                    <strong>{p.name}</strong>
                    <small>
                      {p.keywords.length}个词 ·{" "}
                      {p.resourceId
                        ? data!.resources.find((r) => r.id === p.resourceId)
                            ?.title
                        : "尚未关联资源"}
                    </small>
                    <div className="row compact">
                      {p.keywords.slice(0, 5).map((k) => (
                        <span className="tag" key={k.id}>
                          {k.word}
                        </span>
                      ))}
                    </div>
                    <Button
                      quiet
                      onClick={() => {
                        setManualName(`${p.name.slice(0, 90)} 副本`);
                        setManualWords(
                          p.keywords.map((k) => k.word).join("\n"),
                        );
                        setManualBound(!!p.resourceId);
                        if (p.resourceId) select(p.resourceId);
                      }}
                    >
                      复制编辑
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">
                选择相关词并保存，后续可以用于不同平台的内容创作。
              </p>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
