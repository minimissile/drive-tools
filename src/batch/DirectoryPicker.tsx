import { useState } from "react";
import { ChevronRight, Folder } from "lucide-react";
import { ipc } from "../api/client";
import { Button, Notice } from "../ui/primitives";
import type { RemoteFile } from "../../shared/types";
import type { InsertionTarget } from "../../shared/insertion";
import { useAppActions } from "../state";
export function DirectoryPicker({
  accountId,
  baidu,
  targets,
  onToggle,
}: {
  accountId: string;
  baidu: boolean;
  targets: InsertionTarget[];
  onToggle: (t: InsertionTarget, checked: boolean) => void;
}) {
  return (
    <DirectoryNode
      key={accountId}
      accountId={accountId}
      folderId={baidu ? "/" : "0"}
      path="/"
      label="我的网盘"
      baidu={baidu}
      targets={targets}
      onToggle={onToggle}
      depth={0}
    />
  );
}
function DirectoryNode({
  accountId,
  folderId,
  path,
  label,
  baidu,
  targets,
  onToggle,
  depth,
}: {
  accountId: string;
  folderId: string;
  path: string;
  label: string;
  baidu: boolean;
  targets: InsertionTarget[];
  onToggle: (t: InsertionTarget, checked: boolean) => void;
  depth: number;
}) {
  const [children, setChildren] = useState<RemoteFile[] | null>(null),
    [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const { notify } = useAppActions();
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setChildren(
        await ipc("directory.list", { accountId, parentId: folderId }),
      );
      setOpen(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : "目录读取失败";
      setError(message);
      notify(message, "error");
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="insertion-tree-node">
      <div className="insertion-tree-row">
        {depth > 0 ? (
          <input
            type="checkbox"
            aria-label={`选择目录 ${path}`}
            checked={targets.some(
              (t) => t.accountId === accountId && t.folderId === folderId,
            )}
            onChange={(e) =>
              onToggle({ accountId, folderId, path }, e.target.checked)
            }
          />
        ) : null}
        <Button
          quiet
          disabled={loading || depth >= 8}
          onClick={() => (children ? setOpen(!open) : void load())}
          aria-expanded={open}
          aria-label={`${open ? "收起" : "展开"} ${path}`}
        >
          <ChevronRight
            size={14}
            className={open ? "insertion-expanded" : ""}
          />
          <Folder size={16} />
          <span title={path}>{label}</span>
        </Button>
        {loading ? <small>读取中…</small> : null}
      </div>
      {error ? (
        <Notice danger>
          {error}{" "}
          <Button quiet onClick={() => void load()}>
            重试读取
          </Button>
        </Notice>
      ) : null}
      {open ? (
        <div className="insertion-tree-children">
          {children?.length === 0 ? (
            <small>没有子目录</small>
          ) : (
            children?.map((f) => {
              const childPath = path.replace(/\/$/, "") + "/" + f.name;
              return (
                <DirectoryNode
                  key={f.id}
                  accountId={accountId}
                  folderId={baidu ? (f.path ?? childPath) : f.id}
                  path={childPath}
                  label={f.name}
                  baidu={baidu}
                  targets={targets}
                  onToggle={onToggle}
                  depth={depth + 1}
                />
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
