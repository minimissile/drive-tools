import { useRef, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import {
  generationColumns,
  generationColumnLabels,
} from "../../shared/zhidao-generation";
import {
  Button,
  Field,
  Empty,
  LoadingState,
  Notice,
  SearchField,
} from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { useIpcQuery } from "../api/useIpcQuery";
import { updateSelection } from "../lib/selection";
import type { GenerationForm } from "./useGenerationForm";

export function GenerationTableSource({
  model,
  disabled,
}: {
  model: GenerationForm;
  disabled: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { table } = model;
  return (
    <>
      <div
        className="generation-drop"
        data-dragging={dragging || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled && event.dataTransfer.files[0])
            void model.readFile(event.dataTransfer.files[0]);
        }}
      >
        <FileSpreadsheet size={26} aria-hidden="true" />
        <div>
          <strong>
            {model.loadingFile
              ? "正在读取资源表格…"
              : (table?.name ?? "导入资源表格")}
          </strong>
          <p>XLSX / CSV · 名称与百度网盘链接必填，简介、提取码和图片可选</p>
        </div>
        <Button
          disabled={disabled || model.loadingFile || model.attachment.loading}
          onClick={() => file.current?.click()}
        >
          <Upload size={14} />
          {table ? "重新选择" : "选择文件"}
        </Button>
        <input
          ref={file}
          type="file"
          accept=".xlsx,.csv"
          aria-label="导入资源表格文件"
          className="generation-file-input"
          tabIndex={-1}
          onChange={(event) => {
            const selected = event.currentTarget.files?.[0];
            if (selected) void model.readFile(selected);
            event.currentTarget.value = "";
          }}
        />
      </div>
      {table ? (
        <Button
          quiet
          size="compact"
          disabled={disabled || model.loadingFile}
          onClick={model.removeFile}
        >
          移除导入表格
        </Button>
      ) : null}
      {model.attachment.loading ? (
        <LoadingState compact label="正在恢复导入的表格…" />
      ) : null}
      {model.error ? <Notice danger>{model.error}</Notice> : null}
      {table ? (
        <div className="generation-mapping">
          <CheckboxField
            label="首行为表头"
            checked={table.header}
            disabled={disabled}
            onChange={(event) => model.setHeader(event.target.checked)}
          />
          <div className="generation-mapping-grid">
            {generationColumns.map((key) => (
              <Field
                key={key}
                label={generationColumnLabels[key]}
                required={key === "title" || key === "link"}
              >
                <Select
                  aria-label={`映射${generationColumnLabels[key]}`}
                  value={String(table.mapping[key])}
                  disabled={disabled}
                  onValueChange={(value) =>
                    model.setMapping({ ...table.mapping, [key]: Number(value) })
                  }
                  items={[
                    {
                      value: "-1",
                      label:
                        key === "title" || key === "link"
                          ? "请选择对应列"
                          : "不使用",
                    },
                    ...Array.from(
                      {
                        length: Math.max(
                          ...table.rows.map((row) => row.length),
                        ),
                      },
                      (_, i) => ({
                        value: String(i),
                        label: `${i + 1}列 · ${table.header ? table.rows[0]?.[i] || "未命名" : table.rows[0]?.[i]?.slice(0, 24) || "空值"}`,
                      }),
                    ),
                  ]}
                />
              </Field>
            ))}
          </div>
          {model.mappingIssue ? (
            <Notice warning>{model.mappingIssue}</Notice>
          ) : (
            <p className="generation-caption">
              可用 {model.mapped.resources.length} 份 · 需处理{" "}
              {model.mapped.issues.length} 行 · 单次最多100份
            </p>
          )}
          {model.mapped.issues.length ? (
            <details>
              <summary>查看需处理的行（生成前请修正并重新导入）</summary>
              <ul className="generation-row-issues">
                {model.mapped.issues.map((issue) => (
                  <li key={issue.row}>
                    第{issue.row}行：{issue.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : (
        <p className="generation-caption">
          可直接拖入文件。表格仅保存在本机，导入不会生成或上传问答。
        </p>
      )}
    </>
  );
}

export function GenerationOwnedSource({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange(ids: string[]): void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(1);
  const targets = useIpcQuery(
    "zhidao.targets",
    { query, page },
    { keepPrevious: true, delay: 180 },
  );
  return (
    <>
      <SearchField
        value={query}
        onChange={(value) => {
          setQuery(value);
          setPage(1);
        }}
        label="搜索本人资料"
        placeholder="搜索已核验的本人百度分享"
      />
      <QueryError
        error={targets.error}
        loading={targets.loading}
        onRetry={targets.reload}
      />
      {!targets.data && !targets.error ? (
        <LoadingState compact label="正在读取本人资源…" />
      ) : targets.data?.items.length ? (
        <>
          <label className="check">
            <SelectionCheckbox
              aria-label="选择本页资料"
              disabled={disabled}
              selected={
                targets.data.items.filter((item) =>
                  selected.includes(item.copyId),
                ).length
              }
              total={targets.data.items.length}
              onChange={(event) =>
                onChange(
                  updateSelection(
                    selected,
                    targets.data!.items.map((item) => item.copyId),
                    event.target.checked,
                    100,
                  ),
                )
              }
            />
            选择本页 · 已选{selected.length}份
          </label>
          <div className="generation-owned-list">
            {targets.data.items.map((item) => (
              <label className="operation-target" key={item.copyId}>
                <input
                  type="checkbox"
                  disabled={
                    disabled ||
                    (!selected.includes(item.copyId) && selected.length >= 100)
                  }
                  checked={selected.includes(item.copyId)}
                  onChange={(event) =>
                    onChange(
                      updateSelection(
                        selected,
                        [item.copyId],
                        event.target.checked,
                        100,
                      ),
                    )
                  }
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.url}</small>
                </span>
              </label>
            ))}
          </div>
          <Pagination
            page={page}
            pageSize={25}
            total={targets.data.total}
            onPageChange={setPage}
            label="模板资源分页"
          />
        </>
      ) : targets.data ? (
        <Empty
          compact
          title={query ? "没有匹配的本人资料" : "还没有已核验的本人百度分享"}
        >
          可改用资源表格，或先在网盘文件中分享已有资料。
        </Empty>
      ) : null}
    </>
  );
}
