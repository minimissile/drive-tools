import type { ReactElement, ReactNode } from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { X } from "lucide-react";
import { Button } from "./primitives";
import "./popover.css";

/** Non-modal quick view: outside click, Escape and trigger focus restoration. */
export function Popover({
  open,
  onOpenChange,
  trigger,
  title,
  children,
  footer,
  className = "",
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactElement;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner
          className="popover-positioner"
          side="top"
          align="end"
          sideOffset={12}
          collisionPadding={16}
          positionMethod="fixed"
        >
          <BasePopover.Popup className={`popover-popup ${className}`}>
            <div className="popover-heading">
              <BasePopover.Title>{title}</BasePopover.Title>
              <BasePopover.Close
                render={<Button quiet size="compact" />}
                aria-label={`收起${title}`}
                title="收起（Esc）"
              >
                <X size={16} aria-hidden="true" />
              </BasePopover.Close>
            </div>
            <div className="popover-body">{children}</div>
            {footer ? <div className="popover-footer">{footer}</div> : null}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
