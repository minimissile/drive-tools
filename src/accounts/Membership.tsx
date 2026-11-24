import type { Account } from "../../shared/types";
import { membershipStatus } from "../../shared/drive-membership";
import { formatTime } from "../lib/format";
import "./membership.css";

export default function Membership({
  account,
  refreshing = false,
}: {
  account: Account;
  refreshing?: boolean;
}) {
  if (account.provider === "cmcc")
    return (
      <section
        className="account-membership"
        aria-label={`${account.alias}会员信息`}
      >
        <div className="membership-heading">
          <strong>会员信息暂未接入</strong>
        </div>
        <p className="membership-expiry">
          请在移动云盘官网查看会员及到期时间。
        </p>
      </section>
    );
  const record = account.membership,
    value = record?.value;
  const status = value ? membershipStatus(value) : "unknown";
  const stale =
    !!(record?.error || account.error) || account.status !== "connected";
  const blocked = !!(record?.error || account.error);
  const label = value
    ? status === "active"
      ? value.tier || "VIP会员"
      : status === "none"
        ? "非VIP会员"
        : status === "expired"
          ? "会员已到期"
          : "平台未提供会员状态"
    : refreshing
      ? "正在读取会员信息…"
      : blocked
        ? "会员信息读取受阻"
        : "会员信息尚未读取";
  return (
    <section
      className="account-membership"
      aria-label={`${account.alias}会员信息`}
      aria-busy={refreshing}
    >
      <div className="membership-heading">
        <strong
          className={status === "active" ? "membership-active" : undefined}
        >
          {label}
        </strong>
        {stale && value ? <span className="tag">上次记录</span> : null}
      </div>
      <p className="membership-expiry">
        {value?.expiresAt
          ? `${status === "expired" ? "到期于" : "到期时间"}：${formatTime(value.expiresAt)}`
          : status === "none"
            ? "到期时间：—"
            : value
              ? "到期时间：平台未提供"
              : blocked
                ? "到期时间：未取得"
                : "到期时间：尚未读取"}
      </p>
      <small className="membership-status">
        {record?.updatedAt
          ? `会员更新：${formatTime(record.updatedAt)}`
          : account.error
            ? "先恢复账号会话，再核验登录或刷新会员信息。"
            : record?.error
              ? "本次未取得会员信息，可稍后刷新。"
              : account.status === "connected"
                ? "点击操作列的刷新按钮读取会员信息。"
                : "登录并核验后可读取会员信息。"}
        {record?.error &&
        record.error !== account.capacity?.error &&
        record.error !== account.error ? (
          <span className="membership-error">
            会员读取未完成：{record.error}
          </span>
        ) : null}
      </small>
    </section>
  );
}
