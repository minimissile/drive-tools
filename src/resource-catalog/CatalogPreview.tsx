import { useState } from "react";
import { Search } from "lucide-react";
import type { CatalogSnapshot } from "../../shared/resource-catalog";
import { ipc } from "../api/client";
import { Button, Empty, Notice } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { useAppActions } from "../state";

export function CatalogPreview({ snapshot }: { snapshot: CatalogSnapshot }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const { notify } = useAppActions();
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
  return (
    <section className="catalog-preview" aria-label="公开清单预览">
      <div className="catalog-preview-toolbar">
        <div>
          <h2>公开内容预览</h2>
          <p className="muted">
            {snapshot.items.length} 项资源 · 仅包含已核实的本人分享
          </p>
        </div>
        <label className="catalog-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索清单资源"
            placeholder="搜索资源名称、说明、标签"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      {snapshot.introduction ? (
        <p className="catalog-introduction">{snapshot.introduction}</p>
      ) : null}
      {snapshot.excluded.length ? (
        <details className="catalog-excluded">
          <summary>{snapshot.excluded.length} 项资源暂未纳入清单</summary>
          <p className="muted">
            请到资源库完善本人分享或处理失效链接，然后刷新本页。
          </p>
          <ul>
            {snapshot.excluded.map((item) => (
              <li key={item.resourceId}>
                <strong>{item.title}</strong>
                <span>{item.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {!snapshot.items.length ? (
        <Empty title="此分类暂无可发布资源">
          请先在资源库核实本人分享。未生成分享或失效的资源不会出现在公开清单中。
        </Empty>
      ) : !items.length ? (
        <Empty
          title="没有匹配的资源"
          action={
            <Button
              onClick={() => {
                setQuery("");
                setPage(1);
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
            <table className="catalog-resource-table">
              <thead>
                <tr>
                  <th scope="col">资源</th>
                  <th scope="col">访问链接</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={item.resourceId}>
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
                      {item.links.map((link) => (
                        <div className="catalog-resource-link" key={link.url}>
                          <Button
                            quiet
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={currentPage}
            pageSize={20}
            total={filtered.length}
            onPageChange={setPage}
            label="清单资源分页"
          />
        </>
      )}
      <Notice>
        预览、复制与导出均不包含来源链接、账号身份和内部保存路径。发布前请再核对资源分享及平台访问权限。
      </Notice>
    </section>
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
          quiet
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
