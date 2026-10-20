import { updateSelection } from "../lib/selection";
import { ArrowRight, BookmarkPlus } from "lucide-react";
import { useAppActivity } from "../state";
import { Button, Empty, Panel } from "../ui/primitives";

import { formatTime } from "../lib/format";

import type { TrafficModel } from "./useTrafficDiscovery";
export function TrafficResults({ model }: { model: TrafficModel }) {
  const { busy } = useAppActivity();
  const {
    tab,
    setTab,
    setMethod,
    setSeeds,
    result,
    setResult,
    selected,
    setSelected,
    poolName,
    setPoolName,
    savePool,
  } = model;
  return (
    <>
      {tab === "words" && result?.keywords.length ? (
        <>
          <div className="section-heading">
            <h2>关键词结果 · {result.keywords.length} 个</h2>
            <small>
              {result.fromCache ? "本地缓存，保留原采集时间" : "5118返回数据"}
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
                            updateSelection(ids, [k.id], e.target.checked),
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
    </>
  );
}
