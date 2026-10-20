import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import { Button, Empty, Notice, Panel } from "../ui/primitives";

import { formatMoney, formatTime } from "../lib/format";
import { endpointSpecs } from "../../shared/platforms";

import type { Endpoint } from "../../shared/types";

export function TrafficCosts() {
  const { data } = useAppData();

  const { command, notify } = useAppActions();
  const { navigate } = useAppNavigation();
  const { busy } = useAppActivity();
  const { cny, usd } = data!.apiUsage;
  return (
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
          <Button onClick={() => navigate("settings")}>接口与套餐设置</Button>
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
              const path = await command("api.export");
              if (path) notify(`费用台账已导出：${path}`, "success");
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
        <small>正式对账请核对后台用量；不自动将成功请求认定为确定扣费。</small>
      </div>
    </>
  );
}
