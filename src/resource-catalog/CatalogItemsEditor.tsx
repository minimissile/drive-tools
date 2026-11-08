import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import type { CatalogEntry } from "../../shared/resource-catalog";
import { useIpcQuery } from "../api/useIpcQuery";
import { updateSelection } from "../lib/selection";
import { Button, Empty, Field, LoadingState, Notice } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";

export function CatalogItemsEditor({
  entries,
  onChange,
  categories,
  disabled,
}: {
  entries: CatalogEntry[];
  onChange(entries: CatalogEntry[]): void;
  categories: string[];
  disabled: boolean;
}) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("all");
  const [page, setPage] = useState(1),
    [selectedPage, setSelectedPage] = useState(1),
    [editing, setEditing] = useState("");
  const resources = useIpcQuery(
    "resourceCatalog.resources",
    { query, category, page },
    { delay: 180 },
  );
  const currentPage = Math.min(
    selectedPage,
    Math.max(1, Math.ceil(entries.length / 20)),
  );
  const visible = entries.slice((currentPage - 1) * 20, currentPage * 20);
  const details = useIpcQuery("resourceCatalog.resourceDetails", {
    ids: visible.map((item) => item.resourceId),
  });
  const known = new Map(details.data?.map((item) => [item.resourceId, item]));
  const selected = new Set(entries.map((item) => item.resourceId));
  const select = (resourceId: string, checked: boolean) => {
    const previous = new Map(entries.map((item) => [item.resourceId, item]));
    onChange(
      updateSelection(
        entries.map((item) => item.resourceId),
        [resourceId],
        checked,
        2000,
      ).map((id) => previous.get(id) ?? { resourceId: id }),
    );
  };
  const patch = (resourceId: string, values: Partial<CatalogEntry>) =>
    onChange(
      entries.map((item) =>
        item.resourceId === resourceId ? { ...item, ...values } : item,
      ),
    );
  const move = (resourceId: string, direction: number) => {
    const index = entries.findIndex((item) => item.resourceId === resourceId),
      next = index + direction;
    if (next < 0 || next >= entries.length) return;
    const values = [...entries];
    [values[index], values[next]] = [values[next], values[index]];
    onChange(values);
  };
  return (
    <div className="catalog-item-editor">
      <section className="catalog-item-source" aria-label="从资源库添加">
        <h3>从资源库添加</h3>
        <input
          type="search"
          value={query}
          disabled={disabled}
          aria-label="搜索待添加资源"
          placeholder="搜索名称、说明或标签"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
        <Select
          value={category}
          disabled={disabled}
          aria-label="待添加资源分类"
          onValueChange={(value) => {
            setCategory(value);
            setPage(1);
          }}
          items={[
            { value: "all", label: "全部分类" },
            ...categories
              .filter((value) => value !== "all")
              .map((value) => ({ value, label: value })),
          ]}
        />
        <QueryError
          error={resources.error}
          loading={resources.loading}
          onRetry={resources.reload}
        />
        {resources.loading && !resources.data ? (
          <LoadingState compact label="正在检索资源库…" />
        ) : resources.data?.items.length ? (
          <div className="catalog-resource-picker">
            {resources.data.items.map((item) => (
              <label key={item.resourceId}>
                <input
                  type="checkbox"
                  checked={selected.has(item.resourceId)}
                  disabled={
                    disabled ||
                    (!selected.has(item.resourceId) && entries.length >= 2000)
                  }
                  onChange={(event) =>
                    select(item.resourceId, event.target.checked)
                  }
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.category || "未分类"}</small>
                </span>
              </label>
            ))}
          </div>
        ) : !resources.error ? (
          <Empty compact title="没有匹配的资源">
            调整关键词或分类后继续查找。
          </Empty>
        ) : null}
        {resources.data ? (
          <Pagination
            label="待添加资源分页"
            page={page}
            pageSize={30}
            total={resources.data.total}
            onPageChange={setPage}
          />
        ) : null}
      </section>
      <section className="catalog-item-selection" aria-label="清单条目维护">
        <div className="catalog-index-heading">
          <h3>清单条目 · {entries.length}</h3>
          <span className="muted">最多2000项</span>
        </div>
        <p className="muted">
          修改仅用于这份清单；移除条目会保留资源库和网盘文件。按“清单条目顺序”展示时可上下调整。
        </p>
        <QueryError
          error={details.error}
          loading={details.loading}
          onRetry={details.reload}
        />
        {details.loading && !details.data && entries.length ? (
          <LoadingState compact label="正在读取条目资料…" />
        ) : null}
        {!entries.length ? (
          <Empty compact title="还没有选入资源">
            从左侧勾选，或使用AI生成清单。
          </Empty>
        ) : (
          <div className="catalog-selected-items">
            {visible.map((entry) => {
              const resource = known.get(entry.resourceId),
                title =
                  entry.title ??
                  resource?.title ??
                  (details.loading ? "正在读取条目…" : "资源已不存在");
              return (
                <article key={entry.resourceId}>
                  <div className="catalog-selected-heading">
                    <strong>{title}</strong>
                    <div className="catalog-item-tools">
                      <Button
                        size="compact"
                        aria-label={`上移：${title}`}
                        disabled={
                          disabled ||
                          entries[0]?.resourceId === entry.resourceId
                        }
                        onClick={() => move(entry.resourceId, -1)}
                      >
                        <ArrowUp size={14} />
                      </Button>
                      <Button
                        size="compact"
                        aria-label={`下移：${title}`}
                        disabled={
                          disabled ||
                          entries.at(-1)?.resourceId === entry.resourceId
                        }
                        onClick={() => move(entry.resourceId, 1)}
                      >
                        <ArrowDown size={14} />
                      </Button>
                      <Button
                        size="compact"
                        aria-label={`编辑条目：${title}`}
                        disabled={disabled || !resource}
                        onClick={() =>
                          setEditing(
                            editing === entry.resourceId
                              ? ""
                              : entry.resourceId,
                          )
                        }
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        size="compact"
                        aria-label={`移除条目：${title}`}
                        disabled={disabled}
                        onClick={() => select(entry.resourceId, false)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                  {!resource && !details.loading && !details.error ? (
                    <Notice warning>
                      资源已不在资源库中，可从此清单移除。
                    </Notice>
                  ) : null}
                  {editing === entry.resourceId && resource ? (
                    <div className="catalog-entry-fields">
                      <Field label="展示标题">
                        <input
                          value={entry.title ?? resource.title}
                          maxLength={300}
                          disabled={disabled}
                          onChange={(event) =>
                            patch(entry.resourceId, {
                              title: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field label="展示分类">
                        <input
                          value={entry.category ?? resource.category}
                          maxLength={60}
                          disabled={disabled}
                          onChange={(event) =>
                            patch(entry.resourceId, {
                              category: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field label="展示说明">
                        <textarea
                          rows={3}
                          value={entry.summary ?? resource.summary}
                          maxLength={12000}
                          disabled={disabled}
                          onChange={(event) =>
                            patch(entry.resourceId, {
                              summary: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field label="标签" hint="使用逗号分隔">
                        <EntryTags
                          value={entry.tags ?? resource.tags}
                          disabled={disabled}
                          onChange={(tags) => patch(entry.resourceId, { tags })}
                        />
                      </Field>
                      <Button
                        size="compact"
                        disabled={disabled}
                        onClick={() =>
                          onChange(
                            entries.map((item) =>
                              item.resourceId === entry.resourceId
                                ? { resourceId: entry.resourceId }
                                : item,
                            ),
                          )
                        }
                      >
                        恢复资源库原内容
                      </Button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
        <Pagination
          label="已选条目分页"
          page={currentPage}
          pageSize={20}
          total={entries.length}
          onPageChange={setSelectedPage}
        />
      </section>
    </div>
  );
}

function EntryTags({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange(tags: string[]): void;
}) {
  const [text, setText] = useState(value.join("，"));
  const serialized = JSON.stringify(value);
  useEffect(() => setText(value.join("，")), [serialized]);
  return (
    <input
      value={text}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        onChange(
          next
            .split(/[,，、\n]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}
