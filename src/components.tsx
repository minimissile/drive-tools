import {
  useEffect,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import {
  ArrowRight,
  File,
  Folder,
  LoaderCircle,
  Plus,
  Search,
} from "lucide-react";
import { useApp } from "./state";
import type { Account, ResourceCopy } from "../shared/types";
export const providerName = (provider: string) =>
  provider === "quark" ? "夸克" : "百度";
export function Button({
  primary = false,
  quiet = false,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      className={`button ${primary ? "primary" : ""} ${quiet ? "quiet" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function Header({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
export function Panel({
  title,
  extra,
  children,
  className = "",
}: {
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title || extra ? (
        <div className="panel-heading">
          <h2>{title}</h2>
          {extra}
        </div>
      ) : null}
      {children}
    </section>
  );
}
export function Field({
  label,
  hint,
  children,
  required,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required ? <em className="required"> *</em> : null}
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </label>
  );
}
export function Notice({
  children,
  danger = false,
  warning = false,
}: {
  children: ReactNode;
  danger?: boolean;
  warning?: boolean;
}) {
  return (
    <div className={`notice ${danger ? "danger" : warning ? "warning" : ""}`}>
      {children}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <Folder size={24} />
      </div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}
export function Status({
  children,
  kind = "normal",
}: {
  children: ReactNode;
  kind?: "normal" | "good" | "warning" | "danger";
}) {
  return (
    <span className={`status ${kind}`}>
      <i />
      {children}
    </span>
  );
}
export function CopyStatus({ copy }: { copy: ResourceCopy }) {
  const good = copy.status === "ready";
  return (
    <Status
      kind={
        good
          ? "good"
          : ["failed", "needs_review", "waiting_login"].includes(copy.status)
            ? "warning"
            : "normal"
      }
    >
      {stageName(copy.status)}
    </Status>
  );
}
export function stageName(value: string) {
  return (
    (
      {
        draft: "草稿",
        ready: "已归档",
        queued: "等待执行",
        preflight: "预检中",
        transferring: "转存中",
        verifying: "核验文件",
        sharing: "创建本人分享",
        archiving: "本地归档",
        completed: "已完成",
        waiting_login: "等待原账号登录",
        needs_review: "需要核对远端结果",
        failed: "需要处理",
        cancelled: "已停止本地等待",
      } as Record<string, string>
    )[value] ?? value
  );
}
export function accountLabel(accounts: Account[], id: string) {
  return accounts.find((a) => a.id === id)?.alias ?? "历史账号";
}
export function ResourcePicker() {
  const { data, resource, copy, select } = useApp();
  if (!resource) return null;
  return (
    <div className="context-bar">
      <span>当前资源</span>
      <select
        aria-label="当前资源"
        value={resource.id}
        onChange={(e) => select(e.target.value)}
      >
        {(data?.resources.some((r) => r.id === resource.id)
          ? data.resources
          : [resource, ...(data?.resources ?? [])]
        ).map((r) => (
          <option key={r.id} value={r.id}>
            {r.title}
          </option>
        ))}
      </select>
      <select
        aria-label="资源副本账号"
        value={copy?.id ?? ""}
        onChange={(e) => select(resource.id, e.target.value)}
      >
        {resource.copies.map((c) => (
          <option key={c.id} value={c.id}>
            {accountLabel(data?.accounts ?? [], c.accountId)}
          </option>
        ))}
      </select>
      {copy ? <CopyStatus copy={copy} /> : null}
    </div>
  );
}
export function ResourceRequired({ children }: { children: ReactNode }) {
  const { resource, edit, data } = useApp();
  if (!resource && (data?.resourceTotals.resources ?? 0) > 0)
    return <Loading label="正在读取所选资源…" />;
  return resource ? (
    children
  ) : (
    <Empty
      title="先录入一份资源"
      action={
        <Button primary onClick={() => edit(null)}>
          <Plus size={16} />
          录入资源
        </Button>
      }
    >
      资源说明、文件清单和本人分享会一起用于后续内容工作。
    </Empty>
  );
}
export function Cover({
  id,
  title,
  large = false,
}: {
  id: string | null;
  title: string;
  large?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (id)
      void window.panxu
        .invoke<string>("cover.get", { id })
        .then((value) => {
          if (alive) setSrc(value);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  return src ? (
    <img
      className={`resource-cover ${large ? "large" : ""}`}
      src={src}
      alt={`${title}封面`}
    />
  ) : (
    <div className={`resource-cover placeholder ${large ? "large" : ""}`}>
      <File size={large ? 28 : 17} />
      <span>{title.slice(0, large ? 16 : 8)}</span>
    </div>
  );
}
export function Loading({ label = "正在处理…" }: { label?: string }) {
  return (
    <span className="loading">
      <LoaderCircle size={16} className="spin" />
      {label}
    </span>
  );
}
export function RecoverShare({ copy }: { copy: ResourceCopy }) {
  const { command, busy } = useApp(),
    [open, setOpen] = useState(false),
    [text, setText] = useState(""),
    [code, setCode] = useState("");
  if (!copy.verifiedAt || !copy.files.length) return null;
  return (
    <>
      <Button quiet onClick={() => setOpen(true)}>
        恢复本人分享
      </Button>
      {open ? (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="恢复本人分享"
          >
            <div className="panel-heading">
              <h2>恢复本人分享</h2>
              <Button quiet onClick={() => setOpen(false)}>
                关闭
              </Button>
            </div>
            <Notice>
              在原账号网盘中核对或创建分享，再粘贴到这里。应用会同时核验本人分享记录、目标文件与链接；来源链接不能使用。
            </Notice>
            <div className="row" style={{ margin: "16px 0" }}>
              <Button
                disabled={busy > 0}
                onClick={async () => {
                  if (
                    await command(
                      "copy.createShare",
                      { copyId: copy.id },
                      "本人分享已核验并保存。",
                    )
                  )
                    setOpen(false);
                }}
              >
                查找或新建本人分享
              </Button>
            </div>
            <small>
              先核验目标文件并查找已有有效分享；没有有效分享时创建一个新链接，不重新转存文件。
            </small>
            <Field label="本人分享链接">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
            <Field label="提取码">
              <input value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <div className="actions">
              <Button
                primary
                disabled={!text || busy > 0}
                onClick={async () => {
                  if (
                    await command(
                      "copy.recoverShare",
                      { copyId: copy.id, text, code },
                      "本人分享已核验并恢复。",
                    )
                  )
                    setOpen(false);
                }}
              >
                核验并恢复
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
export function SearchField({
  value,
  onChange,
  placeholder = "搜索标题、标签或资源说明…",
}: {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
}) {
  return (
    <div className="search">
      <Search size={16} />
      <input
        aria-label={placeholder}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
export const NextArrow = () => <ArrowRight size={15} />;
export const formatMoney = (value: number | null, currency = "CNY") =>
  value == null
    ? "未配置"
    : `${currency === "USD" ? "$" : "¥"}${(value / 1_000_000).toFixed(currency === "USD" ? 6 : 4)}`;
export const formatTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未提供";
export const formatSize = (value: number | null) =>
  value == null
    ? "未提供"
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(2)} GB`
      : value >= 1024 ** 2
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${Math.ceil(value / 1024)} KB`;
