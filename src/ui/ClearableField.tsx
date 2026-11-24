import { X } from "lucide-react";
import {
  useContext,
  useRef,
  type ChangeEvent,
  type ComponentPropsWithoutRef,
} from "react";
import { FieldLabelContext } from "./field-label";

type InputProps = ComponentPropsWithoutRef<"input">;
type Props = {
  value: string;
  onValueChange(value: string): void;
  clearLabel: string;
} & Pick<
  InputProps,
  | "id"
  | "aria-labelledby"
  | "aria-label"
  | "aria-describedby"
  | "aria-invalid"
  | "placeholder"
  | "disabled"
  | "maxLength"
  | "required"
> &
  (
    | {
        multiline: true;
        rows: number;
        type?: never;
        min?: never;
        max?: never;
        step?: never;
      }
    | ({ multiline?: false; rows?: never } & Pick<
        InputProps,
        "type" | "min" | "max" | "step"
      >)
  );

export function ClearableField({
  value,
  onValueChange,
  clearLabel,
  multiline,
  rows,
  type,
  min,
  max,
  step,
  ...attributes
}: Props) {
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const fieldLabel = useContext(FieldLabelContext);
  const shared = {
    ...attributes,
    "aria-labelledby": attributes["aria-labelledby"] ?? fieldLabel,
    value,
    ref: (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      input.current = node;
    },
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onValueChange(event.currentTarget.value),
  };
  return (
    <div
      className={`input-frame clearable-field${multiline ? " clearable-field--multiline" : ""}`}
    >
      {multiline ? (
        <textarea rows={rows} {...shared} />
      ) : (
        <input type={type} min={min} max={max} step={step} {...shared} />
      )}
      {value ? (
        <button
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          disabled={attributes.disabled}
          onClick={() => {
            onValueChange("");
            input.current?.focus();
          }}
        >
          <X size={15} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
