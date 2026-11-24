import { useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { BarChart3, Search } from "lucide-react";
import { z } from "zod";
import { tiebaPostExposure, type TiebaAnalysisPage } from "../../shared/tieba-analysis";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData } from "../state";
import { ClearableField } from "../ui/ClearableField";
import {
  Button,
  Empty,
  Field,
  Header,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { TabList, TabPanel, Tabs } from "../ui/Tabs";
import { FollowedForums } from "./FollowedForums";
import { AnalysisPages } from "./AnalysisPages";
import { ForumPerformance } from "./ForumPerformance";
import { ForumPosts } from "./ForumPosts";
import { ThreadLookup } from "./ThreadLookup";
import { ResourceDiscovery } from "./ResourceDiscovery";
import { TiebaPotentialFormula } from "./TiebaPotentialFormula";
import {
  AnalysisThreadsTable,
  formatAnalysisCount,
} from "./AnalysisThreadsTable";
import "./analysis.css";

const draftSchema = z.object({
  target: z.string().max(2048),
  sort: z.enum(["views", "recent", "exposure"]).default("views"),
});
const number = new Intl.NumberFormat("zh-CN");
const modeSchema = z.object({ mode: z.enum(["user", "forum", "thread", "discovery"]) });
const pageSize = 10;
const sortItems = [
  { value: "views", label: "浏览量从高到低" },
  { value: "recent", label: "发布时间从新到旧" },
  { value: "exposure", label: "曝光潜力从高到低" },
];
type Result = TiebaAnalysisPage & { sourcePage: number; end: boolean; observedAt: number };
type Request = { target: string; page: number };
type Attempt = { request: Request; displayPage?: number };
type AnalysisHandle = { findAuthor(target: string): void };

export default function TiebaAnalysis() {
  const { data } = useAppData();
  return <AnalysisWorkspace key={data!.dataPath} workspace={data!.dataPath} />;
}

function AnalysisWorkspace({ workspace }: { workspace: string }) {
  const user = useRef<AnalysisHandle>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const selection = useLocalDraft<z.infer<typeof modeSchema>>(
    `tieba-analysis-mode:${workspace}`,
    { mode: "user" },
    modeSchema.parse,
  );
  const discovery = useIpcQuery("tieba.discovery.snapshot", undefined, {
    enabled: rulesOpen || selection.value.mode === "discovery",
    keepPrevious: true,
  });
  return (
    <div className="tieba-analysis" data-testid="tieba-analysis">
      <Tabs
        className="tieba-analysis-modes"
        value={selection.value.mode}
        onChange={(mode) => selection.update({ mode })}
      >
        <Header
          title="贴吧数据分析"
          description="按用户、贴吧或帖子查询公开主题帖、浏览量和互动数据。"
          action={
            <TabList
              label="贴吧查询方式"
              items={[
                ["user", "按用户查询"],
                ["forum", "按贴吧查询"],
                ["thread", "按帖子查询"],
                ["discovery", "资源发现"],
              ]}
            />
          }
        />
        <TiebaPotentialFormula
          open={rulesOpen}
          onOpenChange={setRulesOpen}
          snapshot={discovery}
          showQueryError={selection.value.mode !== "discovery"}
        />
        <TabPanel value="user" keepMounted>
          <Analysis workspace={workspace} ref={user} />
        </TabPanel>
        <TabPanel value="forum" keepMounted>
          <ForumPosts workspace={workspace} onFindAuthor={(target) => {
            selection.update({ mode: "user" });
            user.current?.findAuthor(target);
          }} />
        </TabPanel>
        <TabPanel value="thread" keepMounted>
          <ThreadLookup workspace={workspace} />
        </TabPanel>
        <TabPanel value="discovery">
          <ResourceDiscovery workspace={workspace} snapshot={discovery} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function Analysis({ workspace, ref }: { workspace: string; ref: Ref<AnalysisHandle> }) {
  const hintId = useId();
  const inputId = useId();
  const draft = useLocalDraft<z.output<typeof draftSchema>>(
    `tieba-analysis:${workspace}`,
    { target: "", sort: "views" },
    draftSchema.parse,
  );
  const [result, setResult] = useState<Result>();
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<"threads" | "performance" | "followed">(
    "threads",
  );
  const [followedUid, setFollowedUid] = useState<string>();
  const [pending, setPending] = useState<Request>();
  const [error, setError] = useState("");
  const lastRequest = useRef<Attempt | undefined>(undefined);
  const active = useRef(0);
  const lock = useRef(false);

  async function query(request: Request, displayPage?: number, replace = false) {
    if (lock.current && !replace) return;
    const token = ++active.current;
    lock.current = true;
    lastRequest.current = { request, displayPage };
    setPending(request);
    setError("");
    try {
      const next = await ipc("tieba.analysis.query", request);
      if (token !== active.current) return;
      if (request.page > 1 && next.uid !== result?.uid)
        throw new Error("贴吧返回的作者与当前查询不一致，请重试。");
      const observedAt = Date.now();
      const threads = new Map(
        request.page === 1 ? [] : result?.threads.map((post) => [post.id, post]),
      );
      const before = threads.size;
      for (const post of next.threads) threads.set(post.id, post);
      setResult((previous) => {
        const forums = new Map(
          (request.page > 1 ? (previous?.forums ?? []) : []).map((forum) => [
            forum.id,
            forum,
          ]),
        );
        for (const forum of next.forums ?? []) {
          const old = forums.get(forum.id);
          forums.set(forum.id, {
            ...forum,
            level: forum.level ?? old?.level ?? null,
            exposure: forum.exposure ?? old?.exposure ?? null,
          });
        }
        return {
          uid: next.uid,
          profileId:
            next.profileId ??
            (request.page > 1 ? (previous?.profileId ?? null) : null),
          author:
            next.author || (request.page > 1 ? (previous?.author ?? "") : ""),
          threads: [...threads.values()],
          ageYears:
            next.ageYears ?? (request.page > 1 ? previous?.ageYears : null),
          vip: next.vip ?? (request.page > 1 ? previous?.vip : null),
          forums: [...forums.values()],
          sourcePage: request.page,
          end: threads.size === before,
          observedAt,
        };
      });
      if (request.page === 1) {
        setPage(1);
        setTab("threads");
        setFollowedUid(undefined);
      } else if (displayPage !== undefined) {
        setPage(Math.min(displayPage, Math.max(1, Math.ceil(threads.size / pageSize))));
      }
    } catch (cause) {
      if (token !== active.current) return;
      const message =
        cause instanceof Error ? cause.message : "查询失败，请稍后重试。";
      setError(
        /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
          ? "请在顶部点击「应用更新并重启」，然后重试查询。"
          : message,
      );
    } finally {
      if (token === active.current) {
        lock.current = false;
        setPending(undefined);
      }
    }
  }

  useImperativeHandle(ref, () => ({
    findAuthor(target) {
      draft.update({ target });
      setResult(undefined);
      void query({ target, page: 1 }, undefined, true);
    },
  }));

  function more(displayPage?: number) {
    if (result && !result.end)
      void query({ target: `UID: ${result.uid}`, page: result.sourcePage + 1 }, displayPage);
  }

  const ordered = (result?.threads ?? []).toSorted((a, b) => {
    const recent = (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    if (draft.value.sort === "exposure" && result)
      return (tiebaPostExposure(b.views, b.publishedAt, result.observedAt) ?? -1) -
        (tiebaPostExposure(a.views, a.publishedAt, result.observedAt) ?? -1) || recent;
    return draft.value.sort === "views"
      ? (b.views ?? -1) - (a.views ?? -1) || recent
      : recent;
  });
  const known = ordered.filter((post) => post.views !== null);
  const totalViews = known.reduce((sum, post) => sum + post.views!, 0);
  const visible = ordered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="tieba-analysis-content">
      <Panel aria-label="查询公开主题帖">
        <form
          className="tieba-analysis-form"
          onSubmit={(event) => {
            event.preventDefault();
            const target = draft.value.target.trim();
            if (target) void query({ target, page: 1 });
          }}
        >
          <Field as="div" htmlFor={inputId} label="主页 ID、主页链接或主题帖链接">
            <ClearableField
              id={inputId}
              value={draft.value.target}
              onValueChange={(target) => draft.update({ target })}
              clearLabel="清除用户查询输入"
              placeholder="输入主页 ID，或粘贴贴吧链接"
              aria-describedby={hintId}
              maxLength={2048}
            />
          </Field>
          <Button
            primary
            type="submit"
            disabled={!!pending || !draft.value.target.trim()}
          >
            <Search size={15} />
            查询帖子
          </Button>
        </form>
        <small id={hintId} className="muted tieba-analysis-hint">
          可直接粘贴贴吧个人主页链接，也可用主题帖链接查询楼主。
        </small>
        {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      </Panel>

      <QueryError
        error={error}
        onRetry={() => {
          const attempt = lastRequest.current;
          if (attempt) void query(attempt.request, attempt.displayPage);
        }}
      />
      {!result && pending ? (
        <Panel><LoadingState label="正在查询公开主题帖…" layout="list" compact /></Panel>
      ) : null}
      {!result && !pending && !error ? (
        <Panel>
          <Empty icon={BarChart3} title="等待查询用户帖子" compact>
            输入主页 ID，或粘贴个人主页、主题帖链接开始查询。
          </Empty>
        </Panel>
      ) : null}
      {result ? (
        <Panel
          title="用户数据"
          className="tieba-analysis-results"
          extra={
            pending ? (
              <Loading
                label={pending.page === 1 ? "正在查询…" : "正在读取下一批帖子…"}
              />
            ) : null
          }
        >
          <div className="tieba-analysis-overview">
            <div>
              {result.author ? <strong>{result.author}</strong> : null}
              <small className="muted">
                {result.profileId
                  ? `主页 ID ${result.profileId}`
                  : `UID: ${result.uid}`}
              </small>
            </div>
            <div>
              <small className="muted">吧龄</small>
              <strong>
                {result.ageYears == null ? "未知" : `${result.ageYears} 年`}
              </strong>
            </div>
            <div>
              <small className="muted">贴吧 VIP</small>
              <strong>
                {result.vip == null ? "未知" : result.vip ? "是" : "否"}
              </strong>
            </div>
            <div>
              <small className="muted">已读取帖子</small>
              <strong>{number.format(ordered.length)} 篇</strong>
            </div>
            <div>
              <small className="muted">已读取帖子的浏览量</small>
              <strong>
                {formatAnalysisCount(known.length ? totalViews : null)}
              </strong>
              {known.length < ordered.length ? (
                <small className="muted">
                  {ordered.length - known.length} 篇浏览量未知
                </small>
              ) : null}
            </div>
          </div>
          <Tabs
            className="tieba-analysis-tabs"
            value={tab}
            onChange={(next) => {
              setTab(next);
              if (next === "followed") setFollowedUid(result.uid);
            }}
          >
            <TabList
              label="贴吧数据类型"
              items={[
                ["threads", "公开主题帖"],
                ["performance", "按贴吧统计"],
                ["followed", "关注贴吧"],
              ]}
            />
            <TabPanel value="threads">
              {visible.length ? (
                <>
                  <div className="tieba-analysis-toolbar">
                    <Select
                      aria-label="帖子排序"
                      disabled={!!pending}
                      items={sortItems}
                      value={draft.value.sort}
                      onValueChange={(value) => {
                        if (value === "views" || value === "recent" || value === "exposure")
                          draft.update({ sort: value });
                        setPage(1);
                      }}
                    />
                  </div>
                  <AnalysisPages
                    page={page}
                    pageSize={pageSize}
                    total={ordered.length}
                    onPageChange={(next) => {
                      if (next <= Math.ceil(ordered.length / pageSize)) setPage(next);
                      else more(next);
                    }}
                    label="公开主题帖分页"
                    partial={!result.end}
                    hasNextPage={!result.end || page < Math.ceil(ordered.length / pageSize)}
                    loading={!!pending}
                  >
                    <AnalysisThreadsTable
                      key={result.uid}
                      threads={visible}
                      scope="user"
                      observedAt={result.observedAt}
                    />
                  </AnalysisPages>
                </>
              ) : (
                <Empty
                  icon={BarChart3}
                  title="未找到可读取的公开主题帖"
                  compact
                >
                  请核对主页信息，或换一篇该用户发布的公开主题帖。
                </Empty>
              )}
            </TabPanel>
            <TabPanel value="performance" keepMounted>
              <ForumPerformance
                key={result.uid}
                workspace={workspace}
                threads={result.threads}
                forums={result.forums}
                onLoadMore={() => more()}
                partial={!result.end}
                loading={!!pending}
              />
            </TabPanel>
            <TabPanel value="followed" keepMounted>
              {followedUid === result.uid ? (
                <FollowedForums key={result.uid} uid={result.uid} />
              ) : null}
            </TabPanel>
          </Tabs>
        </Panel>
      ) : null}
    </div>
  );
}
