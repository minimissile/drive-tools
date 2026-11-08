import { useRef, useState } from "react";
import { Download, ExternalLink, Search } from "lucide-react";
import { z } from "zod";
import {
  wechatDiscoveryRequestUsd,
  wechatDiscoverySearch,
  type WechatDiscoveryArticle,
} from "../../shared/wechat-discovery";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { DataState, Loading } from "../ui/DataState";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import {
  Button,
  Empty,
  LoadingState,
  Panel,
  SearchField,
} from "../ui/primitives";
import { Select } from "../ui/Select";
import "./discovery.css";

const periods = {
  all: "全部时间",
  day: "最近一天",
  week: "最近一周",
  half_year: "最近半年",
} as const;
const period = wechatDiscoverySearch.shape.publishTime.unwrap();
const inputSchema = z.object({
  keyword: z.string().max(100),
  publishTime: period.default("all"),
});
const pageSize = 10;
const day = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" });
const dateValue = (value: string | null) =>
  value ? Date.parse(value) || 0 : 0;

type Order = "match" | "newest";

export function WechatDiscovery({
  active,
  onImport,
}: {
  active: boolean;
  onImport(url: string): Promise<void>;
}) {
  const { data } = useAppData();
  const { openSettings } = useAppNavigation();
  const { notify } = useAppActions();
  const draft = useLocalDraft(
    `panxu:wechat:${data!.dataPath}:discovery`,
    { keyword: "", publishTime: "all" as z.infer<typeof period> },
    (value) => inputSchema.parse(value),
  );
  const config = useIpcQuery("wechat.discoveryConfig", undefined, {
    enabled: active,
    keepPrevious: true,
  });
  const [result, setResult] = useState<{
    keyword: string;
    publishTime: z.infer<typeof period>;
    items: WechatDiscoveryArticle[];
    nextCursor: string | null;
  } | null>(null);
  const [order, setOrder] = useState<Order>("match");
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<"search" | "more" | "import" | null>(
    null,
  );
  const [importing, setImporting] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const keyword = draft.value.keyword.trim();
  const items = result?.items ?? [];
  const ordered =
    order === "match"
      ? items
      : [...items].sort(
          (a, b) => dateValue(b.publishedAt) - dateValue(a.publishedAt),
        );
  const visible = ordered.slice((page - 1) * pageSize, page * pageSize);

  const changePage = (next: number) => {
    setPage(next);
    scroll.current?.scrollTo({ top: 0 });
  };

  const run = async (
    action: NonNullable<typeof pending>,
    operation: () => Promise<void>,
    fallback: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setPending(action);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setPending(null);
      lock.current = false;
    }
  };

  const search = () => {
    if (!keyword || !config.data?.configured) return;
    void run(
      "search",
      async () => {
        const publishTime = draft.value.publishTime;
        const response = await ipc("wechat.discover", { keyword, publishTime });
        setResult({
          keyword,
          publishTime,
          items: response.items,
          nextCursor: response.nextCursor ?? null,
        });
        setOrder("match");
        changePage(1);
      },
      "搜索失败，请稍后重试。",
    );
  };

  const loadMore = () => {
    if (!result?.nextCursor || !config.data?.configured) return;
    const { keyword, publishTime, nextCursor } = result;
    void run(
      "more",
      async () => {
        const response = await ipc("wechat.discover", {
          keyword,
          publishTime,
          cursor: nextCursor,
        });
        const previousUrls = new Set(result.items.map((item) => item.url));
        const added = response.items.filter(
          (item) => !previousUrls.has(item.url),
        );
        setResult({
          ...result,
          items: [...result.items, ...added],
          nextCursor:
            response.nextCursor === nextCursor
              ? null
              : (response.nextCursor ?? null),
        });
        if (added.length && order === "match")
          changePage(Math.floor(result.items.length / pageSize) + 1);
        if (!added.length) notify("本次没有新增文章。", "info");
      },
      "加载更多文章失败，请稍后重试。",
    );
  };

  const importItem = (url: string) => {
    void run(
      "import",
      async () => {
        setImporting(url);
        try {
          await onImport(url);
          notify("已打开本地草稿。", "success");
        } finally {
          setImporting("");
        }
      },
      "导入失败，请稍后重试。",
    );
  };
  const moreButton = result?.nextCursor ? (
    <Button
      size="compact"
      disabled={!!pending || !config.data?.configured}
      onClick={loadMore}
    >
      {pending === "more" ? "加载中…" : "加载更多文章"}
    </Button>
  ) : null;

  return (
    <section
      className="wechat-discovery"
      hidden={!active}
      aria-label="公众号发现爆款"
    >
      <Panel className="wechat-discovery-search">
        <form
          className="wechat-discovery-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <SearchField
            label="公众号文章关键词"
            placeholder="输入关键词，例如 网盘资料、效率工具"
            value={draft.value.keyword}
            onChange={(value) => draft.update({ keyword: value.slice(0, 100) })}
          />
          <Select
            aria-label="发布时间范围"
            value={draft.value.publishTime}
            items={Object.entries(periods).map(([value, label]) => ({
              value,
              label,
            }))}
            disabled={!!pending}
            onValueChange={(value) =>
              draft.update({ publishTime: period.parse(value) })
            }
          />
          <Button
            type="submit"
            primary
            disabled={!!pending || !keyword || !config.data?.configured}
          >
            <Search size={15} />
            {pending === "search" ? "搜索中…" : "搜索公众号文章"}
          </Button>
        </form>
        <small>
          搜索或加载更多每次 {wechatDiscoveryRequestUsd} 美元（TikHub）。
        </small>
      </Panel>
      <QueryError
        error={config.error}
        loading={config.loading}
        onRetry={config.reload}
      />
      {draft.error ? (
        <DataState kind="error" compact title="关键词暂存失败">
          {draft.error}
        </DataState>
      ) : null}
      {error ? (
        <DataState kind="error" compact title="操作未完成">
          {error}
        </DataState>
      ) : null}
      {!config.data && !config.error ? (
        <LoadingState label="正在读取数据源配置…" compact />
      ) : null}
      {config.data && !config.data.configured ? (
        <DataState
          kind="empty"
          compact
          title="连接 TikHub 后开始搜索"
          action={
            <Button size="compact" onClick={() => openSettings("sources")}>
              配置 TikHub
            </Button>
          }
        >
          公众号发现复用「内容数据源」里的 TikHub API Key。
        </DataState>
      ) : null}
      {result && items.length ? (
        <Panel
          className="wechat-discovery-results"
          aria-label="公众号文章搜索结果"
        >
          <div className="wechat-discovery-results-bar">
            <div className="wechat-discovery-result-summary" aria-live="polite">
              <strong>搜索结果</strong>
              <span title={result.keyword}>
                「{result.keyword}」 · {periods[result.publishTime]} ·{" "}
                {items.length} 篇
              </span>
              {pending === "search" ? <Loading label="正在搜索…" /> : null}
            </div>
            <Select
              aria-label="结果排序"
              value={order}
              items={[
                { value: "match", label: "匹配顺序" },
                { value: "newest", label: "发布时间优先" },
              ]}
              disabled={!!pending}
              onValueChange={(value) => {
                setOrder(value === "newest" ? "newest" : "match");
                changePage(1);
              }}
            />
          </div>
          <div className="wechat-discovery-table-scroll" ref={scroll}>
            <table className="wechat-discovery-table">
              <thead>
                <tr>
                  <th scope="col">文章</th>
                  <th
                    scope="col"
                    className="wechat-discovery-date"
                    aria-sort={order === "newest" ? "descending" : undefined}
                  >
                    发布时间
                  </th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((article) => (
                  <tr key={article.url}>
                    <td className="wechat-discovery-article">
                      <strong title={article.title}>{article.title}</strong>
                      {article.accountName ? (
                        <small>{article.accountName}</small>
                      ) : null}
                      {article.summary ? (
                        <small
                          className="wechat-discovery-summary"
                          title={article.summary}
                        >
                          {article.summary}
                        </small>
                      ) : null}
                    </td>
                    <td className="wechat-discovery-date">
                      {dateValue(article.publishedAt)
                        ? day.format(new Date(article.publishedAt!))
                        : "未提供"}
                    </td>
                    <td>
                      <div className="wechat-discovery-row-actions">
                        <Button
                          quiet
                          size="compact"
                          onClick={() => {
                            void ipc("system.external", {
                              url: article.url,
                            }).catch((cause: unknown) =>
                              notify(
                                cause instanceof Error
                                  ? cause.message
                                  : "无法打开原文。",
                                "error",
                              ),
                            );
                          }}
                        >
                          <ExternalLink size={14} /> 原文
                        </Button>
                        <Button
                          size="compact"
                          disabled={!!pending}
                          onClick={() => importItem(article.url)}
                        >
                          <Download size={14} />{" "}
                          {importing === article.url ? "导入中…" : "导入草稿"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {items.length > pageSize || moreButton ? (
            <div className="wechat-discovery-paging">
              {items.length > pageSize ? (
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={items.length}
                  onPageChange={changePage}
                  disabled={!!pending}
                  label="文章搜索结果分页"
                />
              ) : null}
              {moreButton}
            </div>
          ) : null}
        </Panel>
      ) : pending === "search" ? (
        <LoadingState label="正在搜索公众号文章…" layout="list" />
      ) : result ? (
        <DataState
          kind="empty"
          title="没有找到公众号文章"
          icon={Search}
          action={moreButton}
        >
          试试更具体的主题或公众号名称。
        </DataState>
      ) : config.data?.configured ? (
        <Empty title="从一个关键词开始" icon={Search}>
          按主题查找公众号文章，可查看原文或导入草稿。
        </Empty>
      ) : null}
    </section>
  );
}
