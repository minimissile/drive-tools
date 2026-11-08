import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { useContext, type ComponentProps, type ReactNode } from "react";
import { FieldLabelContext } from "./field-label";

export interface SelectItem {
  value: string | number;
  label: ReactNode;
  disabled?: boolean;
}

type SelectProps = Omit<
  ComponentProps<"button">,
  "value" | "onChange" | "children"
> & {
  items: SelectItem[];
} & (
    | {
        multiple?: false;
        value: string | number | undefined;
        onValueChange(value: string): void;
        placeholder?: never;
        maxSelected?: never;
      }
    | {
        multiple: true;
        value: string[];
        onValueChange(value: string[]): void;
        placeholder: string;
        maxSelected?: number;
      }
  );

/** Single and multiple selection share keyboard conventions, focus and popup styling. */
export function Select({
  value,
  items,
  onValueChange,
  className = "",
  disabled,
  id,
  name,
  multiple = false,
  placeholder,
  maxSelected,
  ...props
}: SelectProps) {
  const fieldLabel = useContext(FieldLabelContext);
  const normalized = items.map((item) => ({
    ...item,
    value: String(item.value),
    disabled:
      item.disabled ||
      (multiple &&
        !!maxSelected &&
        Array.isArray(value) &&
        value.length >= maxSelected &&
        !value.includes(String(item.value))),
  }));
  const selectedValue = multiple ? (value as string[]) : String(value ?? "");
  return (
    <BaseSelect.Root
      multiple={multiple}
      items={normalized}
      value={selectedValue}
      onValueChange={(next) => {
        if (multiple && Array.isArray(next))
          (onValueChange as (value: string[]) => void)(next);
        else if (!multiple && typeof next === "string")
          (onValueChange as (value: string) => void)(next);
      }}
      disabled={disabled}
      id={id}
      name={name}
    >
      <BaseSelect.Trigger
        {...props}
        aria-labelledby={
          props["aria-labelledby"] ??
          (props["aria-label"] ? undefined : fieldLabel)
        }
        className={`select-control ${className}`}
        data-value={
          Array.isArray(selectedValue) ? selectedValue.join(",") : selectedValue
        }
      >
        <BaseSelect.Value className="select-value">
          {multiple
            ? (selected: string[]) =>
                selected.length
                  ? selected
                      .map(
                        (id) =>
                          normalized.find((item) => item.value === id)?.label ??
                          id,
                      )
                      .reduce<ReactNode[]>(
                        (all, label, index) => [
                          ...all,
                          ...(index ? ["、"] : []),
                          label,
                        ],
                        [],
                      )
                  : placeholder
            : undefined}
        </BaseSelect.Value>
        <BaseSelect.Icon className="select-chevron">
          <ChevronDown size={15} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className="select-positioner"
          align="start"
          alignItemWithTrigger={false}
          sideOffset={6}
          collisionPadding={8}
        >
          <BaseSelect.Popup className="select-popup">
            <BaseSelect.List>
              {normalized.map((item) => (
                <BaseSelect.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                  data-value={item.value}
                  className="select-option"
                >
                  <BaseSelect.ItemText>{item.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="select-check">
                    <Check size={14} />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
