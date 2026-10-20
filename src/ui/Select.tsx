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
  value: string | number | undefined;
  items: SelectItem[];
  onValueChange(value: string): void;
};

/** A single selection with native keyboard conventions and an app-owned popup. */
export function Select({
  value,
  items,
  onValueChange,
  className = "",
  disabled,
  id,
  name,
  ...props
}: SelectProps) {
  const fieldLabel = useContext(FieldLabelContext);
  const normalized = items.map((item) => ({
    ...item,
    value: String(item.value),
  }));
  const selectedValue = String(value ?? "");
  return (
    <BaseSelect.Root
      items={normalized}
      value={selectedValue}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
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
        data-value={selectedValue}
      >
        <BaseSelect.Value className="select-value" />
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
