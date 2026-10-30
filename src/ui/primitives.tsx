import { DataState } from "./DataState";
export { Loading, LoadingState } from "./DataState";
import { FieldLabelContext } from "./field-label";
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type ComponentProps,
} from "react";
import { ArrowRight, LoaderCircle, Search, X } from "lucide-react";
export function Button({
  primary = false,
  quiet = false,
  size = "default",
  children,
  className = "",
  ...props
}: ComponentProps<"button"> & {
  primary?: boolean;
  quiet?: boolean;
  size?: "default" | "compact";
}) {
  return (
    <button
      type="button"
      data-size={size}
      className={`button ${primary ? "primary" : ""} ${quiet ? "quiet" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function Header({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active === document.body || active?.closest('nav[aria-label="主导航"]'))
      heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className="page-heading">
      <div>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </header>
  );
}
export function Panel({
  title,
  extra,
  children,
  className = "",
  ...props
}: {
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<"section">, "title">) {
  return (
    <section {...props} className={`panel ${className}`}>
      {title || extra ? (
        <div className="panel-heading">
          {title ? <h2>{title}</h2> : null}
          {extra}
        </div>
      ) : null}
      {children}
    </section>
  );
}
export function Field({
  label,
  hint,
  children,
  required,
  as: Element = "label",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
  as?: "label" | "div";
}) {
  const labelId = useId();
  return (
    <FieldLabelContext value={labelId}>
      <Element className="field">
        <span>
          <span id={labelId}>
            {label}
            {required ? <em className="required"> *</em> : null}
          </span>
          {hint ? <small>{hint}</small> : null}
        </span>
        {children}
      </Element>
    </FieldLabelContext>
  );
}
export function Notice({
  children,
  danger = false,
  warning = false,
}: {
  children: ReactNode;
  danger?: boolean;
  warning?: boolean;
}) {
  return (
    <div className={`notice ${danger ? "danger" : warning ? "warning" : ""}`}>
      {children}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
  fill = false,
  compact = false,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  fill?: boolean;
  compact?: boolean;
}) {
  return (
    <DataState
      kind="empty"
      title={title}
      action={action}
      fill={fill}
      compact={compact}
      className="empty"
    >
      {children}
    </DataState>
  );
}
export function Status({
  children,
  kind = "normal",
}: {
  children: ReactNode;
  kind?: "normal" | "good" | "warning" | "danger";
}) {
  return (
    <span className={`status ${kind}`}>
      <i />
      {children}
    </span>
  );
}
export function SearchField({
  value,
  onChange,
  placeholder = "搜索标题、标签或资源说明…",
  label = placeholder,
  className = "",
  loading = false,
}: {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  label?: string;
  className?: string;
  loading?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={`input-frame search ${className}`}>
      {loading ? (
        <LoaderCircle size={16} className="spin" aria-hidden="true" />
      ) : (
        <Search size={16} aria-hidden="true" />
      )}
      <input
        ref={input}
        aria-label={label}
        aria-busy={loading}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value ? (
        <button
          type="button"
          aria-label="清空搜索"
          title="清空搜索"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
export const NextArrow = () => <ArrowRight size={15} />;
