import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Download,
  FilePenLine,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import type {
  CatalogDetail,
  ResourceCatalog as Catalog,
} from "../../shared/resource-catalog";
import { Button, LoadingState, Notice, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Dialog } from "../ui/Dialog";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { CatalogPreview } from "./CatalogPreview";
import { CatalogPublishing } from "./CatalogPublishing";
import { CatalogSitePublishing } from "./CatalogSitePublishing";

export function CatalogWorkspace({
  id,
  revision,
  onEdit,
  onChanged,
  onRemoved,
  onManageAccounts,
  onSettings,
}: {
  id: string;
  revision?: number;
  onEdit(catalog: Catalog): void;
  onChanged(): void;
  onRemoved(): void;
  onManageAccounts(): void;
  onSettings(): void;
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
  const [committed, setCommitted] = useState<CatalogDetail | null>(null);
  const [undo, setUndo] = useState<{
    catalog: Catalog;
    revision: number;
    count: number;
  } | null>(null);
  const { notify } = useAppActions();
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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
  const detail: CatalogDetail | null =
    committed &&
    (!query.data || committed.catalog.revision > query.data.catalog.revision)
      ? committed
      : query.data;
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
  const canUndo =
    undo && undo.revision === catalog.revision && !catalog.archived;
  const removeItems = (resourceIds: string[]) =>
    void run(
      "removeItems",
      async () => {
        const saved = await ipc("resourceCatalog.removeItems", {
          id,
          expectedRevision: catalog.revision,
          resourceIds,
        });
        if (alive.current) {
          setCommitted(saved);
          setUndo({
            catalog,
            revision: saved.catalog.revision,
            count: resourceIds.length,
          });
          changed();
        }
      },
      `已从当前清单删除 ${resourceIds.length} 项，原资源保留。`,
    );
  return (
    <>
      {committed &&
      query.error &&
      committed.catalog.revision >= (query.data?.catalog.revision ?? 0) ? (
        <Notice warning>
          条目变更已保存，重新读取清单失败：{query.error}
          <Button
            size="compact"
            disabled={query.loading}
            onClick={query.reload}
          >
            重新读取
          </Button>
        </Notice>
      ) : (
        <QueryError
          error={query.error}
          loading={query.loading}
          onRetry={query.reload}
        />
      )}
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
            {catalog.selectionMode === "manual"
              ? "手动选取"
              : catalog.category === "all"
                ? "全部分类"
                : catalog.category}{" "}
            · {current.items.length} 项可访问资源 ·{" "}
            {detail.publications.length +
              Number(!!detail.site?.publication?.active)}{" "}
            处发布
          </p>
        </div>
        <div className="catalog-detail-actions">
          <Button
            size="compact"
            disabled={!!pending || query.loading}
            onClick={changed}
          >
            <RefreshCw size={15} />
            刷新资源
          </Button>
          <Button
            size="compact"
            disabled={!!pending || catalog.archived}
            onClick={() => onEdit(catalog)}
          >
            <FilePenLine size={15} />
            编辑
          </Button>
          <Button
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
                  : "清单已归档，站点页面和远端文档仍保留。",
              )
            }
          >
            <Archive size={15} />
            {catalog.archived ? "恢复维护" : "归档"}
          </Button>
          {
            <Button
              size="compact"
              disabled={!!pending}
              onClick={() => setRemoving(true)}
              aria-label="删除本地清单"
            >
              <Trash2 size={15} />
            </Button>
          }
        </div>
      </section>
      {error ? (
        <div role="alert">
          <Notice danger>{error}</Notice>
        </div>
      ) : null}
      {catalog.archived ? (
        <Notice>
          此清单已归档，仍可查看和导出；站点页面和远端文档不会自动撤下。需要更新内容时，请先恢复维护。
        </Notice>
      ) : null}
      {canUndo ? (
        <Notice>
          已删除 {undo.count} 项，仅影响当前清单。已发布页面和文档需单独更新。
          <Button
            size="compact"
            disabled={!!pending || query.loading}
            onClick={() =>
              void run(
                "undoItems",
                async () => {
                  const {
                    revision: _revision,
                    archived: _archived,
                    createdAt: _created,
                    updatedAt: _updated,
                    ...previous
                  } = undo.catalog;
                  const restored = await ipc(
                    previous.selectionMode === "manual"
                      ? "resourceCatalog.saveManual"
                      : "resourceCatalog.save",
                    {
                      ...previous,
                      excludedResourceIds:
                        undo.catalog.excludedResourceIds ?? [],
                      expectedRevision: undo.revision,
                    },
                  );
                  if (alive.current) {
                    setCommitted(restored);
                    setUndo(null);
                    changed();
                  }
                },
                "已撤销上一次条目删除。",
              )
            }
          >
            撤销删除
          </Button>
        </Notice>
      ) : null}
      <Tabs className="catalog-workspace-tabs" value={tab} onChange={setTab}>
        <TabList
          label="清单工作区"
          items={[
            ["preview", "资源预览"],
            [
              "site",
              `落地页站点${detail.site?.pending || (detail.site?.publication?.active && detail.site.needsUpdate) ? " · 待处理" : ""}`,
            ],
            [
              "publishing",
              `文档平台${detail.publications.some((p) => p.needsUpdate) ? " · 待更新" : ""}`,
            ],
          ]}
        />
        <TabPanel value={tab}>
          {tab === "preview" ? (
            <CatalogPreview
              snapshot={current}
              busy={!!pending || query.loading}
              onRemove={catalog.archived ? undefined : removeItems}
            />
          ) : tab === "site" ? (
            <CatalogSitePublishing
              detail={detail}
              onChanged={changed}
              onSettings={onSettings}
            />
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
                disabled={
                  !!pending ||
                  !!detail.site?.publication?.active ||
                  !!detail.site?.pending
                }
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
            将删除此清单的本地配置、版本与发布记录。已发布的云端文档不会删除；站点页面必须先撤下，待核对请求必须先处理。
          </Notice>
          {detail.site?.publication?.active || detail.site?.pending ? (
            <Button
              onClick={() => {
                setRemoving(false);
                setTab("site");
              }}
            >
              前往站点处理
            </Button>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}
