import { useEffect } from "react";
import { CircleCheck, CircleAlert, TriangleAlert, Info, X } from "lucide-react";
import type { FeedbackMessage } from "../lib/feedback";
import { Button } from "./primitives";
import { ToastPortal } from "./ToastLayer";
import "./toast.css";

const appearances = {
  success: { icon: CircleCheck, label: "成功" },
  error: { icon: CircleAlert, label: "错误" },
  warning: { icon: TriangleAlert, label: "注意" },
  info: { icon: Info, label: "提示" },
};

/** Presentation and reading time only; notification state stays with the caller. */
export function Toast({
  text,
  tone,
  onDismiss,
}: FeedbackMessage & { onDismiss(): void }) {
  const { icon: Icon, label } = appearances[tone];
  const urgent = tone === "error" || tone === "warning";
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [text, onDismiss]);

  return (
    <ToastPortal>
      <div
        className="toast"
        data-tone={tone}
        role={urgent ? "alert" : "status"}
        aria-atomic="true"
        aria-live={urgent ? "assertive" : "polite"}
      >
        <Icon className="toast-icon" size={19} aria-hidden="true" />
        <span className="toast-message">
          <span className="toast-tone-label">{label}：</span>
          {text}
        </span>
        <Button
          className="toast-close"
          aria-label="关闭提示"
          onClick={onDismiss}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
    </ToastPortal>
  );
}
