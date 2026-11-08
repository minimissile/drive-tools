import { useEffect, useState } from "react";
import type { Pool, PoolSummary } from "../../shared/types";
import { useIpcQuery } from "../api/useIpcQuery";
import { Button, Field, LoadingState } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";

/** A list row never fetches keyword payloads until it is opened or copied. */
export function TrafficPoolCard({
  pool,
  resourceTitle,
  draftFingerprint,
  onCopy,
  onSearch,
}: {
  pool: PoolSummary;
  resourceTitle: string;
  draftFingerprint: string;
  onCopy(pool: Pool, draftFingerprint: string): void;
  onSearch(): void;
}) {
  const [open, setOpen] = useState(false);
  const [copyRequest, setCopyRequest] = useState<string | null>(null);
  const detail = useIpcQuery(
    "pool.get",
    { id: pool.id },
    {
      enabled: open || copyRequest !== null,
      keepPrevious: true,
    },
  );
  useEffect(() => {
    if (copyRequest === null || !detail.data) return;
    const expected = copyRequest;
    setCopyRequest(null);
    onCopy(detail.data, expected);
  }, [copyRequest, detail.data, onCopy]);
  return (
    <div>
      <strong>{pool.name}</strong>
      <small>
        {pool.keywordCount}个词 · {resourceTitle}
      </small>
      <div className="row compact">
        {pool.preview.map((word) => (
          <span className="tag" key={word.id}>
            {word.word}
          </span>
        ))}
      </div>
      <Button quiet onClick={onSearch}>
        创建搜索选题
      </Button>
      <Button
        quiet
        disabled={copyRequest !== null && detail.loading}
        onClick={() => {
          if (detail.data) onCopy(detail.data, draftFingerprint);
          else setCopyRequest(draftFingerprint);
        }}
      >
        {copyRequest !== null && detail.loading ? "正在读取词池…" : "复制编辑"}
      </Button>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>查看全部关键词</summary>
        {open && detail.loading && !detail.data ? (
          <LoadingState label="正在读取词池…" compact />
        ) : null}
        {open && detail.data ? (
          <Field label="词池关键词">
            <textarea
              readOnly
              rows={7}
              value={detail.data.keywords.map((word) => word.word).join("\n")}
            />
          </Field>
        ) : null}
      </details>
      <QueryError
        title="词池内容读取失败"
        error={detail.error}
        loading={detail.loading}
        onRetry={detail.reload}
      />
    </div>
  );
}
