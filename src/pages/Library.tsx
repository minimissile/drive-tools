import { ProviderIcon } from "../resources/ProviderIcon";
import { Select } from "../ui/Select";
import "../library/library.css";
import { ResourceDetail } from "../library/ResourceDetail";
import { ResourceDeleteDialog } from "../library/ResourceDeleteDialog";
import { DriveResourceDialog } from "../drive-files/DriveResourceDialog";
import type { DriveResourceTarget } from "../drive-files/DriveResourceDialog";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useIpcQuery } from "../api/useIpcQuery";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { ArrowRight, FolderOpen, Plus, Trash2 } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import {
  Button,
  Empty,
  Loading,
  LoadingState,
  Notice,
  SearchField,
} from "../ui/primitives";
import { ResourceKindIcon, resourceFiles } from "../resources/ResourceKindIcon";
import { providerName } from "../resources/labels";
import { updateSelection } from "../lib/selection";
import { Pagination } from "../ui/Pagination";
import type { Resource, ResourcePage } from "../../shared/types";
import { readLibraryView, saveLibraryView } from "../library/view-state";
const emptyPage: ResourcePage = { items: [], total: 0, page: 1, pageSize: 25 };
export default function LibraryPage() {
  const { data } = useAppData(),
    { select, selectedResourceId, selectedCopyId } = useAppSelection(),
    { navigate, edit } = useAppNavigation(),
    { command } = useAppActions(),
    { busy } = useAppActivity();
  const listBody = useRef<HTMLDivElement>(null);
  const [initial] = useState(() =>
    readLibraryView(localStorage, data!.dataPath),
  );
  const [query, setQuery] = useState(initial.query),
    deferredQuery = useDeferredValue(query),
    [page, setPage] = useState(initial.page),
    [checked, setChecked] = useState<string[]>([]),
    [category, setCategory] = useState(
      data!.resourceTotals.categories.includes(initial.category)
        ? initial.category
        : "all",
    ),
    [accountId, setAccountId] = useState(
      data!.accounts.some((a) => a.id === initial.accountId)
        ? initial.accountId
        : "all",
    );
  useEffect(() => {
    listBody.current?.scrollTo(0, 0);
  }, [page, category, accountId, deferredQuery]);
  const hasFilters =
    !!query.trim() || category !== "all" || accountId !== "all";
  const clearFilters = () => {
    setQuery("");
    setCategory("all");
    setAccountId("all");
    setPage(1);
    setChecked([]);
  };
  useEffect(() => {
    saveLibraryView(localStorage, data!.dataPath, {
      query,
      category,
      accountId,
      page,
    });
  }, [data!.dataPath, query, category, accountId, page]);
  const {
    data: result,
    loading,
    error,
    reload,
  } = useIpcQuery(
    "resource.page",
    {
      query: deferredQuery,
      category: category === "all" ? undefined : category,
      accountId: accountId === "all" ? undefined : accountId,
      page,
      pageSize: 25,
    },
    {
      delay: 180,
      invalidate: data?.resources,
      keepPrevious: true,
    },
  );
  useEffect(() => {
    if (!result || loading) return;
    if (result.page !== page) setPage(result.page);
    setChecked((old) =>
      old.filter((id) =>
        result.items.some((r) =>
          r.copies.some(
            (c) =>
              c.id === id &&
              c.status === "ready" &&
              (accountId === "all" || c.accountId === accountId),
          ),
        ),
      ),
    );
  }, [result, loading, page, accountId]);
  const results = result ?? emptyPage;
  const rows = results.items;
  const checkable = rows.flatMap((r) =>
    r.copies
      .filter(
        (c) =>
          c.status === "ready" &&
          (accountId === "all" || c.accountId === accountId),
      )
      .map((c) => c.id),
  );
  const inspectShares = async (copyIds: string[]) => {
    await command(
      "copies.check",
      { copyIds },
      "本人分享检查已完成，结果已记录到资源档案。",
    );
  };
  const resource = rows.find((r) => r.id === selectedResourceId) ?? rows[0];
  const copies =
    resource?.copies.filter(
      (c) => accountId === "all" || c.accountId === accountId,
    ) ?? [];
  const copy = copies.find((c) => c.id === selectedCopyId) ?? copies[0];
  const compact = useMediaQuery("(max-width: 1100px)");
  const [detailOpen, setDetailOpen] = useState(false);
  const [viewing, setViewing] = useState<DriveResourceTarget | null>(null);
  const [deleting, setDeleting] = useState<Resource | null>(null);
  const viewResource = (item: Resource, copyId?: string) => {
    const chosen =
      item.copies.find((c) => c.id === copyId) ??
      item.copies.find((c) => accountId === "all" || c.accountId === accountId);
    setViewing({ kind: "resource", resource: item, copy: chosen });
  };
  useEffect(() => {
    if (!compact) setDetailOpen(false);
  }, [compact]);
  return (
    <div className="library-workspace">
      <div className="library-toolbar" aria-label="资源库概况与操作">
        <div className="library-summary">
          <div>
            全部资源<strong>{data!.resourceTotals.resources}</strong>
          </div>
          <div>
            已归档副本
            <strong>{data!.resourceTotals.readyCopies}</strong>
          </div>
          <button className="stat-action" onClick={() => navigate("tasks")}>
            需要处理<strong>{data!.resourceTotals.attentionJobs}</strong>
            <ArrowRight size={14} />
          </button>
        </div>
        <div className="library-primary-actions">
          <Button quiet onClick={() => navigate("drive-files")}>
            网盘文件
          </Button>
          <Button quiet onClick={() => navigate("bulk")}>
            批量录入
          </Button>
          <Button onClick={() => navigate("resource-export")}>
            AI 筛选导出
          </Button>
          <Button primary onClick={() => edit(null)}>
            <Plus size={16} />
            录入资源
          </Button>
        </div>
      </div>
      {data!.accounts.length === 0 ? (
        <Notice>
          先连接本人网盘账号，再录入资源。
          <Button quiet onClick={() => navigate("accounts")}>
            添加网盘账号 <ArrowRight size={14} />
          </Button>
        </Notice>
      ) : null}
      <div
        className="library-layout"
        data-has-detail={!compact && !!resource && !!copy}
      >
        <section className="resource-list" aria-label="资源列表">
          <div className="library-filters">
            <SearchField
              value={query}
              onChange={(v) => {
                setQuery(v);
                setChecked([]);
                setPage(1);
              }}
            />
            <div className="library-filter-options">
              {hasFilters ? (
                <Button
                  quiet
                  onClick={clearFilters}
                  className="library-filter-reset"
                >
                  清除筛选
                </Button>
              ) : null}
              <Select
                aria-label="分类筛选"
                className="library-category-filter"
                value={category}
                onValueChange={(nextValue) => {
                  setCategory(nextValue);
                  setChecked([]);
                  setPage(1);
                }}
                items={[
                  { value: "all", label: "全部分类" },
                  ...data!.resourceTotals.categories.map((c) => ({
                    value: c,
                    label: c,
                  })),
                ]}
              />
              <Select
                aria-label="资源账号筛选"
                value={accountId}
                onValueChange={(nextValue) => {
                  setAccountId(nextValue);
                  setChecked([]);
                  setPage(1);
                }}
                items={[
                  { value: "all", label: "全部账号" },
                  ...data!.accounts.map((a) => ({
                    value: a.id,
                    label: a.alias,
                  })),
                ]}
              />
            </div>
          </div>
          <div className="list-heading">
            <label className="checkbox">
              <SelectionCheckbox
                aria-label="选择本页可检查分享"
                selected={checked.length}
                total={checkable.length}
                disabled={!checkable.length || checkable.length > 25 || loading}
                onChange={(e) => setChecked(e.target.checked ? checkable : [])}
              />
              选择本页分享
            </label>
            {checked.length ? (
              <Button
                size="compact"
                disabled={busy > 0 || loading}
                onClick={() => void inspectShares(checked)}
              >
                检查所选 {checked.length} 份分享
              </Button>
            ) : null}
            <span role="status" className="library-result-count">
              {loading ? (
                rows.length ? (
                  <Loading label="正在更新资源…" announce={false} />
                ) : (
                  "资源列表"
                )
              ) : error ? (
                "读取未完成"
              ) : result ? (
                `共 ${results.total} 份资源`
              ) : (
                "资源列表"
              )}
            </span>
            {compact && resource && copy ? (
              <Button quiet size="compact" onClick={() => setDetailOpen(true)}>
                查看当前档案
              </Button>
            ) : null}
          </div>
          {checkable.length > 25 ? (
            <p className="library-selection-hint">
              请按账号筛选，每次最多检查25份分享。
            </p>
          ) : null}
          <div
            className="resource-list-body"
            aria-busy={loading}
            ref={listBody}
          >
            {error && rows.length ? (
              <QueryError error={error} loading={loading} onRetry={reload} />
            ) : null}
            {rows.length ? (
              rows.map((r) => (
                <div
                  key={r.id}
                  className={`resource-select-row ${r.id === resource?.id ? "selected" : ""}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`检查${r.title}的分享`}
                    disabled={
                      !r.copies.some(
                        (c) =>
                          c.status === "ready" &&
                          (accountId === "all" || c.accountId === accountId),
                      ) || loading
                    }
                    checked={r.copies.some((c) => checked.includes(c.id))}
                    onChange={(e) => {
                      const ids = r.copies
                        .filter(
                          (c) =>
                            c.status === "ready" &&
                            (accountId === "all" || c.accountId === accountId),
                        )
                        .map((c) => c.id);
                      setChecked((old) =>
                        updateSelection(old, ids, e.target.checked, 25),
                      );
                    }}
                  />
                  <button
                    key={r.id}
                    className={`resource-row ${r.id === resource?.id ? "selected" : ""}`}
                    aria-pressed={r.id === resource?.id}
                    title={r.title}
                    onClick={() => {
                      select(r.id);
                      if (compact) setDetailOpen(true);
                    }}
                  >
                    <ResourceKindIcon
                      title={r.title}
                      files={resourceFiles(
                        r.copies,
                        accountId,
                        r.id === resource?.id
                          ? (selectedCopyId ?? undefined)
                          : undefined,
                      )}
                    />
                    <div className="resource-row-copy">
                      <strong>{r.title}</strong>
                      <div className="muted">
                        <span className="resource-provider">
                          <ProviderIcon
                            provider={r.provider}
                            size="small"
                            decorative
                          />
                          {providerName(r.provider)}网盘
                        </span>
                        <span
                          className="resource-meta-separator"
                          aria-hidden="true"
                        >
                          ·
                        </span>
                        {r.category}
                        <span
                          className="resource-meta-separator"
                          aria-hidden="true"
                        >
                          ·
                        </span>
                        {r.copies.length} 个账号副本
                      </div>
                      <div className="row compact">
                        {r.tags.slice(0, 3).map((t) => (
                          <span className="tag" key={t}>
                            {t}
                          </span>
                        ))}
                        <span
                          className={
                            r.copies.some((c) => c.status === "ready")
                              ? "good-text"
                              : "muted"
                          }
                        >
                          {r.copies.some((c) => c.status === "ready")
                            ? "本人分享已就绪"
                            : "等待归档"}
                        </span>
                      </div>
                    </div>
                    <small className="resource-date">
                      {new Date(r.updatedAt).toLocaleDateString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                      })}
                    </small>
                  </button>
                  <div className="resource-row-actions">
                    <Button
                      quiet
                      size="compact"
                      aria-label={`查看${r.title}的网盘资源`}
                      onClick={() =>
                        viewResource(
                          r,
                          r.id === resource?.id ? selectedCopyId : undefined,
                        )
                      }
                    >
                      <FolderOpen size={15} />
                      查看网盘
                    </Button>
                    <Button
                      quiet
                      size="compact"
                      aria-label={`删除资源：${r.title}`}
                      title="删除资源"
                      disabled={busy > 0}
                      onClick={() => setDeleting(r)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </div>
              ))
            ) : loading ? (
              <LoadingState
                label="正在读取资源…"
                layout={result ? "panel" : "list"}
                fill
              />
            ) : error ? (
              <QueryError
                error={error}
                loading={loading}
                onRetry={reload}
                title="资源暂未读取成功"
                compact={false}
                fill
              />
            ) : (
              <Empty
                fill
                title={
                  hasFilters || data!.resourceTotals.resources
                    ? "没有找到匹配资源"
                    : "你的资源库从这里开始"
                }
                action={
                  hasFilters ? (
                    <Button onClick={clearFilters}>
                      清除筛选，查看全部资源
                    </Button>
                  ) : (
                    <Button primary onClick={() => edit(null)}>
                      <Plus size={15} />
                      录入第一份资源
                    </Button>
                  )
                }
              >
                {hasFilters
                  ? "试试更短的关键词，或清除分类和账号限制；已有资料仍保存在资源库。"
                  : "录入标题和分享链接，转存后生成自己的分享，资源信息自动留在本地。"}
              </Empty>
            )}
          </div>
          <Pagination
            label="资源翻页"
            page={results.page}
            pageSize={results.pageSize}
            total={results.total}
            disabled={loading || !!error}
            onPageChange={(next) => {
              setPage(next);
              setChecked([]);
            }}
          >
            {loading || !result ? (
              "每页 25 份"
            ) : (
              <>
                第 {results.page} /{" "}
                {Math.max(1, Math.ceil(results.total / results.pageSize))} 页 ·
                每页 {results.pageSize} 份
              </>
            )}
          </Pagination>
        </section>
        {!compact && resource && copy ? (
          <ResourceDetail
            key={resource.id}
            resource={resource}
            copy={copy}
            copies={copies}
            onView={() => viewResource(resource, copy.id)}
            onDelete={() => setDeleting(resource)}
          />
        ) : null}
      </div>
      {compact && detailOpen && resource && copy ? (
        <Dialog
          title="资源档案"
          className="resource-detail-dialog"
          focus="container"
          onClose={() => setDetailOpen(false)}
        >
          <ResourceDetail
            inDialog
            key={resource.id}
            resource={resource}
            copy={copy}
            copies={copies}
            onView={() => viewResource(resource, copy.id)}
            onDelete={() => setDeleting(resource)}
          />
        </Dialog>
      ) : null}
      {viewing ? (
        <DriveResourceDialog
          target={viewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
      {deleting ? (
        <ResourceDeleteDialog
          resource={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setDetailOpen(false);
            setChecked([]);
            if (selectedResourceId === deleting.id) select("");
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
