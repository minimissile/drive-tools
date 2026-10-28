import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Pagination } from "../ui/Pagination";
import { PipixDetail } from "./PipixDetail";
import { PipixDiscovery } from "./PipixDiscovery";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import "./pipix.css";

type Result = {
  text: string;
  error?: string;
  title?: string;
  pending?: boolean;
};
export function PipixSources({
  workspace,
  onOpenWeibo,
}: {
  workspace: string;
  onOpenWeibo(account: WebsiteAccountView, postId: string): void;
}) {
  const query = useIpcQuery("pipix.list", undefined, {
    keepPrevious: true,
    refreshInterval: 3000,
  });
  const draft = useLocalDraft(
    `panxu-pipix-links-v1:${workspace}`,
    { text: "" },
    (raw) => z.object({ text: z.string() }).parse(raw),
  );
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [entry, setEntry] = useState<"discover" | "links">("discover");
  const [selected, setSelected] = useState(""),
    [page, setPage] = useState(1),
    [collecting, setCollecting] = useState(false),
    [results, setResults] = useState<Result[]>([]),
    [error, setError] = useState(""),
    [processed, setProcessed] = useState(0);
  const alive = useRef(true),
    stop = useRef(false),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current = true;
    };
  }, []);
  const collect = async (lines: string[], retryIndices?: number[]) => {
    if (lock.current || busy || discovering) return;
    if (!lines.length || lines.length > 20) {
      setError("请填写 1–20 行分享链接，每行一条。");
      return;
    }
    lock.current = true;
    stop.current = false;
    setCollecting(true);
    const indices = retryIndices ?? lines.map((_, i) => i);
    setProcessed(0);
    setResults((old) =>
      retryIndices
        ? old.map((v, i) => (indices.includes(i) ? { text: v.text } : v))
        : lines.map((text) => ({ text })),
    );
    setError("");
    try {
      for (const [position, text] of lines.entries()) {
        if (stop.current) break;
        const index = indices[position];
        const update = (result: Result) => {
          if (alive.current)
            setResults((old) => old.map((v, i) => (i === index ? result : v)));
        };
        update({ text, pending: true });
        try {
          const source = await ipc("pipix.collect", { text });
          update({ text, title: source.text.slice(0, 60) || source.id });
          if (alive.current) {
            setSelected(source.id);
            query.reload();
          }
        } catch (e) {
          update({
            text,
            error: e instanceof Error ? e.message : "采集失败，请重试。",
          });
        }
        if (alive.current) setProcessed(position + 1);
      }
    } finally {
      lock.current = false;
      if (alive.current) setCollecting(false);
    }
  };
  const sources = query.data,
    source = sources?.find((v) => v.id === selected) ?? sources?.[0];
  const actualPage = Math.min(
    page,
    Math.max(1, Math.ceil((sources?.length ?? 0) / 8)),
  );
  return (
    <div className="pipix-layout">
      <div className="pipix-sidebar">
        <Panel title="发现与采集">
          <Tabs<"discover" | "links"> value={entry} onChange={setEntry}>
            <TabList
              label="皮皮虾采集方式"
              items={[
                ["discover", "获取数据列表"],
                ["links", "分享链接"],
              ]}
            />
            <TabPanel value="discover" keepMounted>
              <PipixDiscovery
                workspace={workspace}
                disabled={busy || collecting}
                collectedIds={sources?.map((v) => v.id) ?? []}
                onCollect={collect}
                onBusy={setDiscovering}
              />
            </TabPanel>
            <TabPanel value="links" keepMounted>
              <p className="muted">
                在皮皮虾复制分享链接或整段分享文案，每行一条，最多 20
                条。采集完成后挑选图文与评论。
              </p>
              <Field label="皮皮虾分享链接">
                <textarea
                  aria-label="皮皮虾分享链接"
                  className="pipix-links"
                  value={draft.value.text}
                  disabled={collecting || busy || discovering}
                  placeholder="https://h5.pipix.com/s/…/"
                  onChange={(e) => draft.update({ text: e.target.value })}
                />
              </Field>
              {draft.error ? <Notice danger>{draft.error}</Notice> : null}
              <div className="row">
                <Button
                  primary
                  disabled={
                    collecting ||
                    busy ||
                    discovering ||
                    !draft.value.text.trim()
                  }
                  onClick={() =>
                    void collect(
                      draft.value.text
                        .split(/\n/)
                        .map((v) => v.trim())
                        .filter(Boolean),
                    )
                  }
                >
                  {collecting ? `采集中 · 已完成 ${processed} 条` : "开始采集"}
                </Button>
              </div>
            </TabPanel>
          </Tabs>
          {error ? <Notice danger>{error}</Notice> : null}
          <div className="row">
            {collecting ? (
              <Button
                disabled={busy || discovering}
                onClick={() => {
                  stop.current = true;
                  setError("完成当前链接后停止，已采集的记录会保留。");
                }}
              >
                停止后续采集
              </Button>
            ) : results.some((v) => v.error) ? (
              <Button
                disabled={busy || discovering}
                onClick={() =>
                  void collect(
                    results.filter((v) => v.error).map((v) => v.text),
                    results.flatMap((v, i) => (v.error ? [i] : [])),
                  )
                }
              >
                重试失败项
              </Button>
            ) : null}
          </div>
          {collecting && entry === "discover" ? (
            <p className="muted" aria-live="polite">
              采集中 · 已完成 {processed} 条
            </p>
          ) : null}
          {results.length ? (
            <ul className="pipix-results" aria-live="polite">
              {results.map((v, i) => (
                <li key={i}>
                  <Status
                    kind={v.error ? "danger" : v.title ? "good" : "normal"}
                  >
                    {v.error
                      ? "失败"
                      : v.title
                        ? "已采集"
                        : v.pending
                          ? "采集中"
                          : "未采集"}
                  </Status>
                  <span className="pipix-result-copy">
                    <small title={v.text}>
                      第 {i + 1} 项 ·{" "}
                      {(v.text.match(/https?:\/\/\S+/)?.[0] ?? v.text).slice(
                        0,
                        220,
                      )}
                    </small>
                    <span>{v.error || v.title}</span>
                  </span>
                  {v.error ? (
                    <Button
                      size="compact"
                      disabled={collecting || busy || discovering}
                      aria-label={`重试第 ${i + 1} 项`}
                      onClick={() => void collect([v.text], [i])}
                    >
                      重试
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
        <Panel
          title={sources ? `已采集 · ${sources.length}` : "已采集素材"}
          extra={
            <Button size="compact" disabled={collecting} onClick={query.reload}>
              刷新列表
            </Button>
          }
        >
          <QueryError
            error={query.error}
            loading={query.loading}
            onRetry={query.reload}
          />
          {!sources && !query.error ? (
            <LoadingState label="正在读取采集记录…" />
          ) : null}
          {sources?.length ? (
            <>
              <div className="pipix-source-list">
                {sources
                  .slice((actualPage - 1) * 8, actualPage * 8)
                  .map((v) => (
                    <button
                      className="pipix-source-choice"
                      key={v.id}
                      disabled={collecting || busy || discovering}
                      aria-pressed={source?.id === v.id}
                      onClick={() => setSelected(v.id)}
                    >
                      <span>
                        <strong>{v.text.slice(0, 70) || "无正文帖子"}</strong>
                        <small>
                          {v.author} · {v.images.length} 图 ·{" "}
                          {v.comments.length} 条页面评论
                        </small>
                      </span>
                      {v.exports.length ? (
                        <Status kind="good">{v.exports.length} 个去向</Status>
                      ) : null}
                    </button>
                  ))}
              </div>
              <Pagination
                page={actualPage}
                pageSize={8}
                total={sources.length}
                onPageChange={setPage}
                disabled={collecting || busy || discovering}
                label="皮皮虾素材分页"
              />
            </>
          ) : sources ? (
            <Empty title="还没有采集记录">
              获取数据列表并勾选帖子，或粘贴分享链接，开始建立图文素材库。
            </Empty>
          ) : null}
        </Panel>
      </div>
      {source ? (
        <PipixDetail
          key={source.id}
          source={source}
          workspace={workspace}
          busy={busy || collecting || discovering}
          onExportBusy={setBusy}
          reload={query.reload}
          onOpenWeibo={onOpenWeibo}
        />
      ) : (
        <Panel title="图文与评论预览">
          <Empty title="采集后在这里挑选内容">
            支持图文和分享页文字评论；视频仅保留文案与评论。
          </Empty>
        </Panel>
      )}
    </div>
  );
}
