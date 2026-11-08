import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { CatalogSnapshot } from "../../shared/resource-catalog";
import { ipc } from "../api/client";
import { Button, Empty, SearchField } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { useAppActions } from "../state";
import { updateSelection } from "../lib/selection";

export function CatalogPreview({
  snapshot,
  onRemove,
  busy = false,
}: {
  snapshot: CatalogSnapshot;
  onRemove?(resourceIds: string[]): void;
  busy?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const scroll = useRef<HTMLDivElement>(null);
  const changePage = (next: number) => {
    setPage(next);
    scroll.current?.scrollTo({ top: 0 });
  };
  const [selection, setSelection] = useState({
    snapshotId: snapshot.id,
    ids: [] as string[],
  });
  const { notify } = useAppActions();
  const available = new Set(snapshot.items.map((item) => item.resourceId));
  const selected =
    selection.snapshotId === snapshot.id
      ? selection.ids.filter((id) => available.has(id))
      : [];
  const filtered = snapshot.items.filter((item) =>
    `${item.title} ${item.summary} ${item.tags.join(" ")}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / 20)),
  );
  const items = filtered.slice((currentPage - 1) * 20, currentPage * 20);
  const pageIds = items.map((item) => item.resourceId);
  const selectedOnPage = pageIds.filter((id) => selected.includes(id)).length;
  const select = (ids: string[], checked: boolean) => {
    if (checked && new Set([...selected, ...ids]).size > 2000)
      notify("每次最多选择 2000 项，请先删除已选条目。", "warning");
    setSelection({
      snapshotId: snapshot.id,
      ids: updateSelection(selected, ids, checked, 2000),
    });
  };
  return (
    <section className="catalog-preview" aria-label="公开清单预览">
      <div className="catalog-preview-toolbar">
        <div className="catalog-preview-heading">
          <h2>公开内容预览</h2>
          <p className="muted">
            {query.trim()
              ? `${filtered.length} / ${snapshot.items.length}`
              : snapshot.items.length}{" "}
            项资源 · 已核实本人分享
          </p>
        </div>
        <div className="catalog-preview-actions">
          <SearchField
            className="catalog-search"
            label="搜索清单资源"
            placeholder="搜索资源名称、说明、标签"
            value={query}
            onChange={(value) => {
              setQuery(value);
              changePage(1);
            }}
          />
          {onRemove ? (
            <Button
              size="compact"
              disabled={busy || !selected.length}
              onClick={() => onRemove(selected)}
            >
              <Trash2 size={15} />
              删除所选{selected.length ? `（${selected.length}）` : ""}
            </Button>
          ) : null}
        </div>
      </div>
      {onRemove && selected.length ? (
        <div className="catalog-selection-summary">
          <span>
            已选 {selected.length} 项（跨页保留），删除仅影响当前清单。
          </span>
          <Button
            size="compact"
            disabled={busy}
            onClick={() => select(selected, false)}
          >
            清空选择
          </Button>
        </div>
      ) : null}
      <div
        className="catalog-preview-scroll"
        ref={scroll}
        role="region"
        tabIndex={0}
        aria-label="清单资源内容"
      >
        {snapshot.introduction ? (
          <CatalogIntroduction text={snapshot.introduction} />
        ) : null}
        {snapshot.excluded.length ? (
          <details className="catalog-excluded">
            <summary>{snapshot.excluded.length} 项资源暂未纳入清单</summary>
            <p className="muted">
              可删除不再需要的条目；其余请到资源库完善本人分享或处理失效链接后刷新。
            </p>
            <ul>
              {snapshot.excluded.map((item) => (
                <li key={item.resourceId}>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.reason}</span>
                  </div>
                  {onRemove ? (
                    <Button
                      size="compact"
                      disabled={busy}
                      aria-label={`从清单删除：${item.title}`}
                      onClick={() => onRemove([item.resourceId])}
                    >
                      删除
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {!snapshot.items.length ? (
          <Empty title="清单暂无可发布资源">
            请添加资源并在资源库核实本人分享。未生成分享或失效的资源不会出现在公开清单中。
          </Empty>
        ) : !items.length ? (
          <Empty
            title="没有匹配的资源"
            action={
              <Button
                onClick={() => {
                  setQuery("");
                  changePage(1);
                }}
              >
                清除搜索
              </Button>
            }
          >
            试试更短的关键词。
          </Empty>
        ) : (
          <>
            <div className="catalog-table-scroll">
              <table
                className={`catalog-resource-table${onRemove ? " catalog-resource-table--editable" : ""}`}
              >
                <thead>
                  <tr>
                    {onRemove ? (
                      <th scope="col" className="catalog-selection-column">
                        <input
                          type="checkbox"
                          aria-label="选择本页资源"
                          disabled={busy}
                          checked={
                            !!items.length && selectedOnPage === items.length
                          }
                          ref={(input) => {
                            if (input)
                              input.indeterminate =
                                selectedOnPage > 0 &&
                                selectedOnPage < items.length;
                          }}
                          onChange={(event) =>
                            select(pageIds, event.target.checked)
                          }
                        />
                      </th>
                    ) : null}
                    <th scope="col" className="catalog-resource-column">
                      资源
                    </th>
                    <th scope="col">访问链接</th>
                    {onRemove ? (
                      <th scope="col" className="catalog-remove-column">
                        操作
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr
                      key={item.resourceId}
                      data-selected={
                        selected.includes(item.resourceId) || undefined
                      }
                    >
                      {onRemove ? (
                        <td className="catalog-selection-column">
                          <input
                            type="checkbox"
                            aria-label={`选择资源：${item.title}`}
                            checked={selected.includes(item.resourceId)}
                            disabled={busy}
                            onChange={(event) =>
                              select([item.resourceId], event.target.checked)
                            }
                          />
                        </td>
                      ) : null}
                      <td>
                        <div className="catalog-resource-name">
                          <span>{(currentPage - 1) * 20 + index + 1}</span>
                          <strong>{item.title}</strong>
                        </div>
                        {item.summary ? (
                          <ResourceSummary
                            text={item.summary}
                            title={item.title}
                          />
                        ) : null}
                        {item.tags.length ? (
                          <div className="catalog-tags">
                            {item.tags.map((tag) => (
                              <span key={tag}>{tag}</span>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="catalog-resource-links">
                          {item.links.map((link) => (
                            <div
                              className="catalog-resource-link"
                              key={link.url}
                            >
                              <Button
                                size="compact"
                                title={link.url}
                                onClick={() =>
                                  void ipc("system.external", {
                                    url: link.url,
                                  }).catch((e) =>
                                    notify(
                                      e instanceof Error
                                        ? e.message
                                        : "无法打开链接。",
                                      "error",
                                    ),
                                  )
                                }
                              >
                                {link.provider} · 查看资源
                              </Button>
                              {link.code ? (
                                <small>提取码：{link.code}</small>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </td>
                      {onRemove ? (
                        <td className="catalog-remove-column">
                          <Button
                            size="compact"
                            disabled={busy}
                            aria-label={`从清单删除：${item.title}`}
                            onClick={() => onRemove([item.resourceId])}
                          >
                            删除
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="catalog-privacy-note">
          公开内容不含来源链接、账号身份及内部路径；发布前请核对分享与访问权限。
        </p>
      </div>
      {filtered.length ? (
        <div className="catalog-preview-footer">
          <Pagination
            page={currentPage}
            pageSize={20}
            total={filtered.length}
            onPageChange={changePage}
            label="清单资源分页"
          />
        </div>
      ) : null}
    </section>
  );
}

function CatalogIntroduction({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 100 || text.includes("\n");
  return (
    <div className="catalog-introduction">
      <p data-collapsed={(long && !expanded) || undefined}>{text}</p>
      {long ? (
        <Button
          size="compact"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起介绍" : "展开介绍"}
        </Button>
      ) : null}
    </div>
  );
}

function ResourceSummary({ text, title }: { text: string; title: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 100 || text.split("\n").length > 3;
  return (
    <div className="catalog-resource-summary">
      <p data-collapsed={(long && !expanded) || undefined}>{text}</p>
      {long ? (
        <Button
          size="compact"
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"}说明：${title}`}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起说明" : "展开完整说明"}
        </Button>
      ) : null}
    </div>
  );
}
