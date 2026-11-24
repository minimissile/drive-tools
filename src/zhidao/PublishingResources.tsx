import { useState } from "react";
import { Plus, Trash2, Table2 } from "lucide-react";
import type { Resource } from "../../shared/types";
import { publishingResourceLimit } from "../../shared/zhidao-workflow";
import { useIpcQuery } from "../api/useIpcQuery";
import { SearchSelect } from "../ui/SearchSelect";
import { Select } from "../ui/Select";
import { Button, Empty, Panel, Notice } from "../ui/primitives";
import { parseClipboardTable } from "../lib/clipboard-table";
import { QueryError } from "../ui/QueryError";
import { Pagination } from "../ui/Pagination";
import { initialIntakeKeywords } from "../resources/IntakeKeywords";
import {
  newPublishingResource,
  type PublishingDraftRow,
} from "./publishing-draft";

const columns = [
  { field: "title", label: "名称", placeholder: "资源名称", limit: 200 },
  {
    field: "link",
    label: "链接",
    placeholder: "百度分享链接，可带 pwd",
    limit: 2000,
  },
  { field: "category", label: "分类" },
  {
    field: "summary",
    label: "描述",
    placeholder: "目录、版本与适用人群",
    limit: 5000,
  },
  {
    field: "image",
    label: "图片地址",
    placeholder: "选填，公开 HTTPS 图片",
    limit: 2000,
  },
] as const;
const columnHeadings = columns.map(({ label }) => label);

