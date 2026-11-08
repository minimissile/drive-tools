import { AiIcon } from "../ui/AiIcon";
import { windowStorage } from "../storage/window-storage";
import { useState } from "react";
import { ListChecks, Plus, RefreshCw } from "lucide-react";
import { useAppData, useAppNavigation } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import type {
  ResourceCatalog as Catalog,
  CatalogSaveInput,
} from "../../shared/resource-catalog";
import {
  Button,
  Empty,
  Header,
  LoadingState,
  SearchField,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { CatalogEditor } from "../resource-catalog/CatalogEditor";
import { CatalogWorkspace } from "../resource-catalog/CatalogWorkspace";
import { CatalogAiDialog } from "../resource-catalog/CatalogAiDialog";
import "../resource-catalog/resource-catalog.css";
import "../ui/workspace.css";

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
  const [aiOpen, setAiOpen] = useState(false);
  const [generated, setGenerated] = useState<{
    input: CatalogSaveInput;
    id: string;
  } | null>(null);
  const newCatalog = () => {
    setGenerated(null);
    setEditor("new");
  };
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
  const activeId = visible.some((item) => item.id === selected)
    ? selected
    : visible[0]?.id || "";
  const active = catalogs.find((item) => item.id === activeId);
  return (
    <div className="workspace-frame catalog-page">
      <Header
        title="资源清单"
        description="描述需求让AI检索资源，或手动整理清单，逐项维护后发布到站点或文档平台。"
        action={
          <div className="catalog-heading-actions">
            <Button size="compact" onClick={() => navigate("website-accounts")}>
              管理文档账号
            </Button>
            <Button size="compact" onClick={newCatalog}>
              <Plus size={16} aria-hidden="true" />
              新建清单
            </Button>
            <Button primary size="compact" onClick={() => setAiOpen(true)}>
              <AiIcon size={16} aria-hidden="true" />
              AI生成清单
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
              <div className="catalog-heading-actions">
                <Button primary onClick={() => setAiOpen(true)}>
                  <AiIcon size={16} aria-hidden="true" />
                  AI生成清单
                </Button>
                <Button onClick={newCatalog}>手动新建</Button>
              </div>
            }
          >
            选择资源分类，审阅本人分享，再发布到盘序站点或交接到飞书、腾讯文档、石墨文档。
          </Empty>
          <div className="catalog-first-run-note">
            <ListChecks size={20} aria-hidden="true" />
            <p>
              站点发布复用已配置的固定入口服务，可直接更新与撤下。文档平台使用「账号管理
              → 其他账号」中的登录，发布后回填分享链接。
            </p>
          </div>
        </div>
      ) : (
        <div className="catalog-layout">
          <aside className="catalog-index" aria-label="资源清单索引">
            <div className="catalog-index-heading">
              <h2>我的清单</h2>
              <Button
                size="compact"
                aria-label="刷新清单列表"
                disabled={list.loading}
                onClick={list.reload}
              >
                <RefreshCw size={15} />
              </Button>
            </div>
            <SearchField
              className="catalog-search"
              label="搜索清单"
              placeholder="搜索清单或分类"
              value={query}
              onChange={setQuery}
            />
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
                    <span className="catalog-index-meta">
                      <span>
                        {item.selectionMode === "manual"
                          ? "手动选取"
                          : item.category === "all"
                            ? "全部分类"
                            : item.category}{" "}
                        · {item.resourceCount} 项资源
                      </span>
                      <span>
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
                      </span>
                    </span>
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
                onEdit={(catalog) => {
                  setGenerated(null);
                  setEditor(catalog);
                }}
                onChanged={list.reload}
                onRemoved={() => {
                  select("");
                  list.reload();
                }}
                onManageAccounts={() => navigate("website-accounts")}
                onSettings={() => navigate("settings")}
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
          key={editor === "new" ? (generated?.id ?? "new") : editor.id}
          catalog={editor === "new" ? undefined : editor}
          categories={data!.resourceTotals.categories}
          workspace={workspace}
          initial={editor === "new" ? generated?.input : undefined}
          draftId={editor === "new" ? generated?.id : undefined}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setEditor(null);
            select(id);
            list.reload();
          }}
        />
      ) : null}
      {aiOpen ? (
        <CatalogAiDialog
          workspace={workspace}
          categories={data!.resourceTotals.categories}
          onClose={() => setAiOpen(false)}
          onGenerated={(input, id) => {
            setAiOpen(false);
            setGenerated({ input, id });
            setEditor("new");
          }}
        />
      ) : null}
    </div>
  );
}
