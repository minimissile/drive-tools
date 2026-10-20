import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal } from "lucide-react";
import { Button } from "./primitives";
import "./dropdown-menu.css";

export function DropdownMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button quiet size="compact" aria-label={label} />}>
        <MoreHorizontal size={18} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6} className="menu-positioner">
          <Menu.Popup className="menu-popup" aria-label={label}>
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function MenuAction({
  children,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <Menu.Item className="menu-action" disabled={disabled} onClick={onClick}>
      {children}
    </Menu.Item>
  );
}
