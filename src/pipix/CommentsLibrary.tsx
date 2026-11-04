import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { Button, Empty, LoadingState, Notice } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { QueryError } from "../ui/QueryError";
import { Pagination } from "../ui/Pagination";
import { updateSelection } from "../lib/selection";

export function PipixCommentsLibrary({
  sourceId,
  disabled = false,
  onAttach,
}: {
  sourceId: string;
  disabled?: boolean;
  onAttach?(ids: string[]): Promise<void>;
}) {
  const [page, setPage] = useState(1),
    [labeledOnly, setLabeledOnly] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const query = useIpcQuery(
    "pipix.comments",
    { sourceId, page, labeledOnly },
    { keepPrevious: true },
  );
  const usage = useIpcQuery("pipix.requestPolicy", undefined, {
    keepPrevious: true,
  });
  const { notify } = useAppActions();
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const action = async (fn: () => Promise<unknown>, message: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setConfirmed(false);
    setError("");
    try {
      await fn();
      query.reload();
      usage.reload();
      notify(message, "success");
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "操作未完成，请查看保存的响应",
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const data = query.data;
  return (
    <details className="supply-details pipix-comment-library">
      <summary>完整本地评论库与补采{data ? ` · ${data.total}条` : ""}</summary>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!data && !query.error ? (
        <LoadingState compact label="正在读取本地评论…" />
      ) : null}
      {data ? (
        <>
          <p className="supply-muted">
            已归档 {data.responses} 页 · {data.total} 条文字评论，可用
            {data.usableTotal}条、已过滤{data.excluded}条 · 来源标注神评{" "}
            {data.labeled} 条{data.hasMore ? " · 尚有后续评论" : ""}
            。文字评论整页入库，纯媒体评论仅保留原始响应。
          </p>
          {data.issue ? <Notice warning>{data.issue}</Notice> : null}
          <CheckboxField
            label="只看来源明确标注的神评"
            checked={labeledOnly}
            onChange={(event) => {
              setLabeledOnly(event.target.checked);
              setPage(1);
            }}
          />
          {data.items.length ? (
            <div className="supply-comments">
              {data.items.map((comment) => (
                <div className="supply-comment" key={comment.id}>
                  {onAttach ? (
                    <CheckboxField
                      label={
                        <>
                          <span>{comment.text}</span>
                          <small>
                            {comment.author} · {comment.likes ?? "未知"}赞 ·{" "}
                            {comment.label || "未标注神评"}
                          </small>
                        </>
                      }
                      checked={selected.includes(comment.id)}
                      disabled={disabled || busy}
                      onChange={(event) =>
                        setSelected((old) =>
                          updateSelection(
                            old,
                            [comment.id],
                            event.target.checked,
                            50,
                          ),
                        )
                      }
                    />
                  ) : (
                    <>
                      <p>{comment.text}</p>
                      <small>
                        {comment.author} · {comment.label || "未标注神评"}
                      </small>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title={
                labeledOnly
                  ? "本地没有来源明确标注的神评"
                  : data.needsAttention
                    ? "评论响应待核对"
                    : data.total && !data.usableTotal
                      ? "已归档评论均命中使用过滤词"
                      : "本地还没有文字评论"
              }
            >
              不会生成评论或把高赞评论自动改称神评。
            </Empty>
          )}
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={labeledOnly ? data.labeled : data.usableTotal}
            onPageChange={setPage}
            label="本地评论库分页"
          />
          {onAttach ? (
            <Button
              size="compact"
              disabled={disabled || busy || !selected.length}
              onClick={() => void onAttach(selected)}
            >
              加入选材快照 · {selected.length}
            </Button>
          ) : null}
          <div className="supply-comment-requests">
            <QueryError
              error={usage.error}
              loading={usage.loading}
              onRetry={usage.reload}
            />
            <small className="supply-muted">
              {usage.data
                ? `今日剩余 ${usage.data.remainingToday} 次；每次操作最多请求一页，服务商可能计费。`
                : usage.error
                  ? "请求上限暂不可用，补采已禁用"
                  : "正在读取请求上限"}
            </small>
            <CheckboxField
              label="授权本次评论请求 · 最多1次"
              checked={confirmed}
              disabled={disabled || busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <div className="row">
              <Button
                size="compact"
                disabled={
                  disabled ||
                  busy ||
                  !confirmed ||
                  !usage.data?.remainingToday ||
                  (!!data.responses && !data.hasMore && !data.needsAttention)
                }
                onClick={() =>
                  void action(
                    () =>
                      ipc("pipix.fetchComments", { sourceId, confirmed: true }),
                    "评论请求已归档，本地数据已更新",
                  )
                }
              >
                {data.hasMore ? "补采下一页评论" : "补采评论"}
              </Button>
              <Button
                size="compact"
                disabled={busy}
                onClick={() =>
                  void action(
                    () => ipc("pipix.reindexComments", { sourceId }),
                    "已重建本地评论索引，没有发出新请求",
                  )
                }
              >
                重建评论索引
              </Button>
            </div>
            {data.responses ? (
              <Button
                size="compact"
                disabled={
                  disabled || busy || !confirmed || !usage.data?.remainingToday
                }
                onClick={() =>
                  void action(
                    () =>
                      ipc("pipix.fetchComments", {
                        sourceId,
                        refresh: true,
                        confirmed: true,
                      }),
                    "已重新请求评论第一页，旧响应仍保留",
                  )
                }
              >
                明确重新请求第一页 · 可能重复计费
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {error ? <Notice danger>{error}</Notice> : null}
    </details>
  );
}
