import { useEffect, useMemo, useRef, useState } from "react";
import { Blocks, Download, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { wechatImportUrl } from "../../shared/wechat";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData, useAppNavigation } from "../state";
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
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { formatTime } from "../lib/format";
import { ArticleEditor } from "./ArticleEditor";
import { ArticleModuleManager } from "./ArticleModules";
import {
  wechatHistoryPageSize as pageSize,
  wechatSelectionDefaults,
  wechatSelectionKey,
  wechatSelectionSchema,
} from "./draft-selection";
import {
  groupWechatArticles,
  matchesWechatArticle,
  preferredWechatEdition,
  type WechatArticleGroup,
} from "./article-groups";
import "../ui/workspace.css";
import "./wechat.css";

export default function WechatWorkflow() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation();
  const selection = useLocalDraft(
    wechatSelectionKey(data!.dataPath),
    wechatSelectionDefaults,
    wechatSelectionSchema.parse,
  );
  const history = useIpcQuery("wechat.list", undefined, { keepPrevious: true });
  const groups = useMemo(
    () => (history.data ? groupWechatArticles(history.data) : undefined),
    [history.data],
  );
  const items = useMemo(
    () =>
      groups?.filter((group) =>
        matchesWechatArticle(group, selection.value.query),
      ),
    [groups, selection.value.query],
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [importOpen, setImportOpen] = useState(() => !!selection.value.url),
    [editorBusy, setEditorBusy] = useState(false);
  const [moduleManagerOpen, setModuleManagerOpen] = useState(false);
  const lock = useRef(false),
    alive = useRef(true),
    importInput = useRef<HTMLInputElement>(null),
    importButton = useRef<HTMLButtonElement>(null),
    editorRegion = useRef<HTMLElement>(null);
  const [locate, setLocate] = useState("");
  const [focusVersion, setFocusVersion] = useState("");
  const [editing, setEditing] = useState(false);
  const [deletion, setDeletion] = useState<{
    group: WechatArticleGroup;
    id: string;
  } | null>(null);
  const [deleteError, setDeleteError] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { selected: requested, handoff } = selection.value;
  const selected =
    (requested &&
    (!groups ||
      locate === requested ||
      handoff === requested ||
      groups.some((group) =>
        group.editions.some((item) => item.id === requested),
      ))
      ? requested
      : "") ||
    (groups?.[0]
      ? preferredWechatEdition(
          groups[0],
          selection.value.lastEditions[groups[0].id],
        )
      : "");
  const activeGroup = groups?.find((group) =>
    group.editions.some((item) => item.id === selected),
  );
  const showImport = importOpen || history.data?.length === 0;
  const detail = useIpcQuery(
    "wechat.get",
    { id: selected },
    { enabled: !!selected, keepPrevious: true },
  );
  const current = detail.data?.article.id === selected ? detail.data : null;
  useEffect(() => {
    if (requested !== selected) selection.update({ selected });
  }, [requested, selected, selection.update]);
  useEffect(() => {
    if (
      activeGroup &&
      selection.value.lastEditions[activeGroup.id] !== selected
    )
      selection.update({
        lastEditions: {
          ...selection.value.lastEditions,
          [activeGroup.id]: selected,
        },
      });
  }, [activeGroup, selected, selection.value.lastEditions, selection.update]);
  useEffect(() => {
    const target = locate || handoff;
    if (!target) return;
    const index =
      items?.findIndex((group) =>
        group.editions.some((item) => item.id === target),
      ) ?? -1;
    if (index < 0) return;
    const visibleCount = selection.value.visibleCount;
    if (handoff || index >= visibleCount)
      selection.update({
        handoff: undefined,
        visibleCount: Math.max(
          visibleCount,
          (Math.floor(index / pageSize) + 1) * pageSize,
        ),
      });
    setLocate("");
  }, [items, locate, handoff, selection.value.visibleCount, selection.update]);
  const selectEdition = (id: string) => {
    const group = groups?.find((group) =>
      group.editions.some((item) => item.id === id),
    );
    selection.update({
      selected: id,
      handoff: undefined,
      ...(group
        ? { lastEditions: { ...selection.value.lastEditions, [group.id]: id } }
        : {}),
    });
    setFocusVersion(id);
    setLocate(id);
  };
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

  const importArticle = async (rawUrl: string) => {
    if (lock.current || editorBusy) return;
    const url = wechatImportUrl.safeParse(rawUrl);
    if (!url.success) {
      setError(
        "请粘贴有效的公众号文章或贴吧帖子链接（mp.weixin.qq.com/s/… 或 tieba.baidu.com/p/…）。",
      );
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
          handoff: undefined,
          visibleCount: pageSize,
        });
        setImportOpen(false);
        setLocate(result.article.id);
        if (selected === result.article.id) detail.setData(result);
        requestAnimationFrame(() =>
          editorRegion.current?.focus({ preventScroll: true }),
        );
      }
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "导入失败，请重试。");
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  const deleteDraft = async () => {
    if (!deletion || lock.current || editorBusy) return;
    const draft = deletion.group.editions.find(({ id }) => id === deletion.id);
    if (!draft) return;
    lock.current = true;
    setPending(true);
    setDeleteError("");
    try {
      const next = await ipc("wechat.delete", {
        id: draft.id,
        revision: draft.revision,
      });
      if (!alive.current) return;
      history.setData(next);
      if (selected === draft.id) {
        const remaining = groupWechatArticles(next);
        const siblings = new Set(deletion.group.editions.map(({ id }) => id));
        const group =
          remaining.find(({ editions }) =>
            editions.some(({ id }) => siblings.has(id)),
          ) ?? remaining[0];
        selection.update({
          selected: group
            ? preferredWechatEdition(
                group,
                selection.value.lastEditions[group.id],
              )
            : "",
        });
        setFocusVersion("");
        setLocate("");
      }
      setDeletion(null);
    } catch (cause) {
      if (alive.current)
        setDeleteError(
          cause instanceof Error ? cause.message : "删除失败，请重试。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  const visibleItems = items?.slice(0, selection.value.visibleCount);
  return (
    <div className="workspace-frame wechat-workflow">
      <Header
        title="公众号草稿箱"
        action={
          <div className="wechat-page-actions">
            <Button
              quiet
              aria-haspopup="dialog"
              onClick={() => setModuleManagerOpen(true)}
            >
              <Blocks size={14} aria-hidden="true" />
              模块管理
            </Button>
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
          </div>
        }
      />
      {showImport ? (
        <Panel
          className="wechat-import"
          id="wechat-import"
          aria-label="导入文章"
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
              aria-label="文章或帖子链接"
              aria-describedby={
                error
                  ? "wechat-import-error wechat-import-help"
                  : "wechat-import-help"
              }
              type="url"
              placeholder="粘贴公众号文章或百度贴吧帖子链接"
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
              disabled={pending || editorBusy || !selection.value.url.trim()}
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
          <small id="wechat-import-help">
            贴吧只采集主楼。导入时保留配图并识别网盘链接，重复导入会打开已有草稿。
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
        <aside className="wechat-history" aria-label="公众号文章列表">
          <div className="wechat-section-heading">
            <h2>文章</h2>
            <div className="wechat-history-actions">
              <Button
                quiet={!editing}
                size="compact"
                aria-pressed={editing}
                disabled={
                  pending || editorBusy || (!editing && !groups?.length)
                }
                onClick={() => setEditing(!editing)}
              >
                {editing ? "完成" : "编辑"}
              </Button>
              <Button
                quiet
                size="compact"
                aria-label="刷新公众号草稿"
                disabled={pending || history.loading}
                onClick={history.reload}
              >
                <RefreshCw size={14} />
              </Button>
            </div>
          </div>
          <SearchField
            label="搜索公众号文章"
            placeholder="搜索文章或稿件标题"
            value={selection.value.query}
            onChange={(query) => {
              selection.update({ query, visibleCount: pageSize });
              setLocate("");
            }}
          />
          <QueryError
            error={history.error}
            loading={history.loading}
            onRetry={history.reload}
          />
          {!history.data && !history.error ? (
            <LoadingState label="正在读取文章…" compact />
          ) : items?.length ? (
            <>
              <div className="wechat-history-list">
                {visibleItems?.map((item) => (
                  <div key={item.id} className="wechat-history-row">
                    <button
                      className="wechat-history-entry"
                      disabled={editorBusy || pending}
                      aria-current={
                        activeGroup?.id === item.id ? "page" : undefined
                      }
                      onClick={() => {
                        const id = preferredWechatEdition(
                          item,
                          selection.value.lastEditions[item.id],
                        );
                        selection.update({
                          selected: id,
                          handoff: undefined,
                          lastEditions: {
                            ...selection.value.lastEditions,
                            [item.id]: id,
                          },
                        });
                        setFocusVersion("");
                        setLocate("");
                      }}
                      title={item.title}
                    >
                      <strong>{item.title}</strong>
                      <span>
                        <small>{item.editions.length} 稿</small>
                        <small title={formatTime(item.updatedAt)}>
                          {formatTime(item.updatedAt).split(" ")[0]}
                        </small>
                      </span>
                    </button>
                    {editing ? (
                      <Button
                        quiet
                        size="compact"
                        aria-label={`删除「${item.title}」的文稿`}
                        disabled={editorBusy || pending}
                        onClick={() => {
                          setDeleteError("");
                          setDeletion({
                            group: item,
                            id: preferredWechatEdition(
                              item,
                              selection.value.lastEditions[item.id],
                            ),
                          });
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="wechat-history-footer">
                <small>
                  已显示 {visibleItems?.length} / {items.length} 篇
                </small>
                {items.length > selection.value.visibleCount ? (
                  <Button
                    size="compact"
                    onClick={() =>
                      selection.update({
                        visibleCount:
                          selection.value.visibleCount + pageSize,
                      })
                    }
                  >
                    加载更多
                  </Button>
                ) : null}
              </div>
            </>
          ) : history.data ? (
            <Empty
              compact
              title={selection.value.query ? "没有匹配的文章" : "还没有文章"}
            >
              {selection.value.query
                ? "换个原文或稿件标题关键词试试。"
                : "从上方粘贴公众号文章或贴吧帖子链接。"}
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
                  onSelect={selectEdition}
                  focusEdition={focusVersion === selected}
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
      {moduleManagerOpen ? (
        <ArticleModuleManager
          workspace={data!.dataPath}
          onClose={() => setModuleManagerOpen(false)}
        />
      ) : null}
      {deletion ? (
        <Dialog
          title="删除本地文稿"
          busy={pending}
          onClose={() => setDeletion(null)}
          footer={
            <>
              <Button disabled={pending} onClick={() => setDeletion(null)}>
                取消
              </Button>
              <Button
                className="wechat-delete-confirm"
                disabled={pending || editorBusy}
                onClick={() => void deleteDraft()}
              >
                {pending ? "正在删除…" : "删除文稿"}
              </Button>
            </>
          }
        >
          <p>{deletion.group.title}</p>
          {deletion.group.editions.length > 1 ? (
            <Field label="要删除的稿件">
              <Select
                value={deletion.id}
                disabled={pending}
                items={deletion.group.editions.map((edition) => ({
                  value: edition.id,
                  label: `第 ${edition.editionNumber ?? edition.edition?.number ?? 1} 稿 · ${edition.title}`,
                }))}
                onValueChange={(id) => {
                  setDeletion({ ...deletion, id });
                  setDeleteError("");
                }}
              />
            </Field>
          ) : null}
          <p className="muted">
            删除所选本地文稿后无法恢复。微信草稿、已发表文章和网盘资源会保留。
          </p>
          {deleteError ? (
            <Notice danger>
              <span role="alert">{deleteError}</span>
            </Notice>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}
