import { useRef, type ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { Button } from "./primitives";
import { useToastHost } from "./ToastLayer";
import "./dialog.css";

export interface DialogProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose(): void;
  busy?: boolean;
  className?: string;
  focus?: "first-control" | "container";
  size?: "default" | "fullscreen";
}

/** Product dialog: protected focus, Escape, focus restoration and one close policy. */
export function Dialog({
  title,
  children,
  footer,
  onClose,
  busy = false,
  className = "",
  focus = "first-control",
  size = "default",
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
        <BaseDialog.Viewport
          className={`modal-viewport${size === "fullscreen" ? " modal-viewport--fullscreen" : ""}`}
        >
          <BaseDialog.Popup
            ref={setPopup}
            className={`modal ${footer != null || size === "fullscreen" ? "modal--structured" : ""} ${size === "fullscreen" ? "modal--fullscreen" : ""} ${className}`}
            aria-busy={busy || undefined}
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
              <BaseDialog.Close
                render={<Button quiet className="dialog-close" />}
                aria-label={size === "fullscreen" ? "退出全屏" : "关闭弹窗"}
                title={size === "fullscreen" ? "退出全屏（Esc）" : "关闭"}
                disabled={busy}
              >
                <X size={18} aria-hidden="true" />
              </BaseDialog.Close>
            </div>
            {footer != null || size === "fullscreen" ? (
              <>
                <div className="dialog-body">{children}</div>
                {footer != null ? (
                  <div className="dialog-actions">{footer}</div>
                ) : null}
              </>
            ) : (
              children
            )}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
