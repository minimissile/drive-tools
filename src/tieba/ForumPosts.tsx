import { useId, useRef, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { z } from "zod";
import {
  tiebaPostExposure,
  type TiebaAnalysisForumPage,
} from "../../shared/tieba-analysis";
import {
  tiebaForumInputName,
  tiebaForumNameSchema,
} from "../../shared/tieba-forums";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import { ClearableField } from "../ui/ClearableField";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { QueryError } from "../ui/QueryError";
import {
  Button,
  Empty,
  Field,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { formatForumExposure } from "./TiebaPotentialFormula";
import { AnalysisThreadsTable } from "./AnalysisThreadsTable";
import { AnalysisPages } from "./AnalysisPages";
import { ForumCacheResults } from "./ForumCacheResults";

const maxInputLength = 2000;
const draftSchema = z.object({ name: z.string().max(maxInputLength) });
type ForumRequest = {
  name: string;
  page: number;
  list: "published" | "replied";
};
const sortItems = [
  { value: "published", label: "发布时间从新到旧" },
  { value: "replied", label: "最近回复优先" },
  { value: "views", label: "浏览量从高到低（本页）" },
  { value: "exposure", label: "曝光潜力从高到低（本页）" },
];
type Sort = ForumRequest["list"] | "views" | "exposure";

export function ForumPosts({
  workspace,
  onFindAuthor,
}: {
  workspace: string;
  onFindAuthor(target: string): void;
}) {
  const inputId = useId();
  const cacheSwitchId = useId();
  const { command } = useAppActions();
  const validationId = useId();
  const draft = useLocalDraft(
    `tieba-analysis-forum:${workspace}`,
    { name: "" },
    draftSchema.parse,
  );
  const [result, setResult] = useState<
    TiebaAnalysisForumPage & {
      list: ForumRequest["list"];
      observedAt: number;
    }
  >();
  const [localSort, setLocalSort] = useState<"views" | "exposure">();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [wholeForum, setWholeForum] = useState(false);
  const [cacheName, setCacheName] = useState("");
  const submittedName = useRef("");
  const [cacheAction, setCacheAction] = useState(false);
  const [cacheError, setCacheError] = useState("");
  const [cacheRevision, setCacheRevision] = useState(0);
  const inFlight = useRef(false);
  const retry = useRef<ForumRequest | null>(null);
  const canChangePage = !!result && (result.page > 1 || result.hasMore);

  async function controlCache(
    name: string,
    action: "start" | "pause" | "restart",
  ) {
    setCacheAction(true);
    setCacheError("");
    try {
      await ipc("tieba.analysis.forumCacheControl", { name, action });
      setCacheRevision((revision) => revision + 1);
      return true;
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "操作失败，请重试。";
      setCacheError(
        /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
          ? "请在顶部点击「应用更新并重启」，然后重试。"
          : message,
      );
      return false;
    } finally {
      setCacheAction(false);
    }
  }

  function startCache(name: string) {
    setCacheName(name);
    void controlCache(name, "start");
  }

  async function toggleCache(enabled: boolean) {
    if (enabled) {
      setWholeForum(true);
      if (submittedName.current) startCache(submittedName.current);
    } else if (!cacheName || (await controlCache(cacheName, "pause"))) {
      setWholeForum(false);
      if (cacheName && result?.name.toLowerCase() !== cacheName.toLowerCase())
        void query({
          name: cacheName,
          page: 1,
          list: result?.list ?? "published",
        });
    }
  }

  async function query(input: ForumRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    retry.current = input;
    setError("");
    setPending(true);
    try {
      const next = await ipc("tieba.analysis.forumPosts", input);
      if (
        input.page !== next.page ||
        (input.page > 1 && next.id !== result?.id)
      )
        throw new Error("贴吧返回的页面与请求不一致，请重试。");
      setResult({ ...next, list: input.list, observedAt: Date.now() });
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "读取失败，请稍后重试。";
      setError(
        /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
          ? "请在顶部点击「应用更新并重启」，然后重试读取。"
          : message,
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function changeSort(sort: Sort) {
    if (!result) return;
    if (sort === "views" || sort === "exposure") {
      setLocalSort(sort);
    } else {
      setLocalSort(undefined);
      if (sort !== result.list)
        void query({ name: result.name, page: 1, list: sort });
    }
  }

  const visible =
    result && localSort
      ? result.threads.toSorted((a, b) => {
          if (localSort === "views") return (b.views ?? -1) - (a.views ?? -1);
          return (
            (tiebaPostExposure(b.views, b.publishedAt, result.observedAt) ??
              -1) -
            (tiebaPostExposure(a.views, a.publishedAt, result.observedAt) ?? -1)
          );
        })
      : (result?.threads ?? []);

  return (
    <div className="tieba-analysis-content">
      <Panel aria-label="查询吧内帖子">
        <form
          className="tieba-analysis-form"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const name = tiebaForumInputName(draft.value.name);
              submittedName.current = name;
              setValidationError("");
              if (wholeForum) startCache(name);
              else
                void query({
                  name,
                  page: 1,
                  list: result?.list ?? "published",
                });
            } catch (cause) {
              setValidationError(
                cause instanceof z.ZodError
                  ? (cause.issues[0]?.message ?? "吧名或首页链接无效。")
                  : cause instanceof Error
                    ? cause.message
                    : "吧名或首页链接无效。",
              );
            }
          }}
        >
          <Field as="div" htmlFor={inputId} label="吧名或贴吧首页链接">
            <ClearableField
              id={inputId}
              placeholder="例如：网盘资源，或粘贴贴吧首页链接"
              maxLength={maxInputLength}
              value={draft.value.name}
              clearLabel="清除贴吧查询输入"
              aria-invalid={!!validationError}
              aria-describedby={validationError ? validationId : undefined}
              onValueChange={(name) => {
                draft.update({ name });
                setValidationError("");
              }}
            />
          </Field>
          <Button
            primary
            type="submit"
            disabled={pending || cacheAction || !draft.value.name.trim()}
          >
            <Search size={15} />
            查询吧内帖子
          </Button>
          <div className="tieba-forum-cache-switch">
            <Switch
              id={cacheSwitchId}
              checked={wholeForum}
              disabled={cacheAction || pending}
              onCheckedChange={(enabled) => void toggleCache(enabled)}
            />
            <label htmlFor={cacheSwitchId}>整吧读取</label>
          </div>
        </form>
        {validationError ? (
          <Notice danger>
            <span id={validationId}>{validationError}</span>
          </Notice>
        ) : null}
        {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      </Panel>
      {wholeForum ? (
        <ForumCacheResults
          key={cacheName}
          name={cacheName}
          revision={cacheRevision}
          changing={cacheAction}
          actionError={cacheError}
          onControl={(action) => void controlCache(cacheName, action)}
          onFindAuthor={onFindAuthor}
        />
      ) : (
        <>
          <QueryError
            error={error}
            title="暂时无法读取吧内帖子"
            onRetry={() => {
              if (retry.current) void query(retry.current);
            }}
          />
          {!result && pending ? (
            <Panel>
              <LoadingState
                label="正在查询吧内公开主题帖…"
                layout="list"
                compact
              />
            </Panel>
          ) : null}
          {!result && !pending && !error ? (
            <Panel>
              <Empty icon={Search} title="等待查询吧内帖子" compact>
                输入吧名或粘贴贴吧首页链接，查看公开主题帖和浏览量。
              </Empty>
            </Panel>
          ) : null}
          {result ? (
            <Panel
              title={`${result.name} · 公开主题帖`}
              extra={
                pending ? (
                  <Loading label="正在读取帖子…" />
                ) : (
                  <Button
                    quiet
                    size="compact"
                    onClick={() =>
                      void command("system.external", { url: result.url })
                    }
                  >
                    打开贴吧 <ArrowUpRight size={14} aria-hidden="true" />
                  </Button>
                )
              }
            >
              <div className="tieba-analysis-toolbar">
                <Select
                  aria-label="吧内帖子排序"
                  items={sortItems}
                  value={localSort ?? result.list}
                  disabled={pending}
                  onValueChange={(sort) => {
                    if (
                      sort === "published" ||
                      sort === "replied" ||
                      sort === "views" ||
                      sort === "exposure"
                    )
                      changeSort(sort);
                  }}
                />
                <p className="tieba-analysis-exposure">
                  本页贴吧曝光潜力{" "}
                  <strong>{formatForumExposure(result.exposure, "day")}</strong>
                  {result.exposure ? ` · ${result.exposure.sample} 篇样本` : ""}
                </p>
              </div>
              <AnalysisPages
                page={result.page}
                pageSize={10}
                pageCount={result.totalPages}
                hasNextPage={result.hasMore}
                loading={pending}
                label="吧内帖子分页"
                summary={`第 ${result.page}${result.totalPages ? ` / ${result.totalPages}` : ""} 页 · 本页 ${visible.length} 篇`}
                onPageChange={(page) => {
                  if (page === result.page) return;
                  const parsed = tiebaForumNameSchema.safeParse(result.name);
                  if (parsed.success)
                    void query({ name: parsed.data, page, list: result.list });
                }}
              >
                {visible.length ? (
                  <AnalysisThreadsTable
                    key={result.id}
                    threads={visible}
                    scope="forum"
                    observedAt={result.observedAt}
                    onFindAuthor={onFindAuthor}
                  />
                ) : (
                  <Empty title="本页没有可读取的公开主题帖" compact>
                    {canChangePage
                      ? "可以试试其他页。"
                      : "可以核对吧名，或查询另一个贴吧。"}
                  </Empty>
                )}
              </AnalysisPages>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}
