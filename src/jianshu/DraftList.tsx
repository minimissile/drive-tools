import { RefreshCw } from "lucide-react";
import type { JianshuSummary } from "../../shared/jianshu";
import { formatTime } from "../lib/format";
import { QueryError } from "../ui/QueryError";
import {
  Button,
  Empty,
  LoadingState,
  SearchField,
  Status,
} from "../ui/primitives";
import { localServiceError, stageLabels } from "./labels";

export function DraftList({
  rows,
  selected,
  query,
  loading,
  error,
  onSearch,
  onOpen,
  onReload,
}: {
  rows: JianshuSummary[] | null | undefined;
  selected: string;
  query: string;
  loading: boolean;
  error: string;
  onSearch(query: string): void;
  onOpen(id: string): void;
  onReload(): void;
}) {
  const keyword = query.trim().toLocaleLowerCase();
  const matching = rows?.filter((row) =>
    (row.title || "未命名文章").toLocaleLowerCase().includes(keyword),
  );

  return (
    <aside className="jianshu-draft-list" aria-label="简书文章列表">
      <div className="jianshu-draft-list-heading">
        <h2>文章</h2>
        <Button
          quiet
          size="compact"
          aria-label="刷新文章列表"
          title="刷新文章列表"
          disabled={loading}
          onClick={onReload}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      </div>
      <SearchField
        label="搜索简书文章"
        placeholder="搜索文章标题"
        value={query}
        onChange={onSearch}
      />
      <QueryError
        error={localServiceError(error)}
        loading={loading}
        onRetry={onReload}
      />
      {!rows && !error ? (
        <LoadingState compact label="正在读取文章…" />
      ) : matching?.length ? (
        <ul>
          {matching.map((row) => {
            const title = row.title || "未命名文章";
            const timestamp = formatTime(row.updatedAt);
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className="jianshu-draft-entry"
                  data-article-id={row.id}
                  aria-label={title}
                  aria-describedby={`jianshu-draft-meta-${row.id}`}
                  aria-current={selected === row.id ? "page" : undefined}
                  aria-controls="jianshu-current-article"
                  title={title}
                  onClick={() => onOpen(row.id)}
                >
                  <strong>{title}</strong>
                  <span
                    className="jianshu-draft-entry-meta"
                    id={`jianshu-draft-meta-${row.id}`}
                  >
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
                    <time dateTime={row.updatedAt} title={timestamp}>
                      {timestamp.split(" ")[0]}
                    </time>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : matching ? (
        <Empty compact title={keyword ? "没有匹配的文章" : "还没有文章"}>
          {keyword ? "试试文章标题里的其他关键词。" : null}
        </Empty>
      ) : null}
    </aside>
  );
}
