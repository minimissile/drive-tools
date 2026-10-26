import { useId, type ComponentProps, type ReactNode } from "react";

/** A labelled checkbox keeps its spacing and name inside pages and portal dialogs. */
export function CheckboxField({
  label,
  hint,
  className = "",
  ...props
}: Omit<ComponentProps<"input">, "type" | "children"> & {
  label: ReactNode;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <label
      className={`checkbox-field ${className}`}
      data-disabled={props.disabled || undefined}
    >
      <input
        {...props}
        type="checkbox"
        aria-labelledby={
          props["aria-labelledby"] ??
          (props["aria-label"] ? undefined : `${id}-label`)
        }
        aria-describedby={
          props["aria-describedby"] ?? (hint ? `${id}-hint` : undefined)
        }
      />
      <span className="checkbox-field-copy">
        <span id={`${id}-label`}>{label}</span>
        {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
      </span>
    </label>
  );
}
