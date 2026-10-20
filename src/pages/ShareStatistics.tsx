import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { useIpcQuery } from "../api/useIpcQuery";
import { Pagination } from "../ui/Pagination";

import { useEffect, useState } from "react";
import { Download, RefreshCw, ChartNoAxesCombined } from "lucide-react";
import {
  useAppActions,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import {
  Button,
  Empty,
  Header,
  Loading,
  LoadingState,
  Notice,
  Panel,
  SearchField,
  Status,
} from "../ui/primitives";
import { providerName } from "../resources/labels";
import { formatTime } from "../lib/format";
import {
  providerIds,
  providerStatisticsNotes,
  unsupportedStatisticsProviders,
} from "../../shared/providers";
import type { Provider } from "../../shared/types";
import {
  metricNames,
  metricLabels,
  formatShareMetric,
  shareMetricDelta,
  shareStateLabels,
  type ShareMetric,
  type ShareStatsFilter,
  type ShareStatsRefreshResult,
} from "../../shared/share-statistics";
import "../share-statistics.css";

function MetricCell({
  metric,
  previous,
  previousAt,
}: {
  metric: ShareMetric;
  previous?: ShareMetric;
  previousAt: string | null;
}) {
  const delta = shareMetricDelta(metric, previous);
  const decreased =
    metric.precision === "exact" &&
    previous?.precision === "exact" &&
    metric.value != null &&
    previous.value != null &&
    metric.value < previous.value;
  return (
    <>
      <strong title={metric.reason}>{formatShareMetric(metric)}</strong>
      <small
        className={delta != null && delta > 0 ? "share-stats-gain" : ""}
        title={previousAt ? `与${formatTime(previousAt)}的快照比较` : undefined}
      >
        {delta != null
          ? `较上次 +${delta.toLocaleString("zh-CN")}`
          : decreased
            ? "计数回落，增量待核"
            : metric.precision === "at_least"
              ? "仅为已知下限"
              : previousAt
                ? "增量不可计算"
                : "首次同步，无增量"}
      </small>
    </>
  );
}

export default function ShareStatistics() {
  const { data } = useAppData(),
    { select } = useAppSelection(),
    { navigate } = useAppNavigation(),
    { command, notify } = useAppActions();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<Provider | "">("");
  const [accountId, setAccountId] = useState("");
  const [scope, setScope] = useState<ShareStatsFilter["scope"]>("all");
  const [state, setState] = useState<ShareStatsFilter["state"]>("all");
  const [sort, setSort] = useState<ShareStatsFilter["sort"]>("views");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<ShareStatsRefreshResult[]>([]);
  const filter: ShareStatsFilter = {
    query,
    provider: provider || undefined,
    accountId: accountId || undefined,
    scope,
    state,
    sort,
    page,
    pageSize: 50,
  };
  useEffect(() => window.panxu.onChanged(() => setRevision((n) => n + 1)), []);
  const {
    data: result,
    loading,
    error,
    reload,
  } = useIpcQuery("shareStats.list", filter, {
    delay: 150,
    revision,
    keepPrevious: true,
  });
  const showDataControls = !!(
    result?.total ||
    result?.syncs.some((s) => s.succeededAt) ||
    query ||
    provider ||
    accountId ||
    scope !== "all" ||
    state !== "all"
  );
  const accounts = data!.accounts.filter(
    (a) => !provider || a.provider === provider,
  );
  const selectedAccounts = accounts.filter(
    (a) =>
      (!accountId || a.id === accountId) &&
      a.enabled &&
      a.uid &&
      !unsupportedStatisticsProviders.includes(a.provider),
  );
  const running =
    syncing ||
    result?.syncs.some(
      (s) =>
        s.status === "running" &&
        selectedAccounts.some((a) => a.id === s.accountId),
    );
  async function sync(ids: string[]) {
    if (!ids.length) return;
    setSyncing(true);
    try {
      const results = await command("shareStats.refresh", { accountIds: ids });
      if (results) {
        setLastRefresh(results);
        const successes = results.filter((r) => r.status === "success");
        notify(
          `同步完成：${successes.length}个账号成功，${results.filter((r) => r.status === "failed").length}个失败，${results.filter((r) => r.status === "skipped").length}个跳过。`,
          results.some((r) => r.status === "failed")
            ? successes.length
              ? "warning"
              : "error"
            : successes.length
              ? "success"
              : "info",
        );
      }
    } finally {
      setSyncing(false);
      setRevision((n) => n + 1);
    }
  }
  return (
    <>
      <Header
        title="分享统计"
        description="汇总本人分享的浏览、保存与下载数据，查看每个链接的传播情况。"
        action={
          <div className="row wrap">
            <Button
              disabled={!result?.total || loading}
              onClick={async () => {
                const path = await command("shareStats.export", filter);
                if (path) notify("已导出当前筛选的全部分享统计。", "success");
              }}
            >
              <Download size={15} /> 导出 CSV
            </Button>
            <Button
              primary
              disabled={running || !selectedAccounts.length}
              onClick={() => void sync(selectedAccounts.map((a) => a.id))}
            >
              <RefreshCw size={15} />{" "}
              {running
                ? "正在同步…"
                : accountId
                  ? "同步此账号"
                  : "同步筛选账号"}
            </Button>
          </div>
        }
      />
      {showDataControls ? (
        <Notice>
          数据来自网盘返回的累计次数，浏览次数不等于独立访客，下载次数不代表下载完成。首次同步建立基线；“较上次”比较两次同步快照。“未返回”不计为
          0，“100+”等下限值不计算精确增量。
        </Notice>
      ) : null}
      {provider === "guangya" || provider === "pikpak" ? (
        <Notice>{providerStatisticsNotes[provider]}</Notice>
      ) : null}
      <QueryError error={error} loading={loading} onRetry={reload} />
      {lastRefresh.some((r) => r.status !== "success") ? (
        <Notice warning>
          {lastRefresh
            .filter((r) => r.status !== "success")
            .map((r) => (
              <div key={r.accountId}>
                <strong>
                  {data!.accounts.find((a) => a.id === r.accountId)?.alias}
                </strong>
                ：{r.message}{" "}
                {r.status === "failed" ? "保留上次成功同步的数据。" : ""}
              </div>
            ))}
        </Notice>
      ) : null}
      {showDataControls ? (
        <div className="share-stats-summary" aria-label="分享统计汇总">
          <Panel>
            <span>当前筛选分享</span>
            <strong>
              {!loading && result ? result.total.toLocaleString("zh-CN") : "—"}
            </strong>
            <small>
              {scope === "managed"
                ? "项目整份资料及拆分链接"
                : "包含网盘内其他本人分享"}
            </small>
          </Panel>
          {metricNames.map((name) => {
            const total = result?.summary[name];
            return (
              <Panel key={name}>
                <span>{metricLabels[name]}</span>
                <strong>
                  {loading
                    ? "—"
                    : total?.value == null
                      ? "未返回"
                      : `${total.unknown ? "已知 " : ""}${total.value.toLocaleString("zh-CN")}${total.atLeast ? "+" : ""}`}
                </strong>
                <small>
                  {total
                    ? `${total.known}个链接有值 · ${total.unknown}个未返回`
                    : "同步后显示网盘实际返回值"}
                </small>
              </Panel>
            );
          })}
        </div>
      ) : null}
      <Panel
        className={
          showDataControls ? "share-stats-list" : "share-stats-onboarding"
        }
        title="本人分享明细"
        extra={
          loading && result?.items.length ? (
            <Loading label="正在更新本地统计…" />
          ) : (
            <span className="muted">离线可查看最近快照</span>
          )
        }
      >
        {showDataControls ? (
          <div className="toolbar share-stats-toolbar">
            <SearchField
              value={query}
              onChange={(v) => {
                setQuery(v);
                setPage(1);
              }}
              placeholder="搜索分享标题、链接或关联资料…"
            />
            <Select
              aria-label="统计网盘"
              value={provider}
              onValueChange={(nextValue) => {
                setProvider(nextValue as Provider | "");
                setAccountId("");
                setPage(1);
              }}
              items={[
                { value: "", label: "全部网盘" },
                ...providerIds.map((p) => ({
                  value: p,
                  label: providerName(p),
                })),
              ]}
            />
            <Select
              aria-label="统计账号"
              value={accountId}
              onValueChange={(nextValue) => {
                setAccountId(nextValue);
                setPage(1);
              }}
              items={[
                { value: "", label: "全部账号" },
                ...accounts.map((a) => ({ value: a.id, label: a.alias })),
              ]}
            />
            <Select
              aria-label="统计范围"
              value={scope}
              onValueChange={(nextValue) => {
                setScope(nextValue as typeof scope);
                setPage(1);
              }}
              items={[
                { value: "all", label: "全部本人分享" },
                { value: "managed", label: "仅项目资料与拆分链接" },
              ]}
            />
            <Select
              aria-label="分享状态"
              value={state}
              onValueChange={(nextValue) => {
                setState(nextValue as typeof state);
                setPage(1);
              }}
              items={[
                { value: "all", label: "本次列表全部状态" },
                ...Object.entries(shareStateLabels).map(([v, label]) => ({
                  value: v,
                  label: label,
                })),
                { value: "missing", label: "已不在列表（历史）" },
              ]}
            />
            <Select
              aria-label="统计排序"
              value={sort}
              onValueChange={(nextValue) => {
                setSort(nextValue as typeof sort);
                setPage(1);
              }}
              items={[
                ...metricNames.map((n) => ({
                  value: n,
                  label: <>{metricLabels[n]}从高到低</>,
                })),
                { value: "createdAt", label: "最新分享优先" },
              ]}
            />
          </div>
        ) : null}
        {loading && !result?.items.length ? (
          <LoadingState label="正在读取本地统计…" />
        ) : result?.items.length ? (
          <>
            <div className="table-scroll">
              <table className="data-table share-stats-table">
                <thead>
                  <tr>
                    <th>分享 / 关联资料</th>
                    <th>网盘 / 账号</th>
                    {metricNames.map((name) => (
                      <th key={name}>{metricLabels[name]}</th>
                    ))}
                    <th>状态 / 快照时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((r) => (
                    <tr key={`${r.accountId}:${r.shareId}`}>
                      <td className="share-stats-title">
                        <strong>{r.title}</strong>
                        <small>
                          {r.resourceTitle
                            ? `项目资料：${r.resourceTitle}${r.splitItemId ? " · 拆分链接" : " · 整份链接"}`
                            : "网盘内其他本人分享"}
                        </small>
                        {r.targetPath ? <small>{r.targetPath}</small> : null}
                        <small className="share-stats-url">
                          {r.url ?? `分享ID：${r.shareId}`}
                        </small>
                      </td>
                      <td>
                        {providerName(r.provider)}
                        <small>{r.accountAlias}</small>
                      </td>
                      {metricNames.map((name) => (
                        <td className="share-stats-count" key={name}>
                          <MetricCell
                            metric={r.metrics[name]}
                            previous={r.previousMetrics?.[name]}
                            previousAt={r.previousAt}
                          />
                        </td>
                      ))}
                      <td>
                        <Status
                          kind={
                            !r.present ||
                            r.state === "expired" ||
                            r.state === "unavailable"
                              ? "warning"
                              : r.state === "active"
                                ? "good"
                                : "normal"
                          }
                        >
                          {r.present ? shareStateLabels[r.state] : "已不在列表"}
                        </Status>
                        <small>{formatTime(r.syncedAt)}</small>
                        {!r.present ? <small>保留历史快照</small> : null}
                      </td>
                      <td>
                        <div className="share-stats-actions">
                          {r.resourceId ? (
                            <Button
                              quiet
                              onClick={() => {
                                select(r.resourceId!, r.copyId ?? undefined);
                                navigate("library");
                              }}
                            >
                              查看资料
                            </Button>
                          ) : null}
                          {r.url ? (
                            <Button
                              quiet
                              onClick={() =>
                                void command("share.open", {
                                  accountId: r.accountId,
                                  sourceText: r.url!,
                                })
                              }
                            >
                              查看分享
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              label="分享统计翻页"
              page={result.page}
              pageSize={result.pageSize}
              total={result.total}
              disabled={loading}
              onPageChange={setPage}
            >
              第 {result.page} /{" "}
              {Math.max(1, Math.ceil(result.total / result.pageSize))} 页 · 共{" "}
              {result.total} 个分享
            </Pagination>
          </>
        ) : error ? null : (
          <Empty
            title={
              query || scope !== "all" || state !== "all"
                ? "没有符合条件的分享"
                : "还没有分享统计"
            }
            action={
              !selectedAccounts.length ? (
                <Button onClick={() => navigate("accounts")}>
                  前往账号管理
                </Button>
              ) : (
                <Button
                  primary
                  disabled={running}
                  onClick={() => void sync(selectedAccounts.map((a) => a.id))}
                >
                  <ChartNoAxesCombined size={16} /> 同步本人分享
                </Button>
              )
            }
          >
            {accounts.length &&
            accounts.every((a) =>
              unsupportedStatisticsProviders.includes(a.provider),
            )
              ? "当前所选网盘暂不支持逐分享统计；账号的转存和分享功能可继续使用。"
              : selectedAccounts.length
                ? "同步已核验账号的本人分享列表，读取各网盘实际返回的统计。"
                : "先添加本人网盘账号并完成登录核验，再同步统计。"}
          </Empty>
        )}
      </Panel>
      <Panel
        title="账号同步情况"
        extra={<small>手动刷新 · 每账号间隔至少 60 秒</small>}
      >
        {accounts.length ? (
          <div className="share-stats-accounts">
            {accounts.map((a) => {
              const s = result?.syncs.find((s) => s.accountId === a.id);
              const unsupported = unsupportedStatisticsProviders.includes(
                a.provider,
              );
              return (
                <div className="share-stats-account" key={a.id}>
                  <div>
                    <strong>{a.alias}</strong>
                    <small>
                      {providerName(a.provider)} ·{" "}
                      {s?.succeededAt
                        ? `上次成功：${formatTime(s.succeededAt)} · ${s.count}个分享`
                        : unsupported
                          ? "暂不支持逐分享统计"
                          : "尚未成功同步"}
                    </small>
                    {s?.error ? (
                      <small className="share-stats-error">
                        {s.error} · 历史快照仍可查看
                      </small>
                    ) : null}
                  </div>
                  <Status
                    kind={
                      s?.status === "failed"
                        ? "warning"
                        : s?.status === "success"
                          ? "good"
                          : "normal"
                    }
                  >
                    {!a.enabled
                      ? "账号已停用"
                      : unsupported
                        ? "暂不支持"
                        : !a.uid
                          ? "待核验登录"
                          : s?.status === "running"
                            ? "同步中"
                            : s?.status === "failed"
                              ? "同步失败"
                              : s?.status === "success"
                                ? "已同步"
                                : "待同步"}
                  </Status>
                  <Button
                    disabled={
                      syncing ||
                      s?.status === "running" ||
                      !a.enabled ||
                      !a.uid ||
                      unsupported
                    }
                    onClick={() => void sync([a.id])}
                  >
                    同步
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted">尚未添加网盘账号。</p>
        )}
        <details className="share-stats-help">
          <summary>统计口径与可用范围</summary>
          <p>
            百度读取浏览、保存和下载计数；夸克与 UC
            读取分享记录中实际返回的浏览、转存与下载计数；迅雷读取浏览计数及接口额外返回的转存、下载计数；PikPak
            读取浏览与转存计数，下载次数未确认提供；光鸭暂不支持逐分享统计。缺失字段统一显示“未返回”。
          </p>
          <p>
            数据属于链接的累计计数，各网盘口径可能不同，跨链接汇总也可能重复计算同一个人。同步不会打开公开分享页，不会主动增加浏览次数；点击“查看分享”可能被网盘计数。快照增量不能当作自然日数据、渠道归因或拉新收益。
          </p>
          <p>
            已下架或取消的分享可能从远端列表消失，可切换“已不在列表（历史）”查看旧快照。本次接口失败会保留旧值。未接入访客身份、IP、地域或下载完成率。
          </p>
        </details>
      </Panel>
    </>
  );
}
