import { useState } from "react";
import { Empty, LoadingState, SearchField } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { useIpcQuery } from "../api/useIpcQuery";
import { updateSelection } from "../lib/selection";
import "./owned-resource-picker.css";

export function OwnedResourcePicker({
  selected,
  onChange,
  disabled,
  showLinks = true,
}: {
  selected: string[];
  onChange(ids: string[]): void;
  disabled: boolean;
  showLinks?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(1);
  const targets = useIpcQuery(
    "zhidao.targets",
    { query, page },
    { keepPrevious: true, delay: 180 },
  );
  return (
    <>
      <SearchField
        value={query}
        onChange={(value) => {
          setQuery(value);
          setPage(1);
        }}
        label="搜索本人资料"
        placeholder="搜索已核验的本人百度分享"
      />
      <QueryError
        error={targets.error}
        loading={targets.loading}
        onRetry={targets.reload}
      />
      {!targets.data && !targets.error ? (
        <LoadingState compact label="正在读取本人资源…" />
      ) : targets.data?.items.length ? (
        <>
          <label className="check">
            <SelectionCheckbox
              aria-label="选择本页资料"
              disabled={disabled}
              selected={
                targets.data.items.filter((item) =>
                  selected.includes(item.copyId),
                ).length
              }
              total={targets.data.items.length}
              onChange={(event) =>
                onChange(
                  updateSelection(
                    selected,
                    targets.data!.items.map((item) => item.copyId),
                    event.target.checked,
                    100,
                  ),
                )
              }
            />
            选择本页 · 已选{selected.length}份
          </label>
          <div className="owned-resource-list">
            {targets.data.items.map((item) => (
              <label className="operation-target" key={item.copyId}>
                <input
                  type="checkbox"
                  disabled={
                    disabled ||
                    (!selected.includes(item.copyId) && selected.length >= 100)
                  }
                  checked={selected.includes(item.copyId)}
                  onChange={(event) =>
                    onChange(
                      updateSelection(
                        selected,
                        [item.copyId],
                        event.target.checked,
                        100,
                      ),
                    )
                  }
                />
                <span>
                  <strong>{item.title}</strong>
                  {showLinks ? <small>{item.url}</small> : null}
                </span>
              </label>
            ))}
          </div>
          <Pagination
            page={page}
            pageSize={25}
            total={targets.data.total}
            onPageChange={setPage}
            label="本人资源分页"
          />
        </>
      ) : targets.data ? (
        <Empty
          compact
          title={query ? "没有匹配的本人资料" : "还没有已核验的本人百度分享"}
        >
          请先在资源库中完成本人百度网盘资源的核验。
        </Empty>
      ) : null}
    </>
  );
}
