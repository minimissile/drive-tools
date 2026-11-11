import { useId, useRef, useState } from "react";
import { BarChart3, Search } from "lucide-react";
import { z } from "zod";
import type { TiebaAnalysisPage } from "../../shared/tieba-analysis";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData } from "../state";
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
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { TabList, TabPanel, Tabs } from "../ui/Tabs";
import { FollowedForums } from "./FollowedForums";
import { ForumPerformance } from "./ForumPerformance";
import { ForumPosts } from "./ForumPosts";
import {
  AnalysisThreadsTable,
  formatAnalysisCount,
} from "./AnalysisThreadsTable";
import "./analysis.css";

const draftSchema = z.object({
  target: z.string().max(2048),
  sort: z.enum(["views", "recent"]).default("views"),
});
const number = new Intl.NumberFormat("zh-CN");
const modeSchema = z.object({ mode: z.enum(["user", "forum"]) });
const pageSize = 12;
const sortItems = [
  { value: "views", label: "浏览量从高到低" },
  { value: "recent", label: "发布时间从新到旧" },
];
type Result = TiebaAnalysisPage & { sourcePage: number; end: boolean };
type Request = { target: string; page: number };

export default function TiebaAnalysis() {
  const { data } = useAppData();
  return <AnalysisWorkspace key={data!.dataPath} workspace={data!.dataPath} />;
}

function AnalysisWorkspace({ workspace }: { workspace: string }) {
  const selection = useLocalDraft<z.infer<typeof modeSchema>>(
    `tieba-analysis-mode:${workspace}`,
    { mode: "user" },
    modeSchema.parse,
  );
  return (
    <div className="tieba-analysis" data-testid="tieba-analysis">
      <Header
        title="贴吧数据分析"
        description="按用户或贴吧查询公开主题帖、浏览量和互动数据。"
      />
      <Tabs
        className="tieba-analysis-modes"
        value={selection.value.mode}
        onChange={(mode) => selection.update({ mode })}
      >
        <TabList
          label="贴吧查询方式"
          items={[
            ["user", "按用户查询"],
            ["forum", "按贴吧查询"],
          ]}
        />
        <TabPanel value="user" keepMounted>
          <Analysis workspace={workspace} />
        </TabPanel>
        <TabPanel value="forum" keepMounted>
          <ForumPosts workspace={workspace} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function Analysis({ workspace }: { workspace: string }) {
  const hintId = useId();
  const draft = useLocalDraft(
    `tieba-analysis:${workspace}`,
    { target: "", sort: "views" as "views" | "recent" },
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
  const lastRequest = useRef<Request | undefined>(undefined);
  const lock = useRef(false);

  async function query(request: Request) {
    if (lock.current) return;
    lock.current = true;
    lastRequest.current = request;
    setPending(request);
    setError("");
    try {
      const next = await ipc("tieba.analysis.query", request);
      if (request.page > 1 && next.uid !== result?.uid)
        throw new Error("贴吧返回的作者与当前查询不一致，请重试。");
      setResult((previous) => {
        const threads = new Map(
          request.page === 1
            ? []
            : previous?.threads.map((post) => [post.id, post]),
        );
        const before = threads.size;
        for (const post of next.threads) threads.set(post.id, post);
        return {
          uid: next.uid,
          profileId:
            next.profileId ??
            (request.page > 1 ? (previous?.profileId ?? null) : null),
          author:
            next.author || (request.page > 1 ? (previous?.author ?? "") : ""),
          threads: [...threads.values()],
          sourcePage: request.page,
          end: threads.size === before,
        };
      });
      if (request.page === 1) {
        setPage(1);
        setTab("threads");
        setFollowedUid(undefined);
      }
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "查询失败，请稍后重试。";
      setError(
        /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
          ? "请在顶部点击「应用更新并重启」，然后重试查询。"
          : message,
      );
    } finally {
      lock.current = false;
      setPending(undefined);
    }
  }

  const ordered = (result?.threads ?? []).toSorted((a, b) => {
    const recent = (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    return draft.value.sort === "views"
      ? (b.views ?? -1) - (a.views ?? -1) || recent
      : recent;
  });
  const known = ordered.filter((post) => post.views !== null);
  const totalViews = known.reduce((sum, post) => sum + post.views!, 0);
  const visible = ordered.slice((page - 1) * pageSize, page * pageSize);
  const loadMore = result?.end ? (
    <small className="muted" role="status">
      没有更多可读取的主题帖
    </small>
  ) : result ? (
    <Button
      disabled={!!pending}
      onClick={() =>
        void query({
          target: `UID: ${result.uid}`,
          page: result.sourcePage + 1,
        })
      }
    >
      加载更多帖子
    </Button>
  ) : null;

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
          <Field label="主页 ID、主页链接或主题帖链接">
            <input
              value={draft.value.target}
              onChange={(event) => draft.update({ target: event.target.value })}
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
          if (lastRequest.current) void query(lastRequest.current);
        }}
      />
      {!result && pending ? (
        <LoadingState label="正在查询公开主题帖…" layout="list" />
      ) : null}
      {!result && !pending && !error ? (
        <Panel>
          <Empty icon={BarChart3} title="输入用户或帖子后开始查询" compact>
            查询结果会在这里按浏览量排列。
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
                label={pending.page === 1 ? "正在查询…" : "正在加载更多…"}
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
                      items={sortItems}
                      value={draft.value.sort}
                      onValueChange={(value) => {
                        if (value === "views" || value === "recent")
                          draft.update({ sort: value });
                        setPage(1);
                      }}
                    />
                    {loadMore}
                  </div>
                  <AnalysisThreadsTable threads={visible} scope="user" />
                  <Pagination
                    page={page}
                    pageSize={pageSize}
                    total={ordered.length}
                    onPageChange={setPage}
                    label="公开主题帖分页"
                  />
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
                loadMore={loadMore}
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
