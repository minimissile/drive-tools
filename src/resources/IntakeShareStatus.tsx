import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Link2,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "../ui/primitives";
import type { IntakeShareValidation } from "./useIntakeShare";

export function IntakeShareStatus({
  id,
  error,
  parsing,
  validation,
  hasValue,
  onRetry,
}: {
  id: string;
  error: string;
  parsing: boolean;
  validation: IntakeShareValidation | null;
  hasValue: boolean;
  onRetry(): void;
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
          size={15}
          className={state === "checking" ? "spin" : undefined}
          aria-hidden="true"
        />
        <span>
          {state === "unavailable" ? "暂无法检查：" : ""}
          {message}
        </span>
      </span>
      {hasValue ? (
        <Button
          quiet
          size="compact"
          disabled={state === "checking"}
          aria-label={
            state === "idle" ? "检查网盘分享链接" : "重新检查网盘分享链接"
          }
          title={state === "idle" ? "检查链接" : "重新检查"}
          onClick={onRetry}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
