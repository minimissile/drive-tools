import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Check,
  File,
  Folder,
  FolderOpen,
  FolderTree,
  Search,
  X,
} from "lucide-react";
import { Button, Status, stageName } from "../components";
import {
  buildSplitTree,
  selectSplitLevel,
  visibleSplitNodes,
  type SplitNode,
} from "../split-tree";
import type { SplitItem, SplitRun } from "../../shared/types";

export function SplitItemStatus({ item }: { item: SplitItem }) {
  return (
    <Status
      kind={
        item.status === "ready"
          ? "good"
          : ["failed", "needs_review", "waiting_login", "cancelled"].includes(
                item.status,
              )
            ? "warning"
            : "normal"
      }
    >
      {item.status === "ready"
        ? "本人链接已就绪"
        : item.status === "draft"
          ? "待生成"
          : item.stage
            ? stageName(item.stage)
            : item.status}
    </Status>
  );
}

export default function SplitTree({
  run,
  title,
  selectedIds,
  onSelect,
  onChange,
  renderDetails,
}: {
  run: SplitRun;
  title: string;
  selectedIds: Set<string>;
  onSelect(item: SplitItem, checked: boolean): void;
  onChange(ids: string[]): void;
  renderDetails(item: SplitItem): ReactNode;
}) {
  const [query, setQuery] = useState(""),
    [collapsed, setCollapsed] = useState<Set<string>>(() => new Set()),
    [activeId, setActiveId] = useState("");
  const treeRef = useRef<HTMLDivElement>(null);
  const roots = useMemo(() => buildSplitTree(run.items), [run.items]);
  const visible = useMemo(
    () => visibleSplitNodes(roots, collapsed, query),
    [roots, collapsed, query],
  );
  const selected = run.items.filter((i) => selectedIds.has(i.id));
  const active = activeId
    ? run.items.find((i) => i.file.id === activeId)
    : selected[0];
  const selectedFiles = new Set(selected.map((i) => i.file.id));
  const overlaps = selected.some((i) =>
    i.ancestors.some((f) => selectedFiles.has(f.id)),
  );
  const expand = (id: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  function focusNode(id: string) {
    const row = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [],
    ).find((el) => el.dataset.nodeId === id);
    row?.focus();
    setActiveId(id);
  }
  function keyboard(
    e: KeyboardEvent<HTMLDivElement>,
    node: SplitNode,
    index: number,
  ) {
    if (e.target !== e.currentTarget) return;
    const open = query.trim() || !collapsed.has(node.id);
    if (
      [
        "ArrowDown",
        "ArrowUp",
        "ArrowRight",
        "ArrowLeft",
        "Home",
        "End",
        " ",
        "Enter",
      ].includes(e.key)
    )
      e.preventDefault();
    if (e.key === "ArrowDown")
      focusNode(visible[Math.min(index + 1, visible.length - 1)].id);
    if (e.key === "ArrowUp") focusNode(visible[Math.max(index - 1, 0)].id);
    if (e.key === "Home") focusNode(visible[0].id);
    if (e.key === "End") focusNode(visible[visible.length - 1].id);
    if (e.key === "ArrowRight" && node.children.length) {
      if (!open) expand(node.id);
      else focusNode(node.children[0].id);
    }
    if (e.key === "ArrowLeft") {
      if (node.children.length && open && !query.trim()) expand(node.id);
      else if (node.parentId) focusNode(node.parentId);
    }
    if (
      (e.key === " " || e.key === "Enter") &&
      node.item &&
      (selectedIds.has(node.item.id) || selected.length < 100)
    )
      onSelect(node.item, !selectedIds.has(node.item.id));
  }
  return (
    <>
      <div className="split-workbench">
        <div className="split-explorer">
          <div className="split-tree-toolbar">
            <label className="split-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索拆分目录"
                placeholder="搜索文件、文件夹或路径"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="row compact">
              <Button quiet onClick={() => setCollapsed(new Set())}>
                全部展开
              </Button>
              <Button
                quiet
                onClick={() => {
                  setQuery("");
                  setCollapsed(
                    new Set(
                      run.items.flatMap((i) =>
                        [...i.ancestors, i.file]
                          .filter((f) => f.isDirectory)
                          .map((f) => f.id),
                      ),
                    ),
                  );
                }}
              >
                全部收起
              </Button>
            </div>
          </div>
          <div className="split-shortcuts">
            <span>按层快捷选</span>
            {[1, 2, 3].map((depth) => (
              <button
                type="button"
                key={depth}
                disabled={depth > run.depth}
                onClick={() => onChange(selectSplitLevel(roots, depth))}
                title="替换当前选择，保留较浅的文件和空目录"
              >
                第{depth}层
              </button>
            ))}
            <small>保留浅层文件与空目录 · 最多100项</small>
          </div>
          <div className="split-root">
            <FolderTree size={21} aria-hidden="true" />
            <div>
              <strong>{title}</strong>
              <small>资料根目录 · 第0层</small>
            </div>
            <span>{run.items.length} 个可选资源</span>
          </div>
          <div
            className="split-tree"
            ref={treeRef}
            role="tree"
            aria-label="资源目录树"
            aria-multiselectable="true"
          >
            {visible.map((node, index) => {
              const checked = !!node.item && selectedIds.has(node.item.id),
                open = !!query.trim() || !collapsed.has(node.id);
              const Icon = node.file.isDirectory
                ? node.children.length && open
                  ? FolderOpen
                  : Folder
                : File;
              return (
                <div
                  key={node.id}
                  role="treeitem"
                  aria-label={node.path}
                  aria-level={node.depth}
                  aria-expanded={node.children.length ? open : undefined}
                  aria-checked={node.item ? checked : undefined}
                  tabIndex={
                    activeId === node.id || (!activeId && index === 0) ? 0 : -1
                  }
                  data-node-id={node.id}
                  data-depth={node.depth}
                  className={`split-tree-row ${checked ? "is-selected" : ""} ${activeId === node.id ? "is-active" : ""}`}
                  style={{ "--tree-depth": node.depth } as CSSProperties}
                  onKeyDown={(e) => keyboard(e, node, index)}
                  onFocus={() => setActiveId(node.id)}
                >
                  <span className="split-branch" aria-hidden="true" />
                  {node.children.length ? (
                    <button
                      type="button"
                      className="split-disclosure"
                      aria-label={`${open ? "收起" : "展开"}目录${node.path}`}
                      aria-expanded={open}
                      disabled={!!query.trim()}
                      onClick={() => expand(node.id)}
                    >
                      {open ? (
                        <ChevronDown size={15} />
                      ) : (
                        <ChevronRight size={15} />
                      )}
                    </button>
                  ) : (
                    <span className="split-disclosure" />
                  )}
                  {node.item ? (
                    <input
                      type="checkbox"
                      aria-label={`拆分选择${node.path}`}
                      checked={checked}
                      disabled={!checked && selected.length >= 100}
                      onChange={(e) => {
                        setActiveId(node.id);
                        onSelect(node.item!, e.target.checked);
                      }}
                    />
                  ) : (
                    <span
                      className="split-context-check"
                      title="历史预览中的父目录；重新读取三级目录后可选择"
                    />
                  )}
                  <Icon
                    size={20}
                    className={
                      node.file.isDirectory
                        ? "split-folder-icon"
                        : "split-file-icon"
                    }
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className="split-node-name"
                    title={node.path}
                    onClick={() => setActiveId(node.id)}
                  >
                    <strong>{node.file.name}</strong>
                    <small>
                      第{node.depth}层 ·{" "}
                      {node.file.isDirectory
                        ? node.depth === 3
                          ? "文件夹 · 整夹分享"
                          : node.children.length
                            ? `${node.children.length} 个子项`
                            : run.depth > node.depth
                              ? "空文件夹"
                              : "文件夹"
                        : "文件"}
                    </small>
                  </button>
                  {node.item?.status === "ready" ? (
                    <span className="split-node-ready" title="本人链接已就绪">
                      <Check size={14} />
                      已就绪
                    </span>
                  ) : node.item && node.item.status !== "draft" ? (
                    <span className="split-node-state">
                      <SplitItemStatus item={node.item} />
                    </span>
                  ) : checked ? (
                    <span className="split-node-chosen">独立建链</span>
                  ) : null}
                </div>
              );
            })}
            {!visible.length ? (
              <div className="split-tree-empty">
                <Search size={24} />
                <strong>没有匹配的资源</strong>
                <span>换个关键词，或清空搜索查看全部目录。</span>
              </div>
            ) : null}
          </div>
          <div className="split-tree-footnote">
            勾选文件夹将为整个文件夹建链；子项可单独勾选。第3层文件夹内的内容仍随文件夹分享。
          </div>
        </div>
        <aside className="split-selection" aria-label="拆分选择清单">
          <div className="split-selection-heading">
            <div>
              <small>独立链接清单</small>
              <strong>
                <b>{selected.length}</b> / 100 项已选
              </strong>
            </div>
            <Button
              quiet
              disabled={!selected.length}
              onClick={() => onChange([])}
            >
              清空
            </Button>
          </div>
          {selected.length ? (
            <>
              <p className="split-selection-caption">
                每项对应1个链接，已就绪的本人链接会复用。
              </p>
              <ul className="split-selected-list">
                {selected.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="split-selected-name"
                      onClick={() => {
                        setActiveId(item.file.id);
                        setCollapsed((old) => {
                          const next = new Set(old);
                          item.ancestors.forEach((f) => next.delete(f.id));
                          return next;
                        });
                      }}
                      title={item.path}
                    >
                      {item.file.isDirectory ? (
                        <Folder size={15} />
                      ) : (
                        <File size={15} />
                      )}
                      <span>
                        {item.file.name}
                        <small>
                          {item.ancestors.map((f) => f.name).join(" / ") ||
                            "根目录"}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="split-remove"
                      aria-label={`移除拆分选择${item.path}`}
                      onClick={() => onSelect(item, false)}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="split-selection-empty">
              <FolderTree size={30} />
              <strong>从左侧勾选资源</strong>
              <p>
                选择文件或文件夹，
                <br />
                在这里核对独立链接清单。
              </p>
            </div>
          )}
          {overlaps ? (
            <div className="split-overlap" role="status">
              已同时选择父文件夹与子项，它们会分别建链，分享内容包含重叠部分。
            </div>
          ) : null}
          <Button
            quiet
            disabled={!run.items.some((i) => i.status === "ready")}
            onClick={() =>
              onChange(
                run.items
                  .filter((i) => i.status === "ready")
                  .slice(0, 100)
                  .map((i) => i.id),
              )
            }
          >
            只选已就绪链接
          </Button>
          {active ? (
            <div className="split-inspector">
              <small>当前资源</small>
              <strong className="break-word">{active.file.name}</strong>
              <p className="break-word">{active.path}</p>
              <SplitItemStatus item={active} />
              {renderDetails(active)}
            </div>
          ) : null}
        </aside>
      </div>
    </>
  );
}
