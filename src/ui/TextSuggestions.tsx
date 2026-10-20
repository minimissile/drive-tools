import { Autocomplete } from "@base-ui/react/autocomplete";
import { useState, type ComponentProps } from "react";

export interface TextSuggestion {
  value: string;
  label: string;
}
type Props = Omit<ComponentProps<"input">, "value" | "onChange" | "list"> & {
  value: string;
  items: TextSuggestion[];
  onValueChange(value: string): void;
  showAllOnOpen?: boolean;
};

/** Suggestions never restrict free text, including IDs missing from an offline catalog. */
export function TextSuggestions({
  value,
  items,
  onValueChange,
  disabled,
  showAllOnOpen = false,
  ...props
}: Props) {
  const [openedValue, setOpenedValue] = useState<string | null>(null);
  return (
    <Autocomplete.Root
      items={items}
      value={value}
      onValueChange={onValueChange}
      onOpenChange={(open) =>
        setOpenedValue(
          open && items.some((item) => item.value === value) ? value : null,
        )
      }
      itemToStringValue={(item) => item.value}
      filter={(item, query) =>
        (showAllOnOpen && query === openedValue) ||
        `${item.label} ${item.value}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())
      }
      openOnInputClick
      disabled={disabled}
    >
      <Autocomplete.Input {...props} />
      <Autocomplete.Portal>
        <Autocomplete.Positioner
          className="select-positioner"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <Autocomplete.Popup className="select-popup">
            <Autocomplete.Empty>
              没有匹配项，可直接使用输入内容
            </Autocomplete.Empty>
            <Autocomplete.List>
              {(item: TextSuggestion) => (
                <Autocomplete.Item
                  key={item.value}
                  value={item}
                  className="select-option"
                >
                  <span className="suggestion-label">
                    {item.label}
                    {item.value !== item.label ? (
                      <small>{item.value}</small>
                    ) : null}
                  </span>
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
