import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Link2,
  LoaderCircle,
} from "lucide-react";
import type { IntakeShareValidation } from "./useIntakeShare";
import type { ReactNode } from "react";

export function IntakeShareStatus({
  id,
  error,
  parsing,
  validation,
  recovery,
}: {
  id: string;
  error: string;
  parsing: boolean;
  validation: IntakeShareValidation | null;
  recovery?: ReactNode;
}) {
  const state = error
    ? "invalid"
    : parsing || validation?.status === "checking"
      ? "checking"
      : (validation?.status ?? "idle");
  const Icon =
    state === "checking"
      ? LoaderCircle
      : state === "valid"
        ? CircleCheck
        : state === "invalid"
          ? CircleX
          : state === "unavailable"
            ? CircleAlert
            : Link2;
  const message =
    error ||
    (parsing ? "正在识别链接与提取码…" : validation?.message) ||
    "离开输入框后自动识别并检查链接有效性。";
  return (
    <div className="intake-share-status" data-state={state}>
      <span
        id={id}
        className="intake-share-status-message"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Icon
          size={16}
          className={state === "checking" ? "spin" : undefined}
          aria-hidden="true"
        />
        <span>
          {state === "unavailable" ? "暂无法检查：" : ""}
          {message}
        </span>
      </span>
      {recovery ? (
        <div className="intake-share-recovery">{recovery}</div>
      ) : null}
    </div>
  );
}
