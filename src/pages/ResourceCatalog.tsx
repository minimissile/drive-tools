import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Download,
  FilePenLine,
  ListChecks,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import type {
  CatalogDetail,
  ResourceCatalog as Catalog,
} from "../../shared/resource-catalog";
import {
  Button,
  Empty,
  Header,
  LoadingState,
  Notice,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Dialog } from "../ui/Dialog";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { CatalogEditor } from "../resource-catalog/CatalogEditor";
import { CatalogPreview } from "../resource-catalog/CatalogPreview";
import { CatalogPublishing } from "../resource-catalog/CatalogPublishing";
import "../resource-catalog/resource-catalog.css";

export default function ResourceCatalog() {
  const { data } = useAppData();
  const { navigate } = useAppNavigation();
  const workspace = data!.dataPath;
  const selectionKey = `panxu-catalog-selection:${workspace}`;
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem(selectionKey) ?? "";
    } catch {
      return "";
    }
  });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("active");
  const [editor, setEditor] = useState<Catalog | "new" | null>(null);
  const list = useIpcQuery("resourceCatalog.list", undefined, {
    keepPrevious: true,
  });
  const select = (id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(selectionKey, id);
    } catch {
      /* selection is optional */
    }
  };
  const catalogs = list.data ?? [];
  const visible = catalogs.filter(
    (item) =>
      (filter === "all" ||
        (filter === "archived" ? item.archived : !item.archived)) &&
      `${item.title} ${item.category}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const activeId = selected || visible[0]?.id || "";
  const active = catalogs.find((item) => item.id === activeId);
  return (
    <div className="catalog-page">
      <Header
        title="资源清单"
        description="把一类资源整理成公开目录，在文档平台发布并持续维护。"
        action={
          <div className="catalog-heading-actions">
            <Button quiet onClick={() => navigate("website-accounts")}>
              管理文档账号
            </Button>
            <Button primary onClick={() => setEditor("new")}>
              <Plus size={16} aria-hidden="true" />
              新建清单
            </Button>
          </div>
        }
      />
      <QueryError
        title="清单列表读取失败"
        error={list.error}
        loading={list.loading}
        onRetry={list.reload}
      />
      {list.loading && !list.data ? (
        <LoadingState label="正在读取资源清单…" layout="list" />
      ) : !list.data && list.error ? null : !catalogs.length ? (
        <div className="catalog-first-run">
          <Empty
            title="整理一份可持续更新的资源清单"
            action={
              <Button primary onClick={() => setEditor("new")}>
                <Plus size={16} aria-hidden="true" />
                按分类新建清单
              </Button>
            }
          >
            选择资源分类，审阅本人分享，再交接到飞书、腾讯文档或石墨文档。
          </Empty>
          <div className="catalog-first-run-note">
            <ListChecks size={20} aria-hidden="true" />
            <p>
              在这里管理清单内容与发布版本。平台登录统一在「账号管理 →
              其他账号」维护，发布后回填分享链接，后续变化会提示更新。
            </p>
          </div>
        </div>
      ) : (
        <div className="catalog-layout">
          <aside className="catalog-index" aria-label="资源清单索引">
            <div className="catalog-index-heading">
              <h2>我的清单</h2>
              <Button
                quiet
                size="compact"
                aria-label="刷新清单列表"
                disabled={list.loading}
                onClick={list.reload}
              >
                <RefreshCw size={15} />
              </Button>
            </div>
            <label className="catalog-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索清单"
                placeholder="搜索清单或分类"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <Select
              aria-label="清单状态筛选"
              value={filter}
              onValueChange={setFilter}
              items={[
                { value: "active", label: "维护中" },
                { value: "archived", label: "已归档" },
                { value: "all", label: "全部清单" },
              ]}
            />
            <div className="catalog-index-list">
              {!visible.length ? (
                <Empty compact title="没有匹配的清单">
                  调整搜索或状态筛选。
                </Empty>
              ) : (
                visible.map((item) => (
                  <button
                    className="catalog-index-item"
                    aria-pressed={activeId === item.id}
                    key={item.id}
                    onClick={() => select(item.id)}
                  >
                    <strong>{item.title}</strong>
                    <span>
                      {item.category === "all" ? "全部分类" : item.category} ·{" "}
                      {item.resourceCount} 项资源
                    </span>
                    <div>
                      {item.archived ? (
                        <Status>已归档</Status>
                      ) : item.pendingCount ? (
                        <Status kind="warning">
                          {item.pendingCount} 处待更新
                        </Status>
                      ) : (
                        <small>
                          {item.publicationCount
                            ? `已登记 ${item.publicationCount} 处发布`
                            : "尚未发布"}
                        </small>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </aside>
          <div className="catalog-detail-region">
            {activeId ? (
              <CatalogWorkspace
                key={activeId}
                id={activeId}
                revision={active?.revision}
                onEdit={setEditor}
                onChanged={list.reload}
                onRemoved={() => {
                  select("");
                  list.reload();
                }}
                onManageAccounts={() => navigate("website-accounts")}
              />
            ) : (
              <Empty title="选择一份清单">
                从左侧打开清单，查看资源和发布记录。
              </Empty>
            )}
          </div>
        </div>
      )}
      {editor ? (
        <CatalogEditor
          key={editor === "new" ? "new" : editor.id}
          catalog={editor === "new" ? undefined : editor}
          categories={data!.resourceTotals.categories}
          workspace={workspace}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setEditor(null);
            select(id);
            list.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CatalogWorkspace({
  id,
  revision,
  onEdit,
  onChanged,
  onRemoved,
  onManageAccounts,
}: {
  id: string;
  revision?: number;
  onEdit(catalog: Catalog): void;
  onChanged(): void;
  onRemoved(): void;
  onManageAccounts(): void;
}) {
  const query = useIpcQuery(
    "resourceCatalog.get",
    { id },
    { keepPrevious: true, revision },
  );
  const [tab, setTab] = useState("preview");
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const { notify } = useAppActions();
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const changed = () => {
    query.reload();
    onChanged();
  };
  const run = async (
    name: string,
    action: () => Promise<unknown>,
    message?: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setPending(name);
    setError("");
    try {
      await action();
      if (message) notify(message, "success");
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending("");
    }
  };
  const detail: CatalogDetail | null = query.data;
  if (!detail)
    return (
      <>
        <QueryError
          error={query.error}
          loading={query.loading}
          onRetry={query.reload}
        />
        {query.loading ? <LoadingState label="正在整理清单内容…" /> : null}
      </>
    );
  const { catalog, current } = detail;
  return (
    <>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      <section className="catalog-detail-header">
        <div>
          <div className="catalog-title-line">
            <h2>{catalog.title}</h2>
            {catalog.archived ? (
              <Status>已归档</Status>
            ) : (
              <Status kind="good">维护中</Status>
            )}
          </div>
          <p className="muted">
            {catalog.category === "all" ? "全部分类" : catalog.category} ·{" "}
            {current.items.length} 项可访问资源 · {detail.publications.length}{" "}
            处发布
          </p>
        </div>
        <div className="catalog-detail-actions">
          <Button
            quiet
            size="compact"
            disabled={!!pending || query.loading}
            onClick={changed}
          >
            <RefreshCw size={15} />
            刷新资源
          </Button>
          <Button
            quiet
            size="compact"
            disabled={!!pending || catalog.archived}
            onClick={() => onEdit(catalog)}
          >
            <FilePenLine size={15} />
            编辑
          </Button>
          <Button
            quiet
            size="compact"
            disabled={!!pending}
            onClick={() =>
              void run("export", async () => {
                const path = await ipc("resourceCatalog.export", {
                  id,
                  format: "xlsx",
                });
                if (path) notify("清单文件已导出。", "success");
              })
            }
          >
            <Download size={15} />
            {pending === "export" ? "正在导出…" : "导出 Excel"}
          </Button>
          <Button
            quiet
            size="compact"
            disabled={!!pending}
            onClick={() =>
              void run(
                "archive",
                async () => {
                  await ipc("resourceCatalog.archive", {
                    id,
                    expectedRevision: catalog.revision,
                    archived: !catalog.archived,
                  });
                  changed();
                },
                catalog.archived
                  ? "已恢复清单维护。"
                  : "清单已归档，远端文档仍保留。",
              )
            }
          >
            <Archive size={15} />
            {catalog.archived ? "恢复维护" : "归档"}
          </Button>
          {catalog.archived ? (
            <Button
              quiet
              size="compact"
              disabled={!!pending}
              onClick={() => setRemoving(true)}
              aria-label="删除本地清单"
            >
              <Trash2 size={15} />
            </Button>
          ) : null}
        </div>
      </section>
      {error ? (
        <div role="alert">
          <Notice danger>{error}</Notice>
        </div>
      ) : null}
      {catalog.archived ? (
        <Notice>
          此清单已归档，仍可查看和导出。需要更新文档时，请先恢复维护。
        </Notice>
      ) : null}
      <Tabs value={tab} onChange={setTab}>
        <TabList
          label="清单工作区"
          items={[
            ["preview", "资源预览"],
            [
              "publishing",
              `发布维护${detail.publications.some((p) => p.needsUpdate) ? " · 待更新" : ""}`,
            ],
          ]}
        />
        <TabPanel value={tab}>
          {tab === "preview" ? (
            <CatalogPreview snapshot={current} />
          ) : (
            <CatalogPublishing
              detail={detail}
              onChanged={changed}
              onManageAccounts={onManageAccounts}
            />
          )}
        </TabPanel>
      </Tabs>
      {removing ? (
        <Dialog
          title="删除本地清单"
          busy={!!pending}
          onClose={() => setRemoving(false)}
          footer={
            <>
              <Button disabled={!!pending} onClick={() => setRemoving(false)}>
                保留清单
              </Button>
              <Button
                disabled={!!pending}
                onClick={() =>
                  void run(
                    "remove",
                    async () => {
                      await ipc("resourceCatalog.remove", {
                        id,
                        expectedRevision: catalog.revision,
                        confirmed: true,
                      });
                      if (alive.current) onRemoved();
                    },
                    "本地清单已删除。",
                  )
                }
              >
                删除本地记录
              </Button>
            </>
          }
        >
          <Notice warning>
            将删除此清单的本地配置、版本与发布记录。已发布的云端文档不会删除，请先确认不再需要这些维护记录。
          </Notice>
        </Dialog>
      ) : null}
    </>
  );
}
