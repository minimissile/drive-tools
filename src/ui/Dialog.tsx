import { useRef, type ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Button } from "./primitives";
import { useToastHost } from "./ToastLayer";

export interface DialogProps {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
  className?: string;
  focus?: "first-control" | "container";
}

/** Product dialog: protected focus, Escape, focus restoration and one close policy. */
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  className = "",
  focus = "first-control",
}: DialogProps) {
  const popup = useRef<HTMLDivElement>(null);
  const setPopup = useToastHost(popup);
  return (
    <BaseDialog.Root
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (busy) details.cancel();
        else if (!open) onClose();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="modal-backdrop" />
        <BaseDialog.Viewport className="modal-viewport">
          <BaseDialog.Popup
            ref={setPopup}
            className={`modal ${className}`}
            initialFocus={(interaction) =>
              focus === "container" || interaction === "touch"
                ? popup.current
                : (popup.current?.querySelector<HTMLElement>(
                    "input:not(:disabled):not([type='hidden']):not([aria-hidden='true']),.select-control:not(:disabled),textarea:not(:disabled)",
                  ) ?? true)
            }
          >
            <div className="panel-heading dialog-heading">
              <BaseDialog.Title>{title}</BaseDialog.Title>
              <BaseDialog.Close render={<Button quiet />} disabled={busy}>
                关闭
              </BaseDialog.Close>
            </div>
            {children}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
