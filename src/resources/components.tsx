import { Select } from "../ui/Select";
import "./resources.css";
import { SearchSelect } from "../ui/SearchSelect";
import { useIpcQuery } from "../api/useIpcQuery";
import { useState, type ReactNode } from "react";
import { File, Plus } from "lucide-react";
import { useAppData, useAppNavigation, useAppSelection } from "../state";
import type { ResourceCopy } from "../../shared/types";
import { Button, Empty, LoadingState, Status } from "../ui/primitives";
import { accountLabel, stageName } from "./labels";
import { copyShareStatus } from "../../shared/share-status";
export function CopyStatus({ copy }: { copy: ResourceCopy }) {
  const { data } = useAppData();
  const account = data?.accounts.find((item) => item.id === copy.accountId);
  const check = data?.shareChecks.find((item) => item.copyId === copy.id);
  const share = copyShareStatus(copy, account, check);
  const displayShare = ["ready", "recorded"].includes(copy.status);
  return (
    <Status
      kind={
        displayShare
          ? share.kind
          : ["failed", "needs_review", "waiting_login"].includes(copy.status)
            ? "warning"
            : "normal"
      }
    >
      {displayShare ? share.label : stageName(copy.status)}
    </Status>
  );
}
export function ResourcePicker() {
  const { data } = useAppData(),
    { resource, copy, select } = useAppSelection();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const results = useIpcQuery(
    "resource.page",
    { query, page: 1, pageSize: 50 },
    { enabled: open, delay: 180, invalidate: data?.resources },
  );
  if (!resource) return null;
  return (
    <div className="context-bar">
      <span>当前资源</span>
      <SearchSelect
        label="当前资源"
        value={{ value: resource.id, label: resource.title }}
        items={(results.data?.items ?? (open ? [] : [resource])).map((r) => ({
          value: r.id,
          label: r.title,
        }))}
        onChange={(id) => select(id)}
        onQueryChange={setQuery}
        onOpenChange={setOpen}
        loading={results.loading}
        error={results.error}
        onRetry={results.reload}
      />
      <Select
        aria-label="资源副本账号"
        value={copy?.id ?? ""}
        onValueChange={(nextValue) => select(resource.id, nextValue)}
        items={[
          ...resource.copies.map((c) => ({
            value: c.id,
            label: accountLabel(data?.accounts ?? [], c.accountId),
          })),
        ]}
      />
      {copy ? <CopyStatus copy={copy} /> : null}
    </div>
  );
}
export function ResourceRequired({ children }: { children: ReactNode }) {
  const { data } = useAppData(),
    { resource } = useAppSelection(),
    { edit } = useAppNavigation();
  if (!resource && (data?.resourceTotals.resources ?? 0) > 0)
    return <LoadingState label="正在读取所选资源…" />;
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
  const { data: src } = useIpcQuery(
    "cover.get",
    { id: id ?? "" },
    { enabled: !!id },
  );
  return src ? (
    <img
      className={`resource-cover ${large ? "large" : ""}`}
      src={src}
      loading="lazy"
      decoding="async"
      alt={`${title}封面`}
    />
  ) : (
    <div className={`resource-cover placeholder ${large ? "large" : ""}`}>
      <File size={large ? 32 : 22} strokeWidth={1.5} aria-hidden="true" />
    </div>
  );
}
