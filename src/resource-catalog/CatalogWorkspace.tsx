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

export function CatalogWorkspace({
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
