import type { Account } from "../../shared/types";
import { RefreshCw } from "lucide-react";
import { capacitySummary, formatCapacity } from "../../shared/drive-capacity";
import { formatTime } from "../lib/format";
import { Button } from "../ui/primitives";
import "./capacity.css";

export default function Capacity({
  account,
  refreshing = false,
  disabled = false,
  onRefresh,
}: {
  account: Account;
  refreshing?: boolean;
  disabled?: boolean;
  onRefresh?(): void;
}) {
  const record = account.capacity,
    value = record?.value;
  const summary = value ? capacitySummary(value) : null;
  const stale = !!record?.error || account.status !== "connected";
  return (
    <section
      className="account-capacity"
      aria-label={`${account.alias}网盘容量`}
      aria-busy={refreshing}
    >
      <div className="capacity-heading">
        <span>容量使用</span>
        {stale && value ? <span className="tag">上次记录</span> : null}
        {onRefresh ? (
          <Button
            quiet
            size="compact"
            className="capacity-refresh"
            disabled={disabled}
            onClick={onRefresh}
            aria-label={refreshing ? "正在读取容量…" : "刷新容量"}
            title={
              account.status !== "connected"
                ? "登录并核验后可读取容量"
                : "刷新容量"
            }
          >
            <RefreshCw
              size={13}
              className={refreshing ? "spin" : undefined}
              aria-hidden="true"
            />
          </Button>
        ) : null}
      </div>
      <div className="capacity-values">
        <span>
          已使用{" "}
          <strong title={value ? `${value.usedBytes} 字节` : undefined}>
            {value ? formatCapacity(value.usedBytes) : "—"}
          </strong>
        </span>
        <span>
          {" "}
          / 总容量{" "}
          <strong title={value ? `${value.totalBytes} 字节` : undefined}>
            {value ? formatCapacity(value.totalBytes) : "—"}
          </strong>
        </span>
      </div>
      {summary ? (
        <>
          <div
            className={`capacity-meter ${summary.percent >= 90 ? "capacity-warning" : ""}`}
          >
            <progress
              aria-label={`${account.alias}容量使用率`}
              max={100}
              value={summary.percent}
            />
            <span>
              {summary.overLimit
                ? "已超出总容量"
                : summary.full
                  ? "容量已用满"
                  : `已用 ${summary.percent > 0 && summary.percent < 0.1 ? "不足0.1" : Number(summary.percent.toFixed(1))}%`}
            </span>
          </div>
          <p className="capacity-remaining">
            剩余 {formatCapacity(summary.remainingBytes)}
          </p>
        </>
      ) : null}
      <small className="capacity-status" role="status">
        {record?.updatedAt
          ? `容量更新：${formatTime(record.updatedAt)}`
          : account.status === "connected"
            ? "尚未读取容量，可手动刷新。"
            : "登录并核验后可读取容量。"}
        {record?.error ? (
          <span className="capacity-error">刷新未完成：{record.error}</span>
        ) : null}
      </small>
    </section>
  );
}
