import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  ArrowLeft,
  Download,
  Plus,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { wechatArticleUrl } from "../../shared/wechat";
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
  SearchField,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Pagination } from "../ui/Pagination";
import { formatTime } from "../lib/format";
import { ArticleEditor } from "./ArticleEditor";
import { WechatDiscovery } from "./Discovery";
import { stageLabel } from "./labels";
import { RewriteStyleBadge } from "./RewriteStyleBadge";
import "../ui/workspace.css";
import "./wechat.css";

const selectionSchema = z.object({
  url: z.string().max(4000),
  selected: z.string().max(100),
  query: z.string().max(200),
  page: z.number().int().positive().default(1),
});
const pageSize = 8;

export default function WechatWorkflow() {
  const { data } = useAppData(),
    { page, navigate } = useAppNavigation();
  const discover = page === "wechat-discovery";
  const selection = useLocalDraft(
    `panxu:wechat:${data!.dataPath}:selection`,
    { url: "", selected: "", query: "", page: 1 },
    (v) => selectionSchema.parse(v),
  );
  const history = useIpcQuery("wechat.list", undefined, { keepPrevious: true });
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [importOpen, setImportOpen] = useState(() => !!selection.value.url),
    [editorBusy, setEditorBusy] = useState(false);
  const lock = useRef(false),
    alive = useRef(true),
    importInput = useRef<HTMLInputElement>(null),
    importButton = useRef<HTMLButtonElement>(null),
    editorRegion = useRef<HTMLElement>(null);
  const [locate, setLocate] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const selected = selection.value.selected || history.data?.[0]?.id || "";
  const showImport = importOpen || history.data?.length === 0;
  const detail = useIpcQuery(
    "wechat.get",
    { id: selected },
    { enabled: !!selected, keepPrevious: true },
  );
  const current = detail.data?.article.id === selected ? detail.data : null;
  useEffect(() => {
    if (!selection.value.selected && selected) selection.update({ selected });
  }, [selected, selection.value.selected, selection.update]);
  useEffect(() => {
    if (!locate) return;
    const index = history.data?.findIndex((item) => item.id === locate) ?? -1;
    if (index < 0) return;
    selection.update({ page: Math.floor(index / pageSize) + 1 });
    setLocate("");
  }, [history.data, locate, selection.update]);
  const toggleImport = () => {
    if (!showImport) {
      setImportOpen(true);
      requestAnimationFrame(() => importInput.current?.focus());
    } else if (history.data?.length === 0) {
      importInput.current?.focus();
    } else {
      setImportOpen(false);
      importButton.current?.focus();
    }
  };

  const importArticle = async (rawUrl: string, fromDiscovery = false) => {
    if (lock.current || editorBusy) {
      if (fromDiscovery)
        throw new Error("草稿箱正在处理其他操作，请稍后导入。");
      return;
    }
    const url = wechatArticleUrl.safeParse(rawUrl.trim());
    if (!url.success) {
      const message =
        "请粘贴微信公众号文章链接（https://mp.weixin.qq.com/s/…）。";
      if (fromDiscovery) throw new Error(message);
      setError(message);
      importInput.current?.focus();
      return;
    }
    lock.current = true;
    setPending(true);
    setError("");
    try {
      const result = await ipc("wechat.import", { url: url.data });
      history.reload();
      if (alive.current) {
        selection.update({
          url: "",
          query: "",
          selected: result.article.id,
          page: 1,
        });
        setImportOpen(false);
        setLocate(result.article.id);
        if (selected === result.article.id) detail.setData(result);
        if (fromDiscovery) navigate("wechat-workflow");
        requestAnimationFrame(() =>
          editorRegion.current?.focus({ preventScroll: true }),
        );
      }
    } catch (cause) {
      if (fromDiscovery) throw cause;
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "导入失败，请重试。");
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  const items = history.data?.filter((v) =>
    v.title.toLowerCase().includes(selection.value.query.trim().toLowerCase()),
  );
  const currentPage = Math.min(
    selection.value.page,
    Math.max(1, Math.ceil((items?.length ?? 0) / pageSize)),
  );
  return (
    <div className="workspace-frame wechat-workflow">
      <Header
        title={discover ? "公众号 · 发现爆款" : "公众号草稿箱"}
        action={
          <div className="wechat-page-actions">
            <Button
              disabled={pending || editorBusy}
              onClick={() =>
                navigate(discover ? "wechat-workflow" : "wechat-discovery")
              }
            >
              {discover ? <ArrowLeft size={14} /> : <Search size={14} />}
              {discover ? "返回草稿箱" : "发现爆款"}
            </Button>
            {!discover ? (
              <>
                <Button quiet onClick={() => navigate("wechat-accounts")}>
                  <Users size={14} />
                  管理公众号账号
                </Button>
                <Button
                  ref={importButton}
                  primary={!selected}
                  disabled={pending || editorBusy}
                  aria-expanded={showImport}
                  aria-controls={showImport ? "wechat-import" : undefined}
                  onClick={toggleImport}
                >
                  <Plus size={14} />
                  导入文章
                </Button>
              </>
            ) : null}
          </div>
        }
      />
      <WechatDiscovery
        active={discover}
        onImport={(url) => importArticle(url, true)}
      />
      {!discover ? (
        <>
          {showImport ? (
            <Panel
              className="wechat-import"
              id="wechat-import"
              aria-label="导入公众号文章"
            >
              <form
                className="wechat-import-bar"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void importArticle(selection.value.url);
                }}
              >
                <input
                  ref={importInput}
                  aria-label="公众号文章链接"
                  aria-describedby={error ? "wechat-import-error" : undefined}
                  type="url"
                  placeholder="粘贴微信公众号文章链接"
                  value={selection.value.url}
                  maxLength={4000}
                  disabled={pending || editorBusy}
                  onChange={(e) => {
                    selection.update({ url: e.target.value });
                    setError("");
                  }}
                />
                <Button
                  primary
                  disabled={
                    pending || editorBusy || !selection.value.url.trim()
                  }
                  type="submit"
                >
                  <Download size={14} />
                  {pending ? "正在导入…" : "导入到本地草稿"}
                </Button>
                {selected ? (
                  <Button quiet disabled={pending} onClick={toggleImport}>
                    收起
                  </Button>
                ) : null}
              </form>
              <small>
                保留原文和插图，识别网盘链接。重复导入会打开已有草稿。
              </small>
              {error ? (
                <Notice danger>
                  <span id="wechat-import-error" role="alert">
                    {error}
                  </span>
                </Notice>
              ) : null}
            </Panel>
          ) : null}
          {selection.error ? <Notice warning>{selection.error}</Notice> : null}
          <div className="wechat-layout">
            <aside className="wechat-history" aria-label="本地草稿箱">
              <div className="wechat-section-heading">
                <h2>本地草稿</h2>
                <Button
                  quiet
                  size="compact"
                  aria-label="刷新公众号草稿"
                  disabled={pending}
                  onClick={history.reload}
                >
                  <RefreshCw size={14} />
                </Button>
              </div>
              <SearchField
                label="搜索公众号草稿"
                placeholder="搜索标题"
                value={selection.value.query}
                onChange={(query) => {
                  selection.update({ query, page: 1 });
                  setLocate("");
                }}
              />
              <QueryError
                error={history.error}
                loading={history.loading}
                onRetry={history.reload}
              />
              {!history.data && !history.error ? (
                <LoadingState label="正在读取草稿…" compact />
              ) : items?.length ? (
                <>
                  <div className="wechat-history-list">
                    {items
                      .slice(
                        (currentPage - 1) * pageSize,
                        currentPage * pageSize,
                      )
                      .map((item) => (
                        <button
                          key={item.id}
                          className="wechat-history-entry"
                          disabled={editorBusy || pending}
                          aria-current={
                            selected === item.id ? "page" : undefined
                          }
                          onClick={() => {
                            selection.update({ selected: item.id });
                            setLocate("");
                          }}
                          title={item.title}
                        >
                          <strong>{item.title}</strong>
                          <span>
                            <small>第 {item.edition?.number ?? 1} 稿</small>
                            <RewriteStyleBadge styleId={item.rewriteStyleId} />
                            <Status
                              kind={
                                item.stage === "uncertain"
                                  ? "warning"
                                  : item.stage === "synced"
                                    ? "good"
                                    : "normal"
                              }
                            >
                              {stageLabel[item.stage]}
                            </Status>
                            <small>{formatTime(item.updatedAt)}</small>
                          </span>
                        </button>
                      ))}
                  </div>
                  <Pagination
                    page={currentPage}
                    pageSize={pageSize}
                    total={items.length}
                    onPageChange={(page) => {
                      selection.update({ page });
                      setLocate("");
                    }}
                    label="公众号草稿分页"
                  />
                </>
              ) : history.data ? (
                <Empty
                  compact
                  title={
                    selection.value.query ? "没有匹配的草稿" : "还没有草稿"
                  }
                >
                  {selection.value.query
                    ? "换个标题关键词试试。"
                    : "从上方粘贴文章链接开始。"}
                </Empty>
              ) : null}
            </aside>
            <section
              ref={editorRegion}
              tabIndex={-1}
              className="wechat-current"
              aria-label="当前公众号草稿"
            >
              {selected ? (
                <>
                  <QueryError
                    error={detail.error}
                    loading={detail.loading}
                    onRetry={detail.reload}
                  />
                  {!current && !detail.error ? (
                    <LoadingState label="正在打开草稿…" />
                  ) : null}
                  {current ? (
                    <ArticleEditor
                      key={selected}
                      initial={current}
                      onChanged={history.reload}
                      onBusy={setEditorBusy}
                      onSelect={(id) => {
                        selection.update({ selected: id, query: "", page: 1 });
                        setLocate(id);
                      }}
                    />
                  ) : null}
                </>
              ) : history.data ? (
                <Empty title="导入第一篇文章">
                  导入后在这里编辑正文、替换网盘链接和更新配图。
                </Empty>
              ) : null}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
