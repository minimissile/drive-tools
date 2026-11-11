import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { TiebaAnalysisFollowedPage } from "../../shared/tieba-analysis";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Button, Empty, Loading, LoadingState } from "../ui/primitives";

const displaySize = 12;
type PublicPage = Extract<TiebaAnalysisFollowedPage, { visibility: "public" }>;

export function FollowedForums({ uid }: { uid: string }) {
  const { command } = useAppActions();
  const [result, setResult] = useState<TiebaAnalysisFollowedPage>();
  const [displayPage, setDisplayPage] = useState(1);
  const [request, setRequest] = useState({ page: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const lastSuccess = useRef(0);

  useEffect(() => {
    let active = true;
    // Delay by one turn so a discarded mount does not contact Tieba.
    const timer = setTimeout(() => {
      void ipc("tieba.analysis.followedForums", { uid, page: request.page })
        .then((next) => {
          if (!active) return;
          lastSuccess.current = request.page;
          setResult((previous) => {
            if (next.visibility === "restricted" || request.page === 1)
              return next;
            const old =
              previous?.visibility === "public" ? previous.forums : [];
            const forums = new Map(old.map((forum) => [forum.id, forum]));
            for (const forum of next.forums) forums.set(forum.id, forum);
            return {
              ...next,
              forums: [...forums.values()],
            } satisfies PublicPage;
          });
        })
        .catch((cause: unknown) => {
          if (!active) return;
          const message =
            cause instanceof Error ? cause.message : "请稍后重试。";
          setError(
            /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
              ? "请在顶部点击「应用更新并重启」，然后重试读取。"
              : message,
          );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [uid, request]);

  function load(page: number) {
    setLoading(true);
    setError("");
    setRequest({ page });
  }

  if (result?.visibility === "restricted")
    return <Empty title="该用户的关注列表未向公众开放" compact />;

  return (
    <>
      <QueryError
        error={error}
        title="暂时无法读取关注贴吧"
        onRetry={() => load(request.page)}
      />
      {!result && loading ? (
        <LoadingState label="正在读取关注贴吧…" compact />
      ) : null}
      {result?.visibility === "public" ? (
        <>
          <div className="tieba-analysis-toolbar">
            <small className="muted" role="status">
              已读取 {result.forums.length} 个关注贴吧
            </small>
            {loading ? (
              <Loading label="正在加载更多…" />
            ) : result.hasMore && !error ? (
              <Button
                size="compact"
                onClick={() => load(lastSuccess.current + 1)}
              >
                加载更多关注贴吧
              </Button>
            ) : null}
          </div>
          {result.forums.length ? (
            <>
              <ul className="tieba-followed-forums" aria-label="关注贴吧列表">
                {result.forums
                  .slice(
                    (displayPage - 1) * displaySize,
                    displayPage * displaySize,
                  )
                  .map((forum) => (
                    <li key={forum.id}>
                      <Button
                        quiet
                        size="compact"
                        className="tieba-analysis-link"
                        onClick={() =>
                          void command("system.external", { url: forum.url })
                        }
                      >
                        <span>{forum.name}</span>
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </Button>
                      {forum.level !== null ? (
                        <small className="muted">{forum.level} 级</small>
                      ) : null}
                    </li>
                  ))}
              </ul>
              <Pagination
                page={displayPage}
                pageSize={displaySize}
                total={result.forums.length}
                onPageChange={setDisplayPage}
                label="关注贴吧分页"
              />
            </>
          ) : (
            <Empty title="公开关注列表为空" compact />
          )}
        </>
      ) : null}
    </>
  );
}
