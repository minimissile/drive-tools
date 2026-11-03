import { useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";
import { Button, Empty, Field, LoadingState, Panel } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { LogWindow } from "../ui/LogWindow";
import { Pagination } from "../ui/Pagination";

export function SupplyLogs() {
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [follow, setFollow] = useState(true);
  const query = useIpcQuery(
    "contentSupply.logs",
    { page, search },
    { delay: 150, keepPrevious: true, refreshInterval: 3000 },
  );
  return (
    <Panel
      title="供稿运行日志"
      extra={
        <Button
          size="compact"
          onClick={() => {
            setPage(1);
            setFollow(true);
            query.reload();
          }}
        >
          查看最新
        </Button>
      }
    >
      <Field label="搜索事件、消息或编辑单ID">
        <input
          aria-label="搜索供稿日志"
          maxLength={200}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </Field>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!query.data && !query.error ? (
        <LoadingState label="正在读取供稿日志…" />
      ) : null}
      {query.data ? (
        <>
          {query.data.items.length ? (
            <LogWindow
              items={query.data.items}
              label="供稿运行日志"
              context={(entry) => (entry.accountId ? "账号供稿" : "公共素材")}
              follow={follow && page === 1}
              onFollowChange={setFollow}
            />
          ) : (
            <Empty title={search ? "没有匹配的供稿日志" : "尚无供稿运行记录"}>
              采集、编辑保存、生成与交付的实际结果会记录在这里。
            </Empty>
          )}
          <Pagination
            page={query.data.page}
            pageSize={query.data.pageSize}
            total={query.data.total}
            onPageChange={(next) => {
              setPage(next);
              setFollow(next === 1);
            }}
            label="供稿日志分页"
          />
          <p className="supply-muted supply-log-path">
            本地日志：{query.data.folder}
          </p>
        </>
      ) : null}
    </Panel>
  );
}
