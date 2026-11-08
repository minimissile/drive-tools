import { useId, useState, type ReactElement, type ReactNode } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import "./tooltip.css";

/** Short supplemental text, available to pointer and keyboard users. */
export function Tooltip({
  trigger,
  children,
}: {
  trigger: ReactElement<{ "aria-describedby"?: string }>;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <BaseTooltip.Provider delay={200}>
      <BaseTooltip.Root open={open} onOpenChange={setOpen}>
        <BaseTooltip.Trigger
          render={trigger}
          aria-describedby={
            open
              ? [trigger.props["aria-describedby"], id]
                  .filter(Boolean)
                  .join(" ")
              : trigger.props["aria-describedby"]
          }
        />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner
            className="tooltip-positioner"
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
          >
            <BaseTooltip.Popup className="tooltip-popup" role="tooltip" id={id}>
              {children}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}
