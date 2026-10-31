import {
  ChartNoAxesCombined,
  FileText,
  Fingerprint,
  LogIn,
  Monitor,
  Pencil,
  PenLine,
  Send,
  ShieldCheck,
  SquareArrowOutUpRight,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { isDocumentProvider } from "../../shared/document-platforms";
import { formatTime } from "../lib/format";
import { PlatformIcon } from "../platforms/PlatformIcon";
import { Button, Status } from "../ui/primitives";
import { DropdownMenu, MenuAction } from "../ui/DropdownMenu";
import { otherProviderName, type OtherAccount } from "./useOtherAccounts";
import type { ReactNode } from "react";

export type OtherAccountAction =
  | "login"
  | "check"
  | "document"
  | "smzdm-workflow"
  | "smzdm-editor"
  | "zhihu-operations"
  | "weibo-statistics"
  | "weibo-compose"
  | "weibo-marketing"
  | "weibo-publishing"
  | "zhidao-answer"
  | "zhidao-rights"
  | "environment"
  | "rename"
  | "remove";

export function OtherAccountRow({
  account,
  environment,
  environmentEngine,
  environmentsReady,
  pending,
  failure,
  statisticsOpen,
  onAction,
  children,
}: {
  account: OtherAccount;
  environment: string;
  environmentEngine?: "electron" | "bitbrowser";
  environmentsReady: boolean;
  pending: string | null;
  failure?: string;
  statisticsOpen: boolean;
  onAction(action: OtherAccountAction): void;
  children?: ReactNode;
}) {
  const connected = account.status === "connected";
  const document = isDocumentProvider(account.provider);
  const menu: {
    action: OtherAccountAction;
    label: string;
    icon: ReactNode;
    disabled?: boolean;
  }[] = [];
  if (document && connected)
    menu.push({ action: "document", label: "文档工作台", icon: <FileText /> });
  if (account.provider === "smzdm") {
    menu.push({ action: "smzdm-workflow", label: "文章分发", icon: <Send /> });
    if (connected)
      menu.push({
        action: "smzdm-editor",
        label: "官方编辑器",
        icon: <SquareArrowOutUpRight />,
      });
  }
  if (account.provider === "zhihu")
    menu.push({
      action: "zhihu-operations",
      label: "知乎运营",
      icon: <PenLine />,
    });
  if (account.provider === "weibo") {
    if (account.uid)
      menu.push({
        action: "weibo-statistics",
        label: statisticsOpen ? "收起数据统计" : "数据统计",
        icon: <ChartNoAxesCombined />,
      });
    if (connected)
      menu.push(
        {
          action: "weibo-compose",
          label: "发布微博",
          icon: <Send />,
          disabled: account.checking,
        },
        { action: "weibo-marketing", label: "微博图文", icon: <FileText /> },
        {
          action: "weibo-publishing",
          label: "发布能力",
          icon: <ShieldCheck />,
          disabled: account.checking,
        },
      );
  }
  if (account.provider === "baidu-zhidao" && connected) {
    menu.push({
      action: "zhidao-answer",
      label: "自动答题",
      icon: <WandSparkles />,
    });
    if (account.bulkPermission === false)
      menu.push({
        action: "zhidao-rights",
        label: "获取答题资格",
        icon: <ShieldCheck />,
      });
  }
  if (connected)
    menu.push({
      action: "login",
      label: account.windowOpen ? "返回登录窗口" : "重新登录",
      icon: <LogIn />,
    });
  if (account.provider !== "smzdm" && !document)
    menu.push({
      action: "environment",
      label: "关联浏览器环境",
      icon: <Monitor />,
      disabled: !environmentsReady,
    });
  menu.push({ action: "rename", label: "修改备注", icon: <Pencil /> });
  return (
    <article className="website-account-row">
      <div className="website-account-identity">
        <PlatformIcon platform={account.provider} />
        <div>
          <h3>{account.nickname || account.alias}</h3>
          <div className="website-account-badges">
            <span>{otherProviderName(account.provider)}</span>
            <Status kind={connected ? "good" : "warning"}>
              {account.checking
                ? document
                  ? "正在检查会话"
                  : "正在核实身份"
                : connected
                  ? account.sessionOnly
                    ? "会话已保存"
                    : "已登录"
                  : account.status === "expired"
                    ? "需重新登录"
                    : "待登录"}
            </Status>
          </div>
          <p className="website-account-meta">
            {account.nickname && account.nickname !== account.alias ? (
              <span>备注 {account.alias}</span>
            ) : null}
            <span>
              {account.uid
                ? `UID ${account.uid}`
                : document
                  ? "平台身份未核实"
                  : "尚未识别身份"}
            </span>
            {account.checkedAt ? (
              <span>核验 {formatTime(account.checkedAt)}</span>
            ) : null}
          </p>
        </div>
      </div>
      <div className="website-account-state">
        <p className="website-account-environment">
          {environmentEngine === "bitbrowser" ? (
            <Fingerprint size={13} aria-hidden="true" />
          ) : (
            <Monitor size={13} aria-hidden="true" />
          )}
          {environmentEngine
            ? `${environmentEngine === "bitbrowser" ? "指纹浏览器" : "内置浏览器"} · `
            : ""}
          {environment}
        </p>
        {failure || account.message ? (
          <p
            className={failure ? "website-account-error" : "muted"}
            role={failure ? "alert" : undefined}
          >
            {failure || account.message}
          </p>
        ) : null}
        {account.detail ? <p className="muted">{account.detail}</p> : null}
        {account.provider === "weibo" ? (
          <p className="muted">
            {account.publishing?.verifiedAt
              ? "已记录发布能力"
              : "发布能力待核实"}
          </p>
        ) : null}
        {account.provider === "baidu-zhidao" &&
        connected &&
        account.bulkPermission === false ? (
          <p className="website-account-warning">
            尚未开通发布权益，可在更多操作中获取答题资格。
          </p>
        ) : null}
      </div>
      <div className="website-account-actions">
        {!connected ? (
          <Button
            size="compact"
            disabled={!!pending}
            onClick={() => onAction("login")}
          >
            <LogIn size={14} aria-hidden="true" />
            {pending === account.key
              ? "正在处理…"
              : account.windowOpen
                ? "返回登录窗口"
                : "登录 / 扫码"}
          </Button>
        ) : null}
        <Button
          size="compact"
          disabled={!!pending || account.checking}
          onClick={() => onAction("check")}
        >
          <ShieldCheck size={14} aria-hidden="true" />
          {account.checking ? "正在核实…" : "检查登录"}
        </Button>
        <DropdownMenu label={`更多操作：${account.alias}`}>
          {menu.map((item) => (
            <MenuAction
              key={item.action}
              disabled={!!pending || item.disabled}
              onClick={() => onAction(item.action)}
            >
              {item.icon}
              {item.label}
            </MenuAction>
          ))}
        </DropdownMenu>
        <Button
          quiet
          size="compact"
          className="website-account-remove"
          title={`移除账号：${account.alias}`}
          aria-label={`移除账号：${account.alias}`}
          disabled={!!pending}
          onClick={() => onAction("remove")}
        >
          <Trash2 size={15} aria-hidden="true" />
        </Button>
      </div>
      {children ? (
        <div className="website-account-statistics">{children}</div>
      ) : null}
    </article>
  );
}
