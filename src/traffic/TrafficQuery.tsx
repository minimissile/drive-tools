import { Select } from "../ui/Select";
import type { TrafficModel } from "./useTrafficDiscovery";
import { RefreshCw, Search, Sparkles } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppSelection,
  useAppNavigation,
} from "../state";
import { Button, Field, LoadingState, Notice, Panel } from "../ui/primitives";
import { ResourcePicker } from "../resources/components";
import { formatTime } from "../lib/format";

import KeywordIdeas from "./KeywordIdeas";
import type { Endpoint } from "../../shared/types";
const sourcePlatform = (id: string) =>
  ({
    xiaohongshu: "小红书",
    douyin: "抖音",
    zhihu: "知乎",
    baidu: "百度PC",
    baidumobile: "百度移动",
    toutiao: "头条",
  })[id] ?? id;
export function TrafficQuery({ model }: { model: TrafficModel }) {
  const { data } = useAppData();
  const { resource } = useAppSelection();
  const { openSettings } = useAppNavigation();
  const activeEndpoint = model.tab === "hotspots" ? "radar" : model.method;
  const plan = data!.plans.find((p) => p.endpoint === activeEndpoint);
  const configured =
    !!plan?.enabled && !!plan.configured && plan.unitPriceMicros != null;
  const { command, notify } = useAppActions();

  const { busy } = useAppActivity();
  const {
    queryInput,
    tab,
    method,
    setMethod,
    seeds,
    setSeeds,
    pages,
    setPages,
    platform,
    setPlatform,
    useCache,
    setUseCache,
    result,
    setResult,
    queryFeedback,
    setQueryFeedback,
    allowSuggestionRequest,
    setAllowSuggestionRequest,
    setSelected,
    hotType,
    setHotType,
    start,
    setStart,
    end,
    setEnd,
    query,
    extract,
  } = model;
  return (
    <>
      <ResourcePicker />
      {model.inputError ? <Notice danger>{model.inputError}</Notice> : null}
      {!configured ? (
        <Notice warning>
          当前接口尚未完成密钥、计价或启用配置。勾选缓存时可先读取已有结果；没有缓存时需完成配置。
          <Button quiet onClick={() => openSettings("traffic")}>
            配置此接口
          </Button>
        </Notice>
      ) : null}
      {tab === "words" ? (
        <KeywordIdeas
          seeds={seeds}
          onAppend={(words) => {
            const normalized = (w: string) =>
              w.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
            const merged = [
              ...new Map(
                [...seeds.split(/[,，\n]/), ...words]
                  .map((w) => w.trim())
                  .filter(Boolean)
                  .map((w) => [normalized(w), w]),
              ).values(),
            ];
            if (merged.length > 50) {
              notify("查询框合并后超过50个词，请先精简已有查询词。", "warning");
              return false;
            }
            setSeeds(merged.join("，"));
            queryInput.current?.focus();
            return true;
          }}
        />
      ) : null}
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
              disabled={
                !resource || busy > 0 || !data!.settings.openrouterConfigured
              }
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
              ref={queryInput}
              onChange={(e) => setSeeds(e.target.value)}
              placeholder="例如：AI办公，会议纪要，提示词模板"
            />
          </Field>
          {tab === "words" ? (
            <div className="field-pair">
              <Field label="找词方法">
                <Select
                  aria-label="找词方法"
                  value={method}
                  onValueChange={(nextValue) => {
                    setMethod(nextValue as Endpoint);
                    setResult(null);
                    setQueryFeedback(null);
                  }}
                  items={[
                    { value: "longtail", label: "海量长尾词 v2" },
                    { value: "suggest", label: "分平台下拉联想词" },
                    { value: "metrics", label: "批量搜索量 v2（异步）" },
                  ]}
                />
              </Field>
              {method === "longtail" ? (
                <Field label="每词查询页数">
                  <Select
                    aria-label="每词查询页数"
                    value={pages}
                    onValueChange={(nextValue) => setPages(Number(nextValue))}
                    items={[
                      ...[1, 2, 3, 4, 5].map((n) => ({
                        value: n,
                        label: <>{n}页 · 每页最多100条</>,
                      })),
                    ]}
                  />
                </Field>
              ) : method === "suggest" ? (
                <Field label="数据来源平台">
                  <Select
                    aria-label="数据来源平台"
                    value={platform}
                    onValueChange={(nextValue) => setPlatform(nextValue)}
                    items={[
                      { value: "xiaohongshu", label: "小红书" },
                      { value: "douyin", label: "抖音" },
                      { value: "zhihu", label: "知乎" },
                      { value: "baidu", label: "百度PC" },
                      { value: "baidumobile", label: "百度移动" },
                      { value: "toutiao", label: "头条" },
                    ]}
                  />
                </Field>
              ) : (
                <Notice>
                  每个关键词计一次，最多50词。提交后保存任务ID，至少60秒后手动提取结果。
                </Notice>
              )}
            </div>
          ) : (
            <>
              <Field label="热点类型" hint="使用接口支持的类型名称；留空为全部">
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
              disabled={
                busy > 0 ||
                (!configured && !useCache) ||
                (tab === "words" && !seeds.trim())
              }
              onClick={() => void query(tab === "hotspots" ? "radar" : method)}
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
      {busy > 0 ? (
        <LoadingState label="正在查询，请勿重复提交…" compact />
      ) : null}
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
                          const res = await command(
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
      {tab === "words" && method === "metrics" && data!.asyncQueries.length ? (
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
                      {
                        text: "已解除拦截。再次提交可能计费，上次预留费用仍保留。",
                        tone: "warning",
                      },
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
                  {q.status === "completed" ? "查看已存结果" : "获取任务结果"}
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
    </>
  );
}
