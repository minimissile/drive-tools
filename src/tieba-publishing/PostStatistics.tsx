import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  AlertCircle,
  ArrowUpRight,
  History,
  RefreshCw,
  Search,
} from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppData } from "../state";
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
import { Tooltip } from "../ui/Tooltip";
import { Dialog } from "../ui/Dialog";
import { Pagination } from "../ui/Pagination";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { updateSelection } from "../lib/selection";
import { formatTime } from "../lib/format";
import type {
  TiebaPostStat,
  TiebaPostStatsSnapshot,
} from "../../shared/tieba-post-stats";
import { postDelta, postNumber, publishingBackendPending } from "./view";

export function PostStatistics() {
  const { data } = useAppData();
  const { command, notify } = useAppActions();
  const query = useIpcQuery("tieba.postStats.snapshot", undefined, {
    keepPrevious: true,
  });
  const form = useLocalDraft(
    `panxu-tieba-post-stats-v1:${data!.dataPath}`,
    { accountId: "", url: "", selected: [] as string[], page: 1 },
    (value) =>
      z
        .object({
          accountId: z.string(),
          url: z.string(),
          selected: z
            .array(z.string().regex(/^[1-9]\d{0,19}$/))
            .max(20)
            .default([]),
          page: z.number().int().positive().default(1),
        })
        .parse(value),
  );
  const [working, setWorking] = useState(false);
  const selected = form.value.selected;
  const setSelected = (ids: string[]) => form.update({ selected: ids });
  const [historyId, setHistoryId] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const snapshot = query.data;
  const accountId = form.value.accountId || snapshot?.accounts[0]?.id || "";
  const busy = working || snapshot?.busy || false;
  const ownPosts =
    snapshot?.posts.filter((post) => post.accountId === accountId) ?? [];
  const posts = snapshot?.posts ?? [];
  const page = Math.min(
    form.value.page,
    Math.max(1, Math.ceil(posts.length / 20)),
  );
  const visible = posts.slice((page - 1) * 20, page * 20);
  const selectable = visible.filter((post) => post.accountId === accountId);
  const selectedValid = selected.filter((id) =>
    ownPosts.some((post) => post.threadId === id),
  );
  const history = posts.find((post) => post.id === historyId);
  const run = async (
    action: () => Promise<TiebaPostStatsSnapshot | undefined>,
  ) => {
    setWorking(true);
    try {
      const result = await action();
      if (result && alive.current) {
        query.setData(result);
        const outcome = result.refreshResult;
        notify(
          outcome
            ? `读取完成 ${outcome.succeeded.length} 篇，${outcome.excluded.length} 篇不在统计范围，${outcome.failed.length} 篇未完成。`
            : result.discoveryResult?.message ||
                result.message ||
                "官网读取已返回，请查看记录。",
          outcome?.failed.length
            ? outcome.succeeded.length
              ? "warning"
              : "error"
            : outcome?.excluded.length || !outcome?.succeeded.length
              ? "info"
              : "success",
        );
      }
    } finally {
      if (alive.current) setWorking(false);
    }
  };
  const ranking = posts
    .filter((post) => post.deltaViews !== null)
    .sort((a, b) => (b.deltaViews ?? 0) - (a.deltaViews ?? 0))
    .slice(0, 10);
  const result = snapshot?.refreshResult;
  const outcome = result
    ? `读取完成 ${result.succeeded.length} 篇，${result.excluded.length} 篇不在统计范围，${result.failed.length} 篇未完成。`
    : "";
  return (
    <div className="tieba-post-statistics">
      <Panel
        className="tieba-post-stats-toolbar"
        extra={
          <div className="tieba-publishing-heading">
            <h2>帖子数据</h2>
            <Tooltip
              trigger={
                <Button
                  quiet
                  size="compact"
                  className="tieba-publishing-info"
                  aria-label="查看帖子统计范围"
                >
                  <AlertCircle size={16} />
                </Button>
              }
            >
              <strong>当前仅统计正文中包含网盘链接的帖子。</strong>
              <br />
              {snapshot?.scopeMessage ||
                "仅收录已核实的本人主题帖；标题、回帖和评论中的链接不计入。官网未返回的指标保留未知，首次读取只建立基线。"}
            </Tooltip>
          </div>
        }
      >
        <div className="tieba-post-stats-actions">
          <Field label="读取账号" as="div">
            <Select
              aria-label="帖子统计账号"
              value={accountId}
              disabled={busy}
              items={[
                { value: "", label: "选择贴吧账号", disabled: true },
                ...(snapshot?.accounts ?? []).map((account) => ({
                  value: account.id,
                  label: account.alias,
                })),
              ]}
              onValueChange={(accountId) => {
                form.update({ accountId, url: "", selected: [], page: 1 });
                if (query.data)
                  query.setData({
                    ...query.data,
                    discoveryResult: undefined,
                    refreshResult: undefined,
                  });
              }}
            />
          </Field>
          <Button
            disabled={busy || !accountId}
            onClick={() =>
              void run(() =>
                command("tieba.postStats.discover", { accountId, page: 1 }),
              )
            }
          >
            <Search size={14} />
            扫描本人帖子
          </Button>
          <Button
            disabled={
              busy ||
              !accountId ||
              (ownPosts.length > 20 && !selectedValid.length)
            }
            onClick={() =>
              void run(() =>
                command("tieba.postStats.refresh", {
                  accountId,
                  ...(selectedValid.length ? { threadIds: selectedValid } : {}),
                }),
              )
            }
          >
            <RefreshCw size={14} />
            {selectedValid.length
              ? `刷新所选 ${selectedValid.length} 篇`
              : ownPosts.length > 20
                ? "请先选择至多20篇"
                : "刷新已记录数据"}
          </Button>
        </div>
        <p className="muted">
          统计展示全部账号已收录的资源帖子。扫描和刷新只读取当前所选账号的官网数据。
        </p>
        {publishingBackendPending(query.error) ? (
          <Notice warning>
            贴吧帖子统计等待后端更新。请点击顶部“应用更新并重启”，完成后重试读取。
            <Button quiet size="compact" onClick={query.reload}>
              重试读取
            </Button>
          </Notice>
        ) : (
          <QueryError
            error={query.error}
            loading={query.loading}
            onRetry={query.reload}
          />
        )}
        {snapshot?.message ? <p className="muted">{snapshot.message}</p> : null}
        {outcome ? (
          <Notice warning={!!result?.failed.length}>{outcome}</Notice>
        ) : null}
        {result?.failed.length ? (
          <ul className="tieba-publishing-checks">
            {result.failed.map((item) => (
              <li key={item.threadId}>
                {item.threadId}：{item.message}
              </li>
            ))}
          </ul>
        ) : null}
        {result?.excluded.length ? (
          <details>
            <summary>查看未收录的原因（{result.excluded.length}篇）</summary>
            <ul className="tieba-publishing-checks">
              {result.excluded.map((item) => (
                <li key={item.threadId}>
                  {item.threadId}：{item.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {snapshot?.discoveryResult ? (
          <div className="row">
            <small>{snapshot.discoveryResult.message}</small>
            {snapshot.discoveryResult.nextPage ? (
              <Button
                size="compact"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    command("tieba.postStats.discover", {
                      accountId,
                      page: snapshot.discoveryResult!.nextPage!,
                    }),
                  )
                }
              >
                继续扫描下一页
              </Button>
            ) : null}
          </div>
        ) : null}
      </Panel>
      {!snapshot && !query.error ? (
        <LoadingState label="正在读取帖子统计…" />
      ) : snapshot ? (
        <>
          <div
            className="tieba-post-stats-metrics"
            aria-label="资源帖子统计概览"
          >
            {[
              {
                label: "已收录帖子",
                value: snapshot.summary.trackedPosts,
                delta: undefined,
              },
              {
                label: "总浏览",
                value: snapshot.summary.views,
                delta: snapshot.summary.deltaViews,
              },
              {
                label: "总回复",
                value: snapshot.summary.replies,
                delta: snapshot.summary.deltaReplies,
              },
              {
                label: "总获赞",
                value: snapshot.summary.likes,
                delta: snapshot.summary.deltaLikes,
              },
            ].map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{postNumber(item.value)}</strong>
                {item.delta !== undefined ? (
                  <small data-positive={(item.delta ?? 0) > 0 || undefined}>
                    {postDelta(item.delta)}
                  </small>
                ) : (
                  <small>正文含网盘链接</small>
                )}
              </div>
            ))}
          </div>
          <p className="muted tieba-post-stats-baseline">
            增量比较每篇帖子最近两次有效读取，各帖时间可能不同；首次读取暂无增量。最近读取：
            {snapshot.summary.lastRefreshedAt
              ? formatTime(snapshot.summary.lastRefreshedAt)
              : "尚未读取"}
            。
          </p>
          <Panel
            title="帖子浏览增量排行"
            extra={<small>最近两次读取 · 前10篇</small>}
          >
            {ranking.length ? (
              <ol className="tieba-post-stats-ranking">
                {ranking.map((post, index) => (
                  <li key={post.id}>
                    <span className="tieba-post-rank-number">{index + 1}</span>
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          void command("system.external", { url: post.url })
                        }
                      >
                        {post.title}
                        <ArrowUpRight size={13} />
                      </button>
                      <small>
                        {post.forumName} ·{" "}
                        {post.previousCheckedAt
                          ? formatTime(post.previousCheckedAt)
                          : "—"}{" "}
                        → {formatTime(post.checkedAt)}
                      </small>
                    </div>
                    <strong
                      data-positive={(post.deltaViews ?? 0) > 0 || undefined}
                    >
                      {postDelta(post.deltaViews)} 浏览
                    </strong>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty compact title="还没有可比较的浏览增量">
                完成首次读取后，再次刷新同一帖子可建立对比；官网未提供浏览数的帖子不进入此排行。
              </Empty>
            )}
          </Panel>
          <Panel
            title="帖子明细"
            extra={
              <small>{posts.length} 篇 · 勾选后按账号刷新，最多20篇</small>
            }
          >
            {posts.length ? (
              <>
                <div className="tieba-post-stats-table-wrap">
                  <table
                    className="tieba-post-stats-table"
                    aria-label="含网盘链接的本人帖子"
                  >
                    <thead>
                      <tr>
                        <th>
                          <SelectionCheckbox
                            aria-label="选择当前账号本页帖子"
                            selected={
                              selectable.filter((post) =>
                                selectedValid.includes(post.threadId),
                              ).length
                            }
                            total={selectable.length}
                            disabled={busy || !selectable.length}
                            onChange={(event) =>
                              setSelected(
                                updateSelection(
                                  selectedValid,
                                  selectable.map((post) => post.threadId),
                                  event.target.checked,
                                  20,
                                ),
                              )
                            }
                          />
                        </th>
                        <th>帖子 / 贴吧</th>
                        <th>浏览 / 增量</th>
                        <th>回复 / 获赞</th>
                        <th>读取时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((post) => (
                        <tr key={post.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`选择帖子 ${post.title}`}
                              checked={selectedValid.includes(post.threadId)}
                              disabled={
                                busy ||
                                post.accountId !== accountId ||
                                (!selectedValid.includes(post.threadId) &&
                                  selectedValid.length >= 20)
                              }
                              onChange={(event) =>
                                setSelected(
                                  updateSelection(
                                    selectedValid,
                                    [post.threadId],
                                    event.target.checked,
                                    20,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td>
                            <strong>{post.title}</strong>
                            <small>
                              {post.forumName} ·{" "}
                              {snapshot.accounts.find(
                                (account) => account.id === post.accountId,
                              )?.alias ?? "原账号"}
                            </small>
                            {post.message ? (
                              <small>{post.message}</small>
                            ) : null}
                          </td>
                          <td>
                            {postNumber(post.views)}
                            <small>{postDelta(post.deltaViews)}</small>
                          </td>
                          <td>
                            {postNumber(post.replies)} /{" "}
                            {postNumber(post.likes)}
                          </td>
                          <td>{formatTime(post.checkedAt)}</td>
                          <td>
                            <Button
                              quiet
                              size="compact"
                              onClick={() => setHistoryId(post.id)}
                            >
                              <History size={13} />
                              历史
                            </Button>
                            <Button
                              quiet
                              size="compact"
                              onClick={() =>
                                void command("system.external", {
                                  url: post.url,
                                })
                              }
                            >
                              官网
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={page}
                  pageSize={20}
                  total={posts.length}
                  onPageChange={(page) => form.update({ page })}
                  label="资源帖子分页"
                />
              </>
            ) : (
              <Empty compact title="还没有符合范围的帖子">
                可扫描本人已发主题，或导入准确的官网主题链接。仅在核实本人作者及首帖网盘链接后收录。
              </Empty>
            )}
          </Panel>
          <Panel title="导入已有帖子" extra={<small>只读核验，不会发帖</small>}>
            <div className="tieba-post-stats-import">
              <Field label="官网主题链接">
                <input
                  aria-label="导入本人贴吧主题链接"
                  value={form.value.url}
                  disabled={busy}
                  onChange={(event) => form.update({ url: event.target.value })}
                  placeholder="https://tieba.baidu.com/p/…"
                />
              </Field>
              <Button
                disabled={busy || !accountId || !form.value.url.trim()}
                onClick={() =>
                  void run(() =>
                    command("tieba.postStats.import", {
                      accountId,
                      url: form.value.url,
                    }),
                  )
                }
              >
                核验并导入
              </Button>
            </div>
          </Panel>
        </>
      ) : null}
      {history ? (
        <PostHistory post={history} onClose={() => setHistoryId("")} />
      ) : null}
    </div>
  );
}
function PostHistory({
  post,
  onClose,
}: {
  post: TiebaPostStat;
  onClose(): void;
}) {
  return (
    <Dialog
      title="帖子数据历史"
      onClose={onClose}
      className="tieba-post-history-dialog"
    >
      <p>
        <strong>{post.title}</strong>
      </p>
      <p className="muted">{post.forumName} · 仅列出官网实际取得的读数</p>
      <div className="tieba-post-stats-table-wrap">
        <table className="tieba-post-stats-table" aria-label="帖子官网读数历史">
          <thead>
            <tr>
              <th>读取时间</th>
              <th>浏览</th>
              <th>回复</th>
              <th>获赞</th>
            </tr>
          </thead>
          <tbody>
            {post.history.map((item, index) => (
              <tr key={`${item.checkedAt}:${index}`}>
                <td>{formatTime(item.checkedAt)}</td>
                <td>{postNumber(item.views)}</td>
                <td>{postNumber(item.replies)}</td>
                <td>{postNumber(item.likes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
