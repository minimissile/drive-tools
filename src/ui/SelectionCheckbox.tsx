import type { ComponentProps } from "react";

export function SelectionCheckbox({
  selected,
  total,
  ...props
}: Omit<ComponentProps<"input">, "type" | "checked"> & {
  selected: number;
  total: number;
}) {
  return (
    <input
      {...props}
      type="checkbox"
      checked={total > 0 && selected === total}
      ref={(node) => {
        if (node) node.indeterminate = selected > 0 && selected < total;
      }}
    />
  );
}
