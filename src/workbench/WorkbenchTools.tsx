import { ArrowRight } from "lucide-react";
import type { Page } from "../state";
import { Button } from "../ui/primitives";
import {
  contentOperations,
  bilibiliOperations,
  csdnOperations,
  resourceOperations,
  smzdmOperations,
  wechatOperations,
  weiboOperations,
  zhihuOperations,
  tiebaOperations,
  type WorkbenchEntry,
} from "../navigation";
import { discoveryEntries } from "../resources/navigation";
import { operationEntries } from "../zhidao/navigation";

interface ToolGroup {
  title: string;
  entries: readonly WorkbenchEntry[];
  layout?: "wide" | "compact";
  columns?: 2 | 3;
  shortcut?: { label: string } & ({ page: Page } | { bindings: true });
}

const groups: readonly ToolGroup[] = [
  { title: "资源发现与采集", entries: discoveryEntries },
  { title: "资源与网盘操作", entries: resourceOperations, columns: 2 },
  { title: "通用内容操作", entries: contentOperations, columns: 2 },
  {
    title: "百度知道答题",
    entries: operationEntries,
    shortcut: { label: "管理知道账号", page: "zhidao-accounts" },
  },
  {
    title: "CSDN 内容操作",
    entries: csdnOperations,
    layout: "wide",
    columns: 3,
    shortcut: { label: "发布窗口设置", bindings: true },
  },
  {
    title: "微博内容操作",
    entries: weiboOperations,
    layout: "compact",
    shortcut: { label: "管理微博账号", page: "website-accounts" },
  },
  {
    title: "哔哩哔哩内容操作",
    entries: bilibiliOperations,
    layout: "compact",
    shortcut: { label: "管理哔哩哔哩账号", page: "bilibili-accounts" },
  },
  {
    title: "微信公众号",
    entries: wechatOperations,
    layout: "compact",
    shortcut: { label: "管理公众号账号", page: "wechat-accounts" },
  },
  { title: "知乎内容操作", entries: zhihuOperations, layout: "compact" },
  {
    title: "百度贴吧",
    entries: tiebaOperations,
    layout: "compact",
    shortcut: { label: "管理贴吧账号", page: "website-accounts" },
  },
  {
    title: "什么值得买",
    entries: smzdmOperations,
    layout: "compact",
    shortcut: { label: "管理值得买账号", page: "smzdm-accounts" },
  },
];

export function WorkbenchTools({
  onOpen,
  onBindings,
}: {
  onOpen(page: Page): void;
  onBindings(): void;
}) {
  return (
    <div className="workbench-tools">
      {groups.map(({ title, entries, shortcut, layout, columns }) => (
        <section
          className={`workbench-group${layout ? ` workbench-group--${layout}` : ""}`}
          aria-label={title}
          key={title}
        >
          <header className="workbench-group-heading">
            <h2>{title}</h2>
            {shortcut ? (
              <Button
                quiet
                size="compact"
                aria-label={shortcut.label}
                title={shortcut.label}
                onClick={() => {
                  if ("page" in shortcut) onOpen(shortcut.page);
                  else onBindings();
                }}
              >
                {"page" in shortcut ? "账号管理" : "窗口设置"}
                <ArrowRight size={13} aria-hidden="true" />
              </Button>
            ) : null}
          </header>
          <div
            className={`workbench-entry-list${columns ? ` workbench-entry-list--${columns}` : ""}`}
          >
            {entries.map(({ page, title, description, Icon }) => (
              <button
                type="button"
                className="workbench-entry"
                key={page}
                aria-label={title}
                aria-description={description}
                title={`${title}\n${description}`}
                data-workbench-entry={page}
                onClick={() => onOpen(page)}
              >
                <Icon size={17} aria-hidden="true" />
                <span>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
