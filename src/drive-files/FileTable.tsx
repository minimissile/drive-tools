import { useState } from "react";
import { File, Folder } from "lucide-react";
import type { RemoteFile } from "../../shared/types";
import { formatSize } from "../lib/format";
import { updateSelection } from "../lib/selection";
import { Button, Empty, SearchField } from "../ui/primitives";
import { Select } from "../ui/Select";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { Pagination } from "../ui/Pagination";
import { Dialog } from "../ui/Dialog";
import "./drive-files.css";

export const childPath = (parent: string, name: string) =>
  parent.replace(/\/$/, "") + "/" + name;

export function FileTable({
  files,
  selected,
  onSelect,
  onOpen,
  disabled = false,
  selectable = true,
}: {
  files: RemoteFile[];
  selected: string[];
  onSelect(ids: string[]): void;
  onOpen(file: RemoteFile): void;
  disabled?: boolean;
  selectable?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<RemoteFile | null>(null);
  const filtered = files.filter(
    (f) =>
      f.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
      (kind === "all" || f.isDirectory === (kind === "folder")),
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / 50)),
  );
  const visible = filtered.slice((currentPage - 1) * 50, currentPage * 50);
  const selection = new Set(selected);
  return (
    <div className="drive-file-table">
      <div className="drive-file-filters">
        <SearchField
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="搜索当前目录中的名称…"
        />
        <Select
          aria-label="文件类型筛选"
          value={kind}
          onValueChange={(v) => {
            setKind(v);
            setPage(1);
          }}
          items={[
            { value: "all", label: "全部类型" },
            { value: "folder", label: "文件夹" },
            { value: "file", label: "文件" },
          ]}
        />
        <small>
          {files.length} 项 · 已选 {selected.length} / 100
        </small>
      </div>
      {visible.length ? (
        <div className="drive-table-scroll">
          <table className="drive-table">
            <thead>
              <tr>
                <th className="drive-check">
                  <SelectionCheckbox
                    aria-label="选择本页文件"
                    total={visible.length}
                    selected={visible.filter((f) => selection.has(f.id)).length}
                    disabled={disabled || !selectable}
                    onChange={(e) =>
                      onSelect(
                        updateSelection(
                          selected,
                          visible.map((f) => f.id),
                          e.target.checked,
                          100,
                        ),
                      )
                    }
                  />
                </th>
                <th>名称</th>
                <th className="drive-size">类型 / 大小</th>
                <th className="drive-detail">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((file) => (
                <tr
                  key={file.id}
                  data-selected={selection.has(file.id) || undefined}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${file.name}`}
                      checked={selection.has(file.id)}
                      disabled={
                        disabled ||
                        !selectable ||
                        (!selection.has(file.id) && selected.length >= 100)
                      }
                      onChange={(e) =>
                        onSelect(
                          updateSelection(
                            selected,
                            [file.id],
                            e.target.checked,
                            100,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <button
                      className="drive-file-name"
                      disabled={disabled}
                      onClick={() =>
                        file.isDirectory ? onOpen(file) : setDetail(file)
                      }
                    >
                      {file.isDirectory ? (
                        <Folder size={18} />
                      ) : (
                        <File size={18} />
                      )}
                      <span>{file.name}</span>
                    </button>
                  </td>
                  <td>{file.isDirectory ? "文件夹" : formatSize(file.size)}</td>
                  <td>
                    <Button
                      quiet
                      size="compact"
                      onClick={() => setDetail(file)}
                    >
                      详情
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          compact
          title={files.length ? "没有匹配的文件" : "此目录没有文件"}
        >
          {files.length
            ? "调整名称或类型筛选后再查看。"
            : "可以返回上级目录，或在本人网盘中新增文件。"}
        </Empty>
      )}
      <Pagination
        label="网盘文件分页"
        page={currentPage}
        pageSize={50}
        total={filtered.length}
        onPageChange={setPage}
        disabled={disabled}
      />
      {detail ? (
        <Dialog title="文件详情" onClose={() => setDetail(null)}>
          <dl className="drive-file-metadata">
            <dt>名称</dt>
            <dd>{detail.name}</dd>
            <dt>类型</dt>
            <dd>{detail.isDirectory ? "文件夹" : "文件"}</dd>
            <dt>大小</dt>
            <dd>{detail.isDirectory ? "—" : formatSize(detail.size)}</dd>
            <dt>文件 ID</dt>
            <dd>{detail.id}</dd>
            {detail.path ? (
              <>
                <dt>路径</dt>
                <dd>{detail.path}</dd>
              </>
            ) : null}
          </dl>
        </Dialog>
      ) : null}
    </div>
  );
}