export function PublishingResources({
  rows,
  onChange,
}: {
  rows: PublishingDraftRow[];
  onChange(rows: PublishingDraftRow[]): void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pasteError, setPasteError] = useState("");
  const options = useIpcQuery("resource.intakeOptions", { accountId: "" }, {});
  const resources = useIpcQuery(
    "zhidao.workflow.resources",
    { query },
    { keepPrevious: true, delay: 180 },
  );
  const candidates = (resources.data ?? []).filter(
    (r: Resource) =>
      r.provider === "baidu" && !rows.some((row) => row.resourceId === r.id),
  );
  const update = (key: string, patch: Partial<PublishingDraftRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const add = (row: PublishingDraftRow) => {
    if (rows.length < publishingResourceLimit) {
      onChange([...rows, row]);
      setPage(Math.floor(rows.length / 10) + 1);
    }
  };
  return (
    <Panel
      title="录入资源"
      extra={
        <span className="muted">
          {rows.length} / {publishingResourceLimit} 份
        </span>
      }
    >
      <div className="publishing-resource-tools">
        <SearchSelect
          label="搜索资源库"
          value={{ value: "", label: "" }}
          inputValue={query}
          items={candidates.map((r) => ({
            value: r.id,
            label: `${r.title} · ${r.category}`,
          }))}
          onQueryChange={setQuery}
          loading={resources.loading}
          error={resources.error}
          onRetry={resources.reload}
          placeholder="搜索并添加资源库中的百度资源…"
          onChange={(id) => {
            const resource = candidates.find((r) => r.id === id);
            if (!resource || rows.length >= publishingResourceLimit) return;
            const copy =
              resource.copies.find(
                (c) => c.status === "ready" && c.shareVerifiedAt && c.shareUrl,
              ) ??
              resource.copies.find(
                (c) => c.verifiedAt && c.ownerUid && c.files.length,
              ) ??
              resource.copies[0];
            add({
              ...newPublishingResource(),
              resourceId: resource.id,
              copyId: copy?.id ?? "",
              title: resource.title,
              link: resource.sourceUrl,
              category: resource.category,
              summary: resource.summary.slice(0, 5000),
              keywords: initialIntakeKeywords(resource.searchKeywords),
              checked: !!resource.searchKeywords?.length,
            });
            setQuery("");
          }}
        />
        <Button
          disabled={rows.length >= publishingResourceLimit}
          onClick={() => add(newPublishingResource())}
        >
          <Plus size={15} />
          录入库外资源
        </Button>
      </div>
      <p className="publishing-help">
        支持从 Excel
        复制名称、链接、分类、描述。图片地址选填，用于在回答中附图。
      </p>
      <QueryError
        error={options.error}
        loading={options.loading}
        onRetry={options.reload}
      />
      {pasteError ? <Notice warning>{pasteError}</Notice> : null}
      {rows.length ? (
        <div className="publishing-sheet">
          <table>
            <thead>
              <tr>
                <th scope="col">来源</th>
                {columnHeadings.map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
                <th scope="col">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice((page - 1) * 10, page * 10).map((row, index) => (
                <tr key={row.key}>
                  <td>
                    <span className="muted">
                      {(page - 1) * 10 + index + 1} ·{" "}
                      {row.resourceId ? "库中" : "库外"}
                    </span>
                  </td>
                  {columns.map((column, col) => (
                    <td key={column.field}>
                      {column.field === "category" ? (
                        <Select
                          aria-label={`第${(page - 1) * 10 + index + 1}行分类`}
                          value={row.category}
                          onValueChange={(category) =>
                            update(row.key, { category })
                          }
                          items={[
                            { value: "", label: "选择分类" },
                            ...[
                              ...new Set(
                                [
                                  ...(options.data?.categories ?? []),
                                  row.category,
                                ].filter(Boolean),
                              ),
                            ].map((c) => ({ value: c, label: c })),
                          ]}
                        />
                      ) : (
                        <input
                          aria-label={`第${(page - 1) * 10 + index + 1}行${column.label}`}
                          value={row[column.field]}
                          title={row[column.field]}
                          readOnly={!!row.resourceId && column.field === "link"}
                          maxLength={column.limit}
                          placeholder={column.placeholder}
                          onChange={(e) =>
                            update(row.key, { [column.field]: e.target.value })
                          }
                          onPaste={(e) => {
                            const text = e.clipboardData.getData("text/plain");
                            if (!text.includes("\t") || row.resourceId) return;
                            e.preventDefault();
                            let pasted: string[][];
                            try {
                              pasted = parseClipboardTable(text);
                              const headings = pasted[0]?.join("\t");
                              if (
                                headings === columnHeadings.join("\t") ||
                                headings ===
                                  columnHeadings.slice(0, 4).join("\t")
                              )
                                pasted.shift();
                              if (
                                (page - 1) * 10 + index + pasted.length >
                                publishingResourceLimit
                              )
                                throw new Error(
                                  `一次最多录入${publishingResourceLimit}份资源，请分批粘贴。`,
                                );
                              if (
                                pasted.some(
                                  (line) => line.length > columns.length - col,
                                )
                              )
                                throw new Error(
                                  "粘贴列数超出当前单元格右侧范围，请从对应列开始粘贴。",
                                );
                              if (
                                pasted.some(
                                  (_, offset) =>
                                    rows[(page - 1) * 10 + index + offset]
                                      ?.resourceId,
                                )
                              )
                                throw new Error(
                                  "粘贴区域包含库中资源，请先新增空白行，避免覆盖原副本。",
                                );
                            } catch (error) {
                              setPasteError(
                                error instanceof Error
                                  ? error.message
                                  : "粘贴失败，请重新复制表格。",
                              );
                              return;
                            }
                            setPasteError("");
                            const next = [...rows];
                            const start = (page - 1) * 10 + index;
                            for (const [offset, line] of pasted.entries()) {
                              if (start + offset >= publishingResourceLimit)
                                break;
                              const target =
                                next[start + offset] ?? newPublishingResource();
                              if (target.resourceId) continue;
                              const patch = Object.fromEntries(
                                line
                                  .slice(0, columns.length - col)
                                  .map((v, j) => [
                                    columns[col + j].field,
                                    v.trim(),
                                  ]),
                              );
                              next[start + offset] = { ...target, ...patch };
                            }
                            onChange(next);
                          }}
                        />
                      )}
                    </td>
                  ))}
                  <td>
                    <Button
                      quiet
                      size="compact"
                      aria-label={`删除第${(page - 1) * 10 + index + 1}行`}
                      onClick={() => {
                        onChange(rows.filter((r) => r.key !== row.key));
                        setPage(
                          Math.min(
                            page,
                            Math.max(1, Math.ceil((rows.length - 1) / 10)),
                          ),
                        );
                      }}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty compact icon={Table2} title="先准备要发布的资源">
          从资源库搜索添加，或新增一行录入库外资源。
        </Empty>
      )}
      <Pagination
        page={page}
        pageSize={10}
        total={rows.length}
        onPageChange={setPage}
        label="录入资源分页"
      />
    </Panel>
  );
}
