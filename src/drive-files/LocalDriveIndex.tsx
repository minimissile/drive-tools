import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderSync,
  Pause,
  Play,
} from "lucide-react";
import type { Account } from "../../shared/types";
import {
  driveSyncActive,
  type DriveIndexEntry,
  type DriveIndexState,
  type DriveSyncStatus,
} from "../../shared/drive-sync";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppNavigation, useAppSelection } from "../state";
import { formatSize, formatTime } from "../lib/format";
import { updateSelection } from "../lib/selection";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  SearchField,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { Pagination } from "../ui/Pagination";
import { DropdownMenu, MenuAction } from "../ui/DropdownMenu";
import "./drive-index.css";

const statuses: Record<DriveSyncStatus, string> = {
  running: "同步中",
  pausing: "正在暂停",
  paused: "已暂停",
  interrupted: "已中断",
  partial: "部分完成",
  completed: "已完成",
  blocked: "需要处理",
};
const states = { recorded: "已录入", unrecorded: "未录入", review: "待核对" };
const draftSchema = z.object({
  parentId: z.string(),
  search: z.string(),
  state: z.enum(["all", "recorded", "unrecorded", "review"]),
  page: z.number().int().min(1),
  selection: z
    .array(
      z.object({ fileId: z.string(), title: z.string(), path: z.string() }),
    )
    .max(50),
});

