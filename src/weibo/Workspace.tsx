import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import {
  Button,
  Empty,
  Field,
  Header,
  LoadingState,
  Notice,
  Panel,
  SearchField,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { formatTime } from "../lib/format";
import { WeiboComposer } from "../accounts/WeiboComposer";
import { WeiboTask } from "./Workflow";
import { IdeaEditor } from "./IdeaEditor";
import { WeiboAccountStatistics, WeiboStatistics } from "./Statistics";
import { takeWeiboWorkspaceIntent } from "./navigation";
import {
  weiboWorkspaceStatusLabels,
  type WeiboContentRow,
  type WeiboEditorialStyle,
} from "../../shared/weibo-workspace";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import "./workspace.css";

type Editor = { kind: "idea" | "marketing"; id: string } | null;
export default function WeiboWorkspace() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation(),
    { busy } = useAppActivity();
  const [intent] = useState(() => takeWeiboWorkspaceIntent(data!.dataPath));
  const filters = useLocalDraft(
    `weibo-workspace-filter:${data!.dataPath}`,
    {
      accountId: intent?.accountId ?? "",
      tab: intent?.tab ?? "content",
      status: "all",
      query: "",
      sort: "updated",
    },
    (raw) => ({
      ...z
        .object({
          accountId: z.string(),
          tab: z.enum(["content", "statistics", "style"]),
          status: z.string(),
          query: z.string(),
          sort: z.string(),
        })
        .parse(raw),
      ...(intent
        ? {
            accountId: intent.accountId,
            tab: intent.tab ?? "content",
            status: "all",
            query: "",
          }
        : {}),
    }),
  );
  const v = filters.value;
  const list = useIpcQuery("weiboWorkspace.list", undefined, {
    keepPrevious: true,
  });
  const accountsQuery = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
  });
  const accounts = useMemo(
    () => (accountsQuery.data ?? []).filter((a) => a.provider === "weibo"),
    [accountsQuery.data],
  );
  const selection = useLocalDraft<{ editor: Editor }>(
    `weibo-workspace-editor:${data!.dataPath}`,
    { editor: intent?.create ? { kind: "idea", id: "" } : null },
    (raw) => ({
      ...z
        .object({
          editor: z
            .object({
              kind: z.enum(["idea", "marketing"]),
              id: z.string().max(150),
            })
            .nullable(),
        })
        .parse(raw),
      ...(intent
        ? { editor: intent.create ? { kind: "idea" as const, id: "" } : null }
        : {}),
    }),
  );
  const editor = selection.value.editor;
  const setEditor = (editor: Editor) => selection.update({ editor });
  const [post, setPost] = useState<{ id: string; accountId: string } | null>(
    null,
  );
  const [statistics, setStatistics] = useState<WeiboContentRow | null>(null);
  const [variant, setVariant] = useState<WeiboContentRow | null>(null);
  const [page, setPage] = useState(1);
  const idea = useIpcQuery(
    "weiboWorkspace.get",
    { id: editor?.id ?? "" },
    { enabled: editor?.kind === "idea" && !!editor.id, keepPrevious: false },
  );
  const marketing = useIpcQuery(
    "weibo.get",
    { id: editor?.id ?? "" },
    {
      enabled: editor?.kind === "marketing",
      keepPrevious: true,
      revision: busy,
      invalidate: data?.drafts,
      refreshInterval: busy > 0 ? 2000 : 0,
    },
  );
  const needle = v.query.trim().toLocaleLowerCase();
  const rows = (list.data ?? []).filter(
    (r) =>
      (!v.accountId || r.accountId === v.accountId) &&
      (v.tab !== "statistics" || !!r.url) &&
      (v.status === "all" || v.tab === "statistics" || r.status === v.status) &&
      (!needle || `${r.title} ${r.text}`.toLocaleLowerCase().includes(needle)),
  );
  rows.sort((a, b) =>
    v.sort === "reads"
      ? (b.latest?.metrics.reads.value ?? -1) -
        (a.latest?.metrics.reads.value ?? -1)
      : v.sort === "planned"
        ? (a.plannedAt ?? "9999").localeCompare(b.plannedAt ?? "9999")
        : b.updatedAt.localeCompare(a.updatedAt),
  );
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / 12)));
  const reload = () => {
    list.reload();
    accountsQuery.reload();
  };
  const open = (row: WeiboContentRow) => {
    if (row.kind === "post") setPost({ id: row.id, accountId: row.accountId });
    else setEditor({ kind: row.kind, id: row.id });
  };
  const patch = (next: Partial<typeof v>) => {
    filters.update(next);
    setPage(1);
    setStatistics(null);
    setVariant(null);
  };
  const postAccount = accounts.find((a) => a.id === post?.accountId);
  return (
    <div className="weibo-content-workspace">
      <Header
        title="微博内容"
        description="选题、草稿、发布与复盘集中管理，按账号保持原有表达和资源分享排版。"
        action={
          <div className="row">
            <Button onClick={() => navigate("pipix-sources")}>公共素材</Button>
            <Button onClick={() => navigate("website-accounts")}>
              账号管理
            </Button>
            {!editor ? (
              <Button
                primary
                onClick={() => {
                  setEditor({ kind: "idea", id: "" });
                  setStatistics(null);
                }}
              >
                <Plus size={14} />
                新建内容
              </Button>
            ) : null}
          </div>
        }
      />
      {filters.error ? <Notice warning>{filters.error}</Notice> : null}
      {selection.error ? <Notice warning>{selection.error}</Notice> : null}
      <QueryError
        error={accountsQuery.error}
        loading={accountsQuery.loading}
        onRetry={accountsQuery.reload}
        title="微博账号读取失败"
      />
      {editor ? (
        <>
          <div className="row weibo-content-back">
            <Button
              onClick={() => {
                setEditor(null);
                reload();
              }}
            >
              <ArrowLeft size={14} />
              返回内容列表
            </Button>
            <span className="muted">
              {editor.kind === "marketing"
                ? "关联资源的稿件继续沿用本人分享核验与发布回执。"
                : "选题与文案会按窗口暂存，稍后可继续。"}
            </span>
          </div>
          {editor.kind === "marketing" ? (
            <>
              <QueryError
                error={marketing.error}
                loading={marketing.loading}
                onRetry={marketing.reload}
              />
              {marketing.data?.run.id === editor.id ? (
                <WeiboTask key={editor.id} detail={marketing.data} />
              ) : marketing.loading ? (
                <LoadingState label="正在读取资源稿件…" />
              ) : null}
            </>
          ) : (
            <>
              <QueryError
                error={idea.error}
                loading={idea.loading}
                onRetry={idea.reload}
              />
              {!editor.id || idea.data ? (
                <IdeaEditor
                  key={editor.id || "new"}
                  initial={idea.data ?? undefined}
                  accountId={v.accountId}
                  accounts={accounts}
                  onChanged={list.reload}
                  onSaved={(id) => {
                    if (!editor.id) setEditor({ kind: "idea", id });
                  }}
                  onDelivered={(target, accountId) => {
                    list.reload();
                    if (target.kind === "post") {
                      setEditor(null);
                      setPost({ id: target.id, accountId });
                    } else setEditor({ kind: "marketing", id: target.id });
                  }}
                />
              ) : idea.loading ? (
                <LoadingState label="正在读取选题…" />
              ) : null}
            </>
          )}
        </>
      ) : (
        <Tabs
          value={v.tab}
          onChange={(tab) => patch({ tab: tab as typeof v.tab })}
        >
          <TabList
            label="微博内容工作区"
            items={[
              ["content", "内容列表"],
              ["statistics", "数据复盘"],
              ["style", "账号文风"],
            ]}
          />
          <div className="weibo-content-toolbar">
            <Select
              aria-label="筛选微博账号"
              value={v.accountId}
              onValueChange={(accountId) => patch({ accountId })}
              items={[
                { value: "", label: "全部微博账号" },
                ...accounts.map((a) => ({
                  value: a.id,
                  label: a.nickname || a.alias,
                })),
              ]}
            />
            {v.tab !== "style" ? (
              <>
                <SearchField
                  label="搜索微博内容"
                  value={v.query}
                  onChange={(query) => patch({ query })}
                  placeholder="搜索选题或文案"
                />
                <Select
                  aria-label="微博内容排序"
                  value={v.sort}
                  onValueChange={(sort) => patch({ sort })}
                  items={[
                    { value: "updated", label: "最近更新" },
                    { value: "planned", label: "计划时间" },
                    { value: "reads", label: "已采集阅读量" },
                  ]}
                />
                <Button disabled={list.loading} onClick={reload}>
                  <RefreshCw size={14} />
                  刷新本地记录
                </Button>
              </>
            ) : null}
          </div>
          <TabPanel value={v.tab}>
            {v.tab === "statistics" ? (
              v.accountId ? (
                <details className="weibo-historical-statistics">
                  <summary>本人历史微博与统计快照</summary>
                  <WeiboAccountStatistics
                    key={v.accountId}
                    accountId={v.accountId}
                  />
                </details>
              ) : (
                <p className="muted">
                  选择一个微博账号，可粘贴历史微博链接或查看已采集的历史记录。
                </p>
              )
            ) : null}
            {variant ? (
              <VariantEditor
                key={variant.key}
                row={variant}
                accounts={accounts}
                onClose={() => setVariant(null)}
                onSaved={list.reload}
              />
            ) : null}
            {v.tab === "style" ? (
              v.accountId ? (
                <StylePanel key={v.accountId} accountId={v.accountId} />
              ) : (
                <Empty compact title="选择一个微博账号">
                  每个账号分别保存文风；新账号可用“资源目录分享”预设起步。
                </Empty>
              )
            ) : (
              <>
                {v.tab === "content" ? (
                  <div
                    className="weibo-content-status"
                    role="group"
                    aria-label="内容状态筛选"
                  >
                    {[
                      ["all", "全部"],
                      ...Object.entries(weiboWorkspaceStatusLabels),
                    ].map(([value, label]) => (
                      <Button
                        key={value}
                        quiet={v.status !== value}
                        size="compact"
                        aria-pressed={v.status === value}
                        onClick={() => patch({ status: value })}
                      >
                        {label}
                        {list.data
                          ? ` ${list.data.filter((r) => (!v.accountId || r.accountId === v.accountId) && (value === "all" || r.status === value)).length}`
                          : ""}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="muted">
                    按同口径快照比较内容，采集时间不同需分别判断。阅读量不是独立访客，链接点击未提供；此页刷新只读本地记录。
                  </p>
                )}
                <QueryError
                  error={list.error}
                  loading={list.loading}
                  onRetry={list.reload}
                  title="微博内容读取失败"
                />
                {!list.data && !list.error ? (
                  <LoadingState label="正在读取微博内容…" />
                ) : list.data && rows.length ? (
                  <>
                    <div className="table-scroll">
                      <table className="weibo-content-table">
                        <thead>
                          <tr>
                            <th>内容</th>
                            <th>目标账号</th>
                            <th>状态 / 计划</th>
                            {v.tab === "statistics" ? (
                              <>
                                <th>阅读量</th>
                                <th>转 / 评 / 赞</th>
                                <th>采集时间</th>
                              </>
                            ) : (
                              <th>最近更新</th>
                            )}
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows
                            .slice((currentPage - 1) * 12, currentPage * 12)
                            .map((row) => (
                              <tr key={row.key}>
                                <td>
                                  <button
                                    className="weibo-content-title"
                                    onClick={() => open(row)}
                                  >
                                    {row.title}
                                  </button>
                                  <small className="muted">
                                    {row.kind === "marketing"
                                      ? "关联资源"
                                      : row.kind === "post"
                                        ? "微博稿件"
                                        : "选题草稿"}
                                  </small>
                                </td>
                                <td>
                                  {accounts.find((a) => a.id === row.accountId)
                                    ?.nickname ||
                                    accounts.find((a) => a.id === row.accountId)
                                      ?.alias ||
                                    (row.accountId
                                      ? "原账号不可用"
                                      : "稍后选择")}
                                </td>
                                <td>
                                  {weiboWorkspaceStatusLabels[row.status]}
                                  {row.plannedAt ? (
                                    <small>
                                      {formatTime(row.plannedAt)}
                                      {Date.parse(row.plannedAt) <= Date.now()
                                        ? " · 已到计划时间"
                                        : ""}
                                    </small>
                                  ) : null}
                                </td>
                                {v.tab === "statistics" ? (
                                  <>
                                    <td>
                                      {row.latest?.metrics.reads.display ?? "—"}
                                    </td>
                                    <td>
                                      {["reposts", "comments", "likes"]
                                        .map(
                                          (k) =>
                                            row.latest?.metrics[k as "likes"]
                                              .display ?? "—",
                                        )
                                        .join(" / ")}
                                    </td>
                                    <td>
                                      {row.latest
                                        ? formatTime(row.latest.observedAt)
                                        : row.statisticsError || "尚未采集"}
                                    </td>
                                  </>
                                ) : (
                                  <td>{formatTime(row.updatedAt)}</td>
                                )}
                                <td>
                                  <div className="row">
                                    <Button
                                      size="compact"
                                      onClick={() => open(row)}
                                    >
                                      {row.url ? "查看内容" : "继续编辑"}
                                    </Button>
                                    {v.tab === "content" ? (
                                      <Button
                                        quiet
                                        size="compact"
                                        onClick={() => setVariant(row)}
                                      >
                                        另存版本
                                      </Button>
                                    ) : null}
                                    {row.url ? (
                                      <Button
                                        quiet
                                        size="compact"
                                        onClick={() => setStatistics(row)}
                                      >
                                        统计详情
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
                      page={currentPage}
                      pageSize={12}
                      total={rows.length}
                      onPageChange={setPage}
                      label="微博内容分页"
                    />
                  </>
                ) : list.data && !list.error ? (
                  <Empty
                    compact
                    title={
                      list.data.length
                        ? "没有符合筛选的内容"
                        : "先记下一条想分享的内容"
                    }
                    action={
                      <Button
                        onClick={() =>
                          list.data?.length
                            ? patch({ query: "", status: "all", accountId: "" })
                            : setEditor({ kind: "idea", id: "" })
                        }
                      >
                        {list.data.length ? "清除筛选" : "新建选题"}
                      </Button>
                    }
                  >
                    可先保存选题，稍后补充资料、文案与账号。已有直接发布草稿和资源任务会汇总到这里。
                  </Empty>
                ) : null}
                {statistics?.url ? (
                  <Panel
                    title={`数据详情 · ${statistics.title}`}
                    extra={
                      <Button quiet onClick={() => setStatistics(null)}>
                        收起
                      </Button>
                    }
                  >
                    <WeiboStatistics
                      accountId={statistics.accountId}
                      url={statistics.url}
                    />
                  </Panel>
                ) : null}
              </>
            )}
          </TabPanel>
        </Tabs>
      )}
      {post && postAccount ? (
        <WeiboComposer
          account={{ ...postAccount, key: `website:${postAccount.id}` }}
          initialPostId={post.id}
          onClose={() => {
            setPost(null);
            reload();
          }}
        />
      ) : post ? (
        <Notice warning>
          原微博账号暂不可用。请恢复账号后打开此稿件，记录仍保留。
          <Button onClick={() => setPost(null)}>关闭提示</Button>
        </Notice>
      ) : null}
    </div>
  );
}

function StylePanel({ accountId }: { accountId: string }) {
  const query = useIpcQuery(
    "weiboWorkspace.style",
    { accountId },
    { keepPrevious: false },
  );
  return (
    <>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {query.data ? (
        <StyleEditor
          key={accountId}
          accountId={accountId}
          style={query.data}
          onSaved={query.reload}
        />
      ) : query.loading ? (
        <LoadingState label="正在读取账号文风…" />
      ) : null}
    </>
  );
}
function StyleEditor({
  accountId,
  style,
  onSaved,
}: {
  accountId: string;
  style: WeiboEditorialStyle;
  onSaved(): void;
}) {
  const { data } = useAppData(),
    { command } = useAppActions();
  const form = useLocalDraft(
    `weibo-style-editor:${data!.dataPath}:${accountId}`,
    { instructions: style.instructions, linkFirst: style.linkFirst },
    (raw) =>
      z.object({ instructions: z.string(), linkFirst: z.boolean() }).parse(raw),
  );
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <Panel title="账号文风">
      <p className="muted">
        {style.custom
          ? "此账号已保存独立文风。"
          : "当前使用资源目录分享预设：名称与已知规格在前，链接紧随，简介简短，优先真实海报与封面。"}{" "}
        不会据此猜测资源事实，也不会改写已发布内容。
      </p>
      <Field label="表达与排版要求">
        <textarea
          aria-label="账号文风要求"
          rows={7}
          maxLength={5000}
          disabled={pending}
          value={form.value.instructions}
          onChange={(e) => form.update({ instructions: e.target.value })}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          disabled={pending}
          checked={form.value.linkFirst}
          onChange={(e) => form.update({ linkFirst: e.target.checked })}
        />
        核验后的本人链接放在标题之后、简介之前
      </label>
      {form.error ? <Notice warning>{form.error}</Notice> : null}
      <Button
        disabled={pending || form.value.instructions.trim().length < 10}
        onClick={async () => {
          setPending(true);
          try {
            const saved = await command(
              "weiboWorkspace.saveStyle",
              {
                accountId,
                ...form.value,
              },
              "此账号文风已保存。",
            );
            if (saved && alive.current) onSaved();
          } finally {
            if (alive.current) setPending(false);
          }
        }}
      >
        保存此账号文风
      </Button>
    </Panel>
  );
}

function VariantEditor({
  row,
  accounts,
  onClose,
  onSaved,
}: {
  row: WeiboContentRow;
  accounts: WebsiteAccountView[];
  onClose(): void;
  onSaved(): void;
}) {
  const { command } = useAppActions();
  const [accountId, setAccountId] = useState("");
  const [pending, setPending] = useState(false);
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <Panel
      title={`另存版本 · ${row.title}`}
      extra={
        <Button quiet onClick={onClose}>
          取消
        </Button>
      }
    >
      <p className="muted">
        保留原稿与回执，为目标账号保存独立草稿。不会沿用发布确认、排期或上传状态；配图在发布编辑器中核对。
      </p>
      <div className="row weibo-variant-toolbar">
        <Select
          aria-label="版本目标账号"
          value={accountId}
          disabled={pending}
          onValueChange={setAccountId}
          items={[
            { value: "", label: "选择微博账号" },
            ...accounts.map((a) => ({
              value: a.id,
              label: a.nickname || a.alias,
            })),
          ]}
        />
        <Button
          disabled={pending || !accountId}
          onClick={async () => {
            if (lock.current) return;
            lock.current = true;
            setPending(true);
            try {
              const next = await command(
                "weiboWorkspace.variant",
                { id: row.id, kind: row.kind, accountId },
                "独立版本已保存，可从内容列表继续编辑。",
              );
              if (next && alive.current) {
                onSaved();
                onClose();
              }
            } finally {
              lock.current = false;
              if (alive.current) setPending(false);
            }
          }}
        >
          保存独立草稿
        </Button>
      </div>
    </Panel>
  );
}
