import { Loading } from "./DataState";
import { QueryError } from "./QueryError";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}
/** Shared searchable selection; the caller owns data reads and scope. */
export function SearchSelect({
  label,
  items,
  value,
  onChange,
  onQueryChange,
  onOpenChange,
  loading = false,
  error = "",
  onRetry,
}: {
  label: string;
  items: SelectOption[];
  value: SelectOption;
  onChange(value: string): void;
  onQueryChange?(query: string): void;
  onOpenChange?(open: boolean): void;
  loading?: boolean;
  error?: string;
  onRetry?(): void;
}) {
  return (
    <Combobox.Root
      items={items}
      value={value}
      isItemEqualToValue={(a, b) => a.value === b.value}
      filter={onQueryChange ? null : undefined}
      onValueChange={(next) => {
        if (next) onChange(next.value);
      }}
      onInputValueChange={(query, details) => {
        if (
          ["input-change", "input-clear", "clear-press"].includes(
            details.reason,
          )
        )
          onQueryChange?.(query);
      }}
      onOpenChange={(open) => {
        onOpenChange?.(open);
        if (!open) onQueryChange?.("");
      }}
    >
      <Combobox.InputGroup className="input-frame search-select">
        <Combobox.Input aria-label={label} placeholder="输入标题搜索资源…" />
        <Combobox.Trigger aria-label={`展开${label}`}>
          <ChevronsUpDown size={15} />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner
          sideOffset={5}
          className="select-positioner"
          align="start"
        >
          <Combobox.Popup className="select-popup">
            {loading ? (
              <Combobox.Status className="select-feedback">
                <Loading label="正在读取…" announce={false} />
              </Combobox.Status>
            ) : null}
            {error ? (
              <QueryError
                error={error}
                loading={loading}
                onRetry={() => onRetry?.()}
              />
            ) : null}
            {!loading && !error ? (
              <Combobox.Empty className="select-feedback">
                没有匹配资源，试试更短的关键词
              </Combobox.Empty>
            ) : null}
            <Combobox.List>
              {(item: SelectOption) => (
                <Combobox.Item
                  key={item.value}
                  value={item}
                  className="select-option"
                >
                  <span>{item.label}</span>
                  <Combobox.ItemIndicator>
                    <Check size={14} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
