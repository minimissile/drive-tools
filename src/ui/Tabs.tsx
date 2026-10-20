import type { ReactNode } from "react";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";

export function Tabs<T extends string>({
  value,
  onChange,
  children,
  className,
}: {
  value: T;
  onChange(value: T): void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseTabs.Root
      className={className}
      value={value}
      onValueChange={(next) => onChange(next as T)}
    >
      {children}
    </BaseTabs.Root>
  );
}

export function TabList<T extends string>({
  label,
  items,
}: {
  label: string;
  items: readonly (readonly [T, ReactNode])[];
}) {
  return (
    <BaseTabs.List className="tabs" aria-label={label} activateOnFocus>
      {items.map(([value, label]) => (
        <BaseTabs.Tab key={value} value={value}>
          {label}
        </BaseTabs.Tab>
      ))}
    </BaseTabs.List>
  );
}

export function TabPanel({
  value,
  children,
  keepMounted = false,
}: {
  value: string;
  children: ReactNode;
  keepMounted?: boolean;
}) {
  return (
    <BaseTabs.Panel
      className="tab-panel"
      value={value}
      keepMounted={keepMounted}
    >
      {children}
    </BaseTabs.Panel>
  );
}
