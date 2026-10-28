import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { Button, Empty, Field, LoadingState, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { formatTime } from "../lib/format";
import {
  weiboMetricKeys,
  weiboMetricLabels,
  type WeiboStatisticsSample,
} from "../../shared/weibo-statistics";
import "./statistics.css";

export function WeiboStatistics(props: { accountId: string; url: string }) {
  return (
    <StatisticsReading key={`${props.accountId}:${props.url}`} {...props} />
  );
}
function StatisticsReading({
  accountId,
  url,
}: {
  accountId: string;
  url: string;
}) {
  const query = useIpcQuery(
    "weiboStats.get",
    { accountId, url },
    { keepPrevious: true },
  );
  const [samples, setSamples] = useState<WeiboStatisticsSample[] | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const readings = samples ?? query.data,
    latest = readings?.[0];
  const refresh = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      const result = await ipc("weiboStats.refresh", { accountId, url });
      if (alive.current) setSamples(result);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "读取失败，请重试；历史数据已保留。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <div className="weibo-statistics-reading" aria-label="微博单条数据统计">
      <div className="weibo-statistics-toolbar">
        <p className="muted">
          {latest
            ? `上次采集：${formatTime(latest.observedAt)} · 本人微博详情页`
            : "仅在点击时读取本人官方页面，不使用付费统计接口。"}
        </p>
        <Button
          disabled={pending || (!query.data && query.loading)}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
          {pending ? "正在读取官方页面…" : "读取最新数据"}
        </Button>
      </div>
      {error ? (
        <Notice danger>{error}</Notice>
      ) : (
        <QueryError
          error={query.error}
          loading={query.loading}
          onRetry={query.reload}
        />
      )}
      {!readings && !query.error ? (
        <LoadingState compact label="正在读取本地统计记录…" />
      ) : null}
      {latest ? (
        <>
          <div className="table-scroll">
            <table className="weibo-statistics-values">
              <thead>
                <tr>
                  {weiboMetricKeys.map((key) => (
                    <th key={key}>{weiboMetricLabels[key]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {weiboMetricKeys.map((key) => (
                    <td key={key}>
                      {latest.metrics[key].display ?? (
                        <span className="muted">暂不可获取</span>
                      )}
                      {latest.metrics[key].approximate ? (
                        <small>网页约数</small>
                      ) : null}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted weibo-statistics-note">
            阅读量是展示次数。链接点击量未在详情页提供；未提供的数据不计为
            0。网页约数保留原样，不用于计算精确增量或点击率。
          </p>
          {readings && readings.length > 1 ? (
            <details>
              <summary>采集历史 · 最近 {readings.length} 次</summary>
              <div className="table-scroll">
                <table className="weibo-statistics-history">
                  <thead>
                    <tr>
                      <th>采集时间</th>
                      {weiboMetricKeys.map((key) => (
                        <th key={key}>{weiboMetricLabels[key]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {readings.map((sample) => (
                      <tr key={sample.id}>
                        <td>{formatTime(sample.observedAt)}</td>
                        {weiboMetricKeys.map((key) => (
                          <td key={key}>
                            {sample.metrics[key].display ?? "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </>
      ) : readings && !query.error ? (
        <Empty compact title="尚未采集这条微博">
          点击“读取最新数据”保存一次统计快照；平台未提供的指标会明确标记。
        </Empty>
      ) : null}
    </div>
  );
}

export function WeiboAccountStatistics({ accountId }: { accountId: string }) {
  const targets = useIpcQuery(
    "weiboStats.list",
    { accountId },
    { keepPrevious: true },
  );
  const [selected, setSelected] = useState<string | null>(null);
  const url = selected ?? targets.data?.[0]?.url ?? "";
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  return (
    <section className="weibo-account-statistics" aria-label="微博账号数据统计">
      <h3>微博数据统计</h3>
      <QueryError
        error={targets.error}
        loading={targets.loading}
        onRetry={targets.reload}
      />
      {!targets.data && !targets.error ? (
        <LoadingState compact label="正在读取已保存的微博链接…" />
      ) : null}
      {targets.data?.length ? (
        <Field label="已保存的微博回执">
          <Select
            aria-label="统计目标微博"
            value={targets.data.some((target) => target.url === url) ? url : ""}
            onValueChange={setSelected}
            items={[
              { value: "", label: "输入其他本人微博链接" },
              ...targets.data.map((target) => ({
                value: target.url,
                label: target.text || target.url,
              })),
            ]}
          />
        </Field>
      ) : null}
      <Field
        label="单条微博链接"
        hint="可选择已有回执，也可粘贴此账号的微博桌面详情链接。"
      >
        <input
          aria-label="微博统计链接"
          type="url"
          value={url}
          onChange={(event) => setSelected(event.target.value)}
          placeholder="https://weibo.com/作者UID/微博ID"
          maxLength={2000}
        />
      </Field>
      {parsed ? (
        <WeiboStatistics accountId={accountId} url={url.trim()} />
      ) : (
        <p className="muted">填写单条链接后即可读取统计，无需重新发布。</p>
      )}
    </section>
  );
}
