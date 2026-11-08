import { useRef, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import {
  generationColumns,
  generationColumnLabels,
} from "../../shared/zhidao-generation";
import { Button, Field, LoadingState, Notice } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";
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

export { OwnedResourcePicker as GenerationOwnedSource } from "./OwnedResourcePicker";
