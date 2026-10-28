import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ArrowRight, Download, Plus, RefreshCw } from "lucide-react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData, useAppNavigation } from "../state";
import {
  Button,
  Empty,
  Header,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Pagination } from "../ui/Pagination";
import { formatTime } from "../lib/format";
import { ArticleEditor } from "./ArticleEditor";
import "./smzdm.css";
const selectionSchema = z.object({
  url: z.string().max(4000),
  selected: z.string().max(100),
});
export default function SmzdmWorkflow() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation();
  const selection = useLocalDraft(
    `panxu:smzdm:${data!.dataPath}:selection`,
    { url: "", selected: "" },
    (v) => selectionSchema.parse(v),
  );
  const history = useIpcQuery("smzdm.list", undefined, { keepPrevious: true });
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState(1);
  const busy = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const selected = selection.value.selected;
  const detail = useIpcQuery(
    "smzdm.get",
    { id: selected },
    { enabled: !!selected, keepPrevious: false },
  );
  const open = (id: string) => {
    selection.update({ selected: id });
    setError("");
  };
  const importArticle = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const result = await ipc("smzdm.import", { url: selection.value.url });
      history.reload();
      if (alive.current) {
        open(result.article.id);
        detail.reload();
      }
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "导入失败，请重试。");
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <div className="smzdm-workflow">
      <Header
        title="什么值得买文章分发"
        description="导入公众号文章，归档配套资源，整理文稿并发布到已连接的账号。"
        action={
          <Button onClick={() => navigate("smzdm-accounts")}>
            管理什么值得买账号
            <ArrowRight size={14} />
          </Button>
        }
      />
      <Panel title="导入公众号文章" className="smzdm-import-panel">
        <div className="smzdm-import-bar">
          <input
            aria-label="公众号文章链接"
            placeholder="粘贴 https://mp.weixin.qq.com/s/…"
            type="url"
            value={selection.value.url}
            maxLength={4000}
            disabled={pending}
            onChange={(e) => selection.update({ url: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void importArticle();
            }}
          />
          <Button
            primary
            disabled={pending || !selection.value.url.trim()}
            onClick={() => void importArticle()}
          >
            <Download size={15} />
            {pending ? "正在抓取…" : "抓取文章"}
          </Button>
        </div>
        <small>
          原文与编辑稿分别保存在当前工作空间。导入不会自动调用
          AI、转存文件或发布文章。
        </small>
        {error ? <Notice danger>{error}</Notice> : null}
        {selection.error ? <Notice warning>{selection.error}</Notice> : null}
      </Panel>
      <div className="smzdm-layout">
        <aside className="smzdm-history">
          <div className="smzdm-section-title">
            <h2>文章任务</h2>
            <Button
              quiet
              size="compact"
              aria-label="刷新文章任务"
              onClick={history.reload}
              disabled={history.loading}
            >
              <RefreshCw size={14} />
            </Button>
          </div>
          <QueryError
            error={history.error}
            loading={history.loading}
            onRetry={history.reload}
          />
          {!history.data && !history.error ? (
            <LoadingState label="正在读取文章…" compact />
          ) : null}
          {history.data?.length ? (
            <>
              <div className="smzdm-history-list">
                {history.data
                  .slice((page - 1) * 12, page * 12)
                  .map((article) => (
                    <button
                      key={article.id}
                      className="smzdm-history-entry"
                      disabled={pending}
                      aria-current={
                        selected === article.id ? "page" : undefined
                      }
                      onClick={() => open(article.id)}
                    >
                      <strong>{article.title}</strong>
                      <small>{formatTime(article.updatedAt)}</small>
                      <Status
                        kind={
                          article.stage === "editing"
                            ? "normal"
                            : article.stage === "uncertain"
                              ? "warning"
                              : "good"
                        }
                      >
                        {article.stage === "editing"
                          ? "编辑中"
                          : article.stage === "publishing"
                            ? "正在提交"
                            : article.stage === "uncertain"
                              ? "结果待核对"
                              : article.stage === "submitted"
                                ? "待审核"
                                : "已发布"}
                      </Status>
                    </button>
                  ))}
              </div>
              <Pagination
                page={page}
                pageSize={12}
                total={history.data.length}
                onPageChange={setPage}
                label="文章任务分页"
              />
            </>
          ) : history.data ? (
            <Empty compact title="还没有文章任务">
              从上方导入一篇公众号文章。
            </Empty>
          ) : null}
          <Button quiet disabled={pending} onClick={() => open("")}>
            <Plus size={14} />
            导入其他文章
          </Button>
        </aside>
        <section className="smzdm-current" aria-label="当前文章任务">
          {selected ? (
            <>
              <QueryError
                error={detail.error}
                loading={detail.loading}
                onRetry={detail.reload}
              />
              {!detail.data && !detail.error ? (
                <LoadingState label="正在打开文章…" />
              ) : null}
              {detail.data && detail.data.article.id === selected ? (
                <ArticleEditor
                  key={selected}
                  initial={detail.data}
                  onChanged={history.reload}
                />
              ) : null}
            </>
          ) : (
            <Empty title="从一篇公众号文章开始">
              导入后依次完成资源归档、链接替换和文章审阅。什么值得买目前连接一个账号，登录在账号管理中完成。
            </Empty>
          )}
        </section>
      </div>
    </div>
  );
}
