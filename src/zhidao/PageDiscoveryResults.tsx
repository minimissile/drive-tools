import { useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { Button, Empty, Panel, Status } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { collectionDriveLabels } from "../../shared/resource-collection";
import type { PageDiscoveryRun } from "../../shared/zhidao-page-discovery";
import { useOperationAction } from "./hooks";
import { formatTime } from "../lib/format";
export function PageDiscoveryResults({ run }: { run: PageDiscoveryRun }) {
  const action = useOperationAction();
  const busy = !!action.pending;
  const running = run.status === "running";
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const items = run.items.filter((item) =>
    `${item.title} ${item.keyword} ${item.answerUrl} ${item.answer}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / 25)));
  const open = (url: string) =>
    void action.run(
      "zhidao.open",
      { url },
      undefined,
      "已交给默认浏览器打开回答页",
    );
  return (
    <Panel
      title="命中的回答页"
      className="page-discovery-results"
      extra={
        <div className="page-discovery-actions">
          <Button
            quiet
            size="compact"
            disabled={busy || !run.items.length}
            onClick={() =>
              void action.run("zhidaoPages.export", {
                id: run.id,
                format: "json",
              })
            }
          >
            导出JSON
          </Button>
          <Button
            size="compact"
            disabled={busy || !run.items.length}
            onClick={() =>
              void action.run("zhidaoPages.export", {
                id: run.id,
                format: "csv",
              })
            }
          >
            导出CSV
          </Button>
        </div>
      }
    >
      <div className="page-discovery-result-toolbar">
        <input
          type="search"
          aria-label="筛选发现的回答页"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
          placeholder="筛选标题、关键词或回答页地址"
        />
        <small>
          {filter ? `匹配 ${items.length} / ` : "共 "}
          {run.items.length} 个回答页
        </small>
      </div>
      {items.length ? (
        <div className="table-scroll">
          <table className="page-discovery-table">
            <thead>
              <tr>
                <th>问题与回答页</th>
                <th>回答正文与命中依据</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {items
                .slice((currentPage - 1) * 25, currentPage * 25)
                .map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.title}</strong>
                      <button
                        type="button"
                        className="page-discovery-page-link"
                        disabled={busy}
                        onClick={() => open(item.answerUrl)}
                      >
                        {item.answerUrl}
                        <ExternalLink size={13} />
                      </button>
                      <small>回答 ID：{item.aid}</small>
                    </td>
                    <td>
                      <p className="page-discovery-excerpt">{item.answer}</p>
                      <details>
                        <summary>
                          {item.links.length} 个网盘链接 · 查看回答与链接
                        </summary>
                        <p className="page-discovery-answer">{item.answer}</p>
                        {item.links.map((link) => (
                          <div
                            className="page-discovery-evidence"
                            key={link.url}
                          >
                            <span>{collectionDriveLabels[link.provider]}</span>
                            <span>{link.url}</span>
                            {link.code ? (
                              <small>提取码：{link.code}</small>
                            ) : null}
                          </div>
                        ))}
                      </details>
                    </td>
                    <td>
                      <Status kind="normal">
                        {item.origin === "search" ? "关键词检索" : "指定页面"}
                      </Status>
                      <p>{item.keyword}</p>
                      <small>{formatTime(item.foundAt)}</small>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          icon={Search}
          compact
          title={
            filter
              ? "没有匹配的回答页"
              : running
                ? "正在查找符合条件的回答页"
                : run.status === "paused"
                  ? "检索已暂停，尚无确认结果"
                  : "本轮未找到符合条件的回答页"
          }
        >
          {filter
            ? "调整筛选词，或清空后查看全部结果。"
            : run.status === "paused"
              ? "请查看暂停原因和读取日志，空列表不代表来源没有相关回答。"
              : run.failed
                ? "部分页面未能读取，请先查看下方日志。"
                : "仅保留已读取回答正文且包含网盘链接的页面。"}
        </Empty>
      )}
      {items.length ? (
        <Pagination
          page={currentPage}
          pageSize={25}
          total={items.length}
          onPageChange={setPage}
          label="发现回答页分页"
        />
      ) : null}
    </Panel>
  );
}
