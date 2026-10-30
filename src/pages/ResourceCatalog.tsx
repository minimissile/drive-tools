import { windowStorage } from "../storage/window-storage";
import { useState } from "react";
import { ListChecks, Plus, RefreshCw, Search } from "lucide-react";
import { useAppData, useAppNavigation } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import type { ResourceCatalog as Catalog } from "../../shared/resource-catalog";
import { Button, Empty, Header, LoadingState, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { CatalogEditor } from "../resource-catalog/CatalogEditor";
import { CatalogWorkspace } from "../resource-catalog/CatalogWorkspace";
import "../resource-catalog/resource-catalog.css";

export default function ResourceCatalog() {
  const { data } = useAppData();
  const { navigate } = useAppNavigation();
  const workspace = data!.dataPath;
  const selectionKey = `panxu-catalog-selection:${workspace}`;
  const [selected, setSelected] = useState(() => {
    try {
      return windowStorage.getItem(selectionKey) ?? "";
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
      windowStorage.setItem(selectionKey, id);
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
