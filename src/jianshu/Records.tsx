import { useState } from "react";
import type { JianshuSummary } from "../../shared/jianshu";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import { Button, Empty, Status } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { Select } from "../ui/Select";
import { formatTime } from "../lib/format";
import { stageLabels } from "./labels";
import { ipc } from "../api/client";
export function Records({
  rows,
  accounts,
  open,
}: {
  rows: JianshuSummary[];
  accounts: WebsiteAccountView[];
  open(id: string): void;
}) {
  const [query, setQuery] = useState(""),
    [stage, setStage] = useState(""),
    [page, setPage] = useState(1);
  const selected = rows.filter(
    (row) =>
      (!stage || row.stage === stage) &&
      row.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="jianshu-records">
      <div className="jianshu-toolbar">
        <input
          aria-label="搜索简书文章"
          placeholder="按文章标题搜索"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <Select
          aria-label="简书文章状态"
          value={stage}
          onValueChange={(value) => {
            setStage(value);
            setPage(1);
          }}
          items={[
            { value: "", label: "全部状态" },
            ...Object.entries(stageLabels).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
      </div>
      {selected.length ? (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>文章</th>
                  <th>账号</th>
                  <th>状态</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {selected.slice((page - 1) * 12, page * 12).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.title || "未命名文章"}</strong>
                      <small className="table-note">
                        {row.copyId
                          ? "关联本人资源"
                          : row.sourceIds.length
                            ? `${row.sourceIds.length} 项来源素材`
                            : "手动创作"}
                      </small>
                    </td>
                    <td>
                      {accounts.find((a) => a.id === row.accountId)?.nickname ||
                        accounts.find((a) => a.id === row.accountId)?.alias ||
                        "尚未选择"}
                    </td>
                    <td>
                      <Status
                        kind={
                          row.stage === "published"
                            ? "good"
                            : row.stage === "uncertain"
                              ? "warning"
                              : "normal"
                        }
                      >
                        {stageLabels[row.stage]}
                      </Status>
                      {row.imageReviewRequired ? (
                        <small className="table-note">配图待人工核对</small>
                      ) : null}
                    </td>
                    <td>{formatTime(row.updatedAt)}</td>
                    <td>
                      <div className="jianshu-inline">
                        <Button
                          quiet
                          size="compact"
                          onClick={() => open(row.id)}
                        >
                          {row.stage === "editing" ? "继续编辑" : "查看与核对"}
                        </Button>
                        {row.receiptUrl ? (
                          <Button
                            quiet
                            size="compact"
                            onClick={() =>
                              void ipc("system.external", {
                                url: row.receiptUrl!,
                              })
                            }
                          >
                            查看简书文章
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={12}
            total={selected.length}
            onPageChange={setPage}
            label="简书发布记录分页"
          />
        </>
      ) : (
        <Empty
          title={
            query || stage ? "没有符合条件的文章" : "这里保存你的文章与发布记录"
          }
        >
          {query || stage
            ? "调整筛选条件后再试。"
            : "在创作发布中开始一篇文章，保存后就能在这里继续。"}
        </Empty>
      )}
    </div>
  );
}
