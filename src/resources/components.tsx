import { Select } from "../ui/Select";
import "./resources.css";
import { SearchSelect } from "../ui/SearchSelect";
import { useIpcQuery } from "../api/useIpcQuery";
import { useState, type ReactNode } from "react";
import { File, Plus } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import type { ResourceCopy } from "../../shared/types";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Status,
} from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { accountLabel, stageName } from "./labels";
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
export function RecoverShare({ copy }: { copy: ResourceCopy }) {
  const { command } = useAppActions(),
    { busy } = useAppActivity(),
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
        <Dialog
          title="恢复本人分享"
          onClose={() => setOpen(false)}
          busy={busy > 0}
        >
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
            <textarea value={text} onChange={(e) => setText(e.target.value)} />
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
        </Dialog>
      ) : null}
    </>
  );
}