export function LocalDriveIndex({
  account,
  workspace,
  onOpenRemote,
}: {
  account: Account;
  workspace: string;
  onOpenRemote(path: string): void;
}) {
  const draft = useLocalDraft(
    `panxu-drive-index:${workspace}:${account.id}`,
    {
      parentId: "@root",
      search: "",
      state: "all" as "all" | DriveIndexState,
      page: 1,
      selection: [] as { fileId: string; title: string; path: string }[],
    },
    (value) => draftSchema.parse(value),
  );
  const { parentId, search, state, page, selection } = draft.value;
  const query = useIpcQuery(
    "driveSync.index",
    { accountId: account.id, parentId, search, state, page },
    { keepPrevious: true, delay: 160 },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState(false);
  const previewInput = useRef<HTMLInputElement>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (preview) previewInput.current?.focus();
  }, [preview]);
  const lock = useRef(false),
    mounted = useRef(true);
  const { select } = useAppSelection(),
    { navigate } = useAppNavigation(),
    { refresh, notify } = useAppActions();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // This component is keyed by account, so completed commands never alter another account's navigation.
  const data = query.data,
    run = data?.run,
    active = driveSyncActive(run);
  const go = (id: string) =>
    draft.update({ parentId: id, search: "", page: 1 });
  const perform = async (action: () => Promise<unknown>, success?: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      if (!mounted.current) return;
      query.reload();
      if (success) notify(success, "success");
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const selectable = (data?.items ?? []).filter(
    (e) => !e.missing && e.state !== "recorded",
  );
  const selected = selection.map((e) => e.fileId);
  const toggle = (entries: DriveIndexEntry[], checked: boolean) => {
    const ids = updateSelection(
      selected,
      entries.map((e) => e.id),
      checked,
      50,
    );
    const known = new Map(
      [
        ...entries.map((e) => ({ fileId: e.id, title: e.name, path: e.path })),
        ...selection,
      ].map((e) => [e.fileId, e]),
    );
    draft.update({ selection: ids.map((id) => known.get(id)!) });
  };
  const register = () =>
    perform(async () => {
      const result = await ipc("driveSync.register", {
        accountId: account.id,
        entries: selection.map(({ fileId, title }) => ({ fileId, title })),
      });
      if (!mounted.current) {
        await refresh();
        return;
      }
      const failed = result.filter((r) => r.error);
      draft.update({
        selection: selection.filter((e) =>
          failed.some((r) => r.fileId === e.fileId),
        ),
      });
      if (!failed.length) setPreview(false);
      const count = result.length - failed.length;
      if (count)
        notify(
          `已登记 ${count} 项资源${failed.length ? `，${failed.length} 项未完成` : "，可在资源库完善分享"}。`,
          failed.length ? "warning" : "success",
        );
      if (failed.length) setError(failed.map((r) => r.error).join("；"));
      await refresh();
    });
  const queryError = /UNKNOWN_METHOD|未知.*方法|不支持.*driveSync/i.test(
    query.error,
  )
    ? "整盘同步后端有更新待应用，请先点击顶部“应用更新并重启”，再重试读取。"
    : query.error;
  return (
    <section className="drive-index" aria-label="本地网盘目录">
      <Panel className="drive-index-workspace">
        <div className="drive-index-sync">
          <div className="drive-index-sync-copy">
            <div className="drive-index-status" role="status">
              <strong data-state={run?.status}>
                {run
                  ? statuses[run.status]
                  : !data
                    ? queryError
                      ? "目录读取未完成"
                      : "正在读取本地目录…"
                    : "尚未同步"}
              </strong>
              <span>
                {run
                  ? `发现 ${run.files.toLocaleString()} 个文件 · ${run.folders.toLocaleString()} 个目录 · ${run.pending} 个待处理${run.failed ? ` · ${run.failed} 个失败` : ""}`
                  : "同步目录信息后，可离线查询并筛选尚未录入的内容。"}
              </span>
            </div>
            <div className="drive-index-meta">
              {data?.lastCompleteAt ? (
                <span>上次完整同步：{formatTime(data.lastCompleteAt)}</span>
              ) : null}
              <details className="drive-index-scope">
                <summary>同步说明</summary>
                <p>
                  普通个人文件区 · 只读取目录信息 · 不下载正文或自动创建分享。
                  {account.status !== "connected"
                    ? "本地历史仍可浏览，同步和管理时会重新核验登录。"
                    : ""}
                </p>
              </details>
            </div>
          </div>
          <div className="drive-index-actions">
            {active ? (
              <Button
                disabled={busy || run?.status === "pausing"}
                onClick={() =>
                  void perform(() =>
                    ipc("driveSync.pause", { accountId: account.id }),
                  )
                }
              >
                <Pause size={15} />
                暂停同步
              </Button>
            ) : run?.status === "blocked" ? (
              <Button
                primary
                disabled={busy || !account.enabled}
                onClick={() =>
                  void perform(() =>
                    ipc("driveSync.start", {
                      accountId: account.id,
                      restart: true,
                    }),
                  )
                }
              >
                核对账号并重新扫描
              </Button>
            ) : run && run.status !== "completed" ? (
              <Button
                primary
                disabled={busy || !account.enabled}
                onClick={() =>
                  void perform(() =>
                    ipc("driveSync.resume", { accountId: account.id }),
                  )
                }
              >
                <Play size={15} />
                {run.status === "partial" ? "重试未完成目录" : "继续同步"}
              </Button>
            ) : (
              <Button
                primary
                disabled={busy || !account.enabled || !data || !!queryError}
                onClick={() =>
                  void perform(() =>
                    ipc("driveSync.start", { accountId: account.id }),
                  )
                }
              >
                <FolderSync size={15} />
                {run ? "更新本地目录" : "同步整个网盘"}
              </Button>
            )}
          </div>
          {run?.message ? (
            <p className="drive-index-message">{run.message}</p>
          ) : null}
        </div>
        {error || draft.error ? (
          <Notice danger>{error || draft.error}</Notice>
        ) : null}
        <QueryError
          error={queryError}
          loading={query.loading}
          onRetry={query.reload}
        />
        {query.loading && !data ? (
          <LoadingState label="正在读取本地目录…" />
        ) : data ? (
          <div className="drive-index-content">
            <div className="drive-index-toolbar">
              <SearchField
                label="搜索本地目录"
                value={search}
                onChange={(value) => draft.update({ search: value, page: 1 })}
                placeholder="搜索全盘文件名或路径"
              />
              <div className="drive-index-filter">
                <Field label="录入状态">
                  <Select
                    value={state}
                    onValueChange={(value) =>
                      draft.update({ state: value as typeof state, page: 1 })
                    }
                    items={[
                      { value: "all", label: "全部状态" },
                      ...Object.entries(states).map(([value, label]) => ({
                        value,
                        label,
                      })),
                    ]}
                  />
                </Field>
              </div>
              <div className="drive-index-selection">
                <span className="muted">已选 {selection.length} / 50 项</span>
                <Button
                  ref={previewTrigger}
                  disabled={!selection.length || busy || active}
                  onClick={() => setPreview(true)}
                >
                  录入资源库
                </Button>
                {selection.length ? (
                  <Button
                    quiet
                    onClick={() => {
                      draft.update({ selection: [] });
                      setPreview(false);
                    }}
                  >
                    清空选择
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="drive-index-body">
              <aside className="drive-index-tree" aria-label="本地目录树">
                <strong className="drive-index-tree-heading">目录</strong>
                <Button
                  quiet
                  onClick={() => go("@root")}
                  aria-current={parentId === "@root" ? "location" : undefined}
                >
                  <Folder size={15} />
                  全部文件
                </Button>
                <FolderBranch
                  accountId={account.id}
                  parentId="@root"
                  revision={run?.updatedAt ?? ""}
                  selected={parentId}
                  ancestors={data.breadcrumbs.map((b) => b.id)}
                  onSelect={go}
                />
              </aside>
              <div className="drive-index-list">
                {data.breadcrumbs.length > 0 || search ? (
                  <nav
                    className="drive-index-breadcrumb"
                    aria-label="本地目录路径"
                  >
                    <Button quiet size="compact" onClick={() => go("@root")}>
                      全部文件
                    </Button>
                    {data.breadcrumbs.map((b) => (
                      <span className="drive-index-crumb" key={b.id}>
                        <ChevronRight size={13} aria-hidden="true" />
                        <Button
                          quiet
                          size="compact"
                          onClick={() => go(b.id)}
                          title={b.name}
                        >
                          {b.name}
                        </Button>
                      </span>
                    ))}
                    {search ? (
                      <span className="muted">全盘搜索结果</span>
                    ) : null}
                  </nav>
                ) : null}
                {data.items.length ? (
                  <div className="drive-index-table-wrap">
                    <table className="drive-index-table">
                      <thead>
                        <tr>
                          <th className="drive-index-check">
                            <SelectionCheckbox
                              aria-label="选择本页未录入项目"
                              total={selectable.length}
                              selected={
                                selectable.filter((e) =>
                                  selected.includes(e.id),
                                ).length
                              }
                              onChange={(e) =>
                                toggle(selectable, e.target.checked)
                              }
                            />
                          </th>
                          <th>名称与位置</th>
                          <th>大小</th>
                          <th>录入状态</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.items.map((e) => (
                          <tr key={e.id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`选择 ${e.name}`}
                                checked={selected.includes(e.id)}
                                disabled={
                                  e.missing || e.state === "recorded" || busy
                                }
                                onChange={(event) =>
                                  toggle([e], event.target.checked)
                                }
                              />
                            </td>
                            <td
                              title={`位置：${e.path}\n读取时间：${formatTime(e.observedAt)}`}
                            >
                              <div className="drive-index-name">
                                {e.isDirectory ? (
                                  <Folder size={16} />
                                ) : (
                                  <File size={16} />
                                )}
                                {e.isDirectory ? (
                                  <Button
                                    quiet
                                    size="compact"
                                    onClick={() => go(e.id)}
                                  >
                                    {e.name}
                                  </Button>
                                ) : (
                                  <strong>{e.name}</strong>
                                )}
                              </div>
                              {search ? (
                                <small className="drive-index-file-meta muted">
                                  <span title={e.path}>
                                    {e.path.slice(0, e.path.lastIndexOf("/")) ||
                                      "/"}
                                  </span>
                                </small>
                              ) : null}
                            </td>
                            <td>{e.isDirectory ? "—" : formatSize(e.size)}</td>
                            <td>
                              <span
                                className={`drive-index-state drive-index-state--${e.state}`}
                                title={
                                  e.state === "review" && !e.resources.length
                                    ? "资源目录内新增内容"
                                    : undefined
                                }
                              >
                                {states[e.state]}
                              </span>
                              {e.missing ? <small>本轮未发现</small> : null}
                              {e.resources.length ? (
                                <span className="drive-index-resource-count muted">
                                  {" "}
                                  · {e.resources.length} 个关联资源
                                </span>
                              ) : null}
                            </td>
                            <td>
                              <div className="drive-index-row-actions">
                                <Button
                                  quiet
                                  size="compact"
                                  disabled={!account.enabled || busy}
                                  onClick={() =>
                                    onOpenRemote(
                                      e.path.slice(
                                        0,
                                        e.path.lastIndexOf("/"),
                                      ) || "/",
                                    )
                                  }
                                >
                                  打开实时目录
                                </Button>
                                {e.resources.length ? (
                                  <DropdownMenu
                                    label={`关联资源（${e.resources.length}）：${e.name}`}
                                  >
                                    {e.resources.map((r) => (
                                      <MenuAction
                                        key={r.copyId}
                                        onClick={() => {
                                          select(r.id, r.copyId);
                                          navigate("library");
                                        }}
                                      >
                                        <span className="drive-index-resource-title">
                                          查看资源：{r.title}
                                        </span>
                                      </MenuAction>
                                    ))}
                                  </DropdownMenu>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title={run ? "此处没有匹配内容" : "先同步网盘目录"}>
                    {run
                      ? "尝试切换目录、录入状态或搜索词。"
                      : "点击上方“同步整个网盘”，保留原有资源库记录并建立完整文件索引。"}
                  </Empty>
                )}
                <Pagination
                  label="本地目录分页"
                  page={page}
                  pageSize={data.pageSize}
                  total={data.total}
                  onPageChange={(page) => draft.update({ page })}
                  disabled={busy}
                />
              </div>
            </div>
          </div>
        ) : null}
      </Panel>
      {preview && selection.length ? (
        <Panel
          className="drive-index-preview-panel"
          title={`录入预览 · ${selection.length} 项`}
          extra={
            <Button
              quiet
              onClick={() => {
                setPreview(false);
                previewTrigger.current?.focus({ preventScroll: true });
              }}
            >
              收起预览
            </Button>
          }
        >
          <p className="muted">
            每个所选文件或目录登记为一条资源。请只选择一个目录层级；同一对象不会重复登记。保存后分享状态为待完善。
          </p>
          <div className="drive-index-preview">
            {selection.map((e, index) => (
              <Field key={e.fileId} label={e.path}>
                <input
                  ref={index === 0 ? previewInput : undefined}
                  value={e.title}
                  maxLength={200}
                  onChange={(event) =>
                    draft.update({
                      selection: selection.map((v) =>
                        v.fileId === e.fileId
                          ? { ...v, title: event.target.value }
                          : v,
                      ),
                    })
                  }
                />
              </Field>
            ))}
          </div>
          <div className="drive-index-actions drive-index-preview-actions">
            <Button
              primary
              disabled={
                busy || active || selection.some((e) => !e.title.trim())
              }
              onClick={() => void register()}
            >
              {busy ? "正在核对并登记…" : "核对网盘并保存资源"}
            </Button>
          </div>
        </Panel>
      ) : null}
    </section>
  );
}

function FolderBranch({
  accountId,
  parentId,
  selected,
  ancestors,
  onSelect,
  revision,
  visited = [],
}: {
  accountId: string;
  parentId: string;
  selected: string;
  ancestors: string[];
  onSelect(id: string): void;
  visited?: string[];
  revision: string;
}) {
  const [page, setPage] = useState(1),
    [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const query = useIpcQuery(
    "driveSync.index",
    { accountId, parentId, page, foldersOnly: true },
    { keepPrevious: true, revision },
  );
  return (
    <div className="drive-index-branches">
      {query.error ? (
        <QueryError error={query.error} onRetry={query.reload} />
      ) : null}
      {query.data?.items.map((folder) => {
        const open = expanded[folder.id] ?? ancestors.includes(folder.id);
        return (
          <div key={folder.id}>
            <div className="drive-index-tree-row">
              <Button
                quiet
                size="compact"
                aria-label={`${open ? "折叠" : "展开"} ${folder.name}`}
                aria-expanded={open}
                onClick={() =>
                  setExpanded((old) => ({ ...old, [folder.id]: !open }))
                }
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </Button>
              <Button
                quiet
                size="compact"
                aria-current={folder.id === selected ? "location" : undefined}
                onClick={() => onSelect(folder.id)}
                title={folder.path}
              >
                <Folder size={14} />
                {folder.name}
              </Button>
            </div>
            {open &&
            !visited.includes(folder.id) &&
            folder.id !== parentId &&
            visited.length < 64 ? (
              <FolderBranch
                accountId={accountId}
                parentId={folder.id}
                revision={revision}
                selected={selected}
                ancestors={ancestors}
                onSelect={onSelect}
                visited={[...visited, parentId]}
              />
            ) : null}
          </div>
        );
      })}
      {query.data && query.data.total > query.data.pageSize ? (
        <Pagination
          label="目录树分页"
          page={page}
          pageSize={query.data.pageSize}
          total={query.data.total}
          onPageChange={setPage}
        />
      ) : null}
    </div>
  );
}
