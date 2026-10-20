import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { updateSelection } from "../lib/selection";
import type { ExportFormat } from "../../shared/ipc-commands";
import { ArrowDown, ArrowUp, Download, Plus, Trash2 } from "lucide-react";
import { Button, Empty, Panel } from "../ui/primitives";
import { useAppActions } from "../state";
import { exportFields } from "../../shared/resource-export-fields";
import type { ExportColumn } from "../../shared/resource-export";

import type { ExportModel } from "./useResourceExport";
export function ExportTable({ model }: { model: ExportModel }) {
  const { command, notify } = useAppActions();

  const {
    run,
    columns,
    setColumns,
    selected,
    setSelected,
    format,
    setFormat,
    query,
    setQuery,
    page,
    setPage,
    setWorking,
    showExcluded,
    setShowExcluded,
    locked,
    filtered,
    rows,
    selectedSet,
    changeColumn,
    moveColumn,
  } = model;
  if (!run) return null;
  return (
    <Panel
      title="03 / 表格与导出"
      extra={<small>{selected.length} 份已选</small>}
    >
      <details className="export-column-editor" open={!run.scanned}>
        <summary>
          表头与数据映射 · {columns.length} 列（可改名、调整顺序）
        </summary>
        {columns.map((c, i) => (
          <div className="export-column" key={i}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <input
              aria-label={`第${i + 1}列表头`}
              value={c.label}
              maxLength={60}
              disabled={locked}
              onChange={(e) => changeColumn(i, { label: e.target.value })}
            />
            <Select
              aria-label={`第${i + 1}列数据`}
              value={c.field}
              disabled={locked}
              onValueChange={(nextValue) =>
                changeColumn(i, {
                  field: nextValue as ExportColumn["field"],
                })
              }
              items={[
                ...Object.entries(exportFields).map(([id, label]) => ({
                  value: id,
                  label: label,
                })),
              ]}
            />
            <Button
              quiet
              aria-label={`上移第${i + 1}列`}
              disabled={locked || i === 0}
              onClick={() => moveColumn(i, -1)}
            >
              <ArrowUp size={13} />
            </Button>
            <Button
              quiet
              aria-label={`下移第${i + 1}列`}
              disabled={locked || i === columns.length - 1}
              onClick={() => moveColumn(i, 1)}
            >
              <ArrowDown size={13} />
            </Button>
            <Button
              quiet
              aria-label={`删除第${i + 1}列`}
              disabled={locked || columns.length === 1}
              onClick={() => setColumns((old) => old.filter((_, n) => n !== i))}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
        <Button
          quiet
          disabled={locked || columns.length >= 24}
          onClick={() =>
            setColumns((old) => [...old, { label: "新列", field: "blank" }])
          }
        >
          <Plus size={13} /> 添加列
        </Button>
      </details>
      {run.records.length || run.excluded.length ? (
        <>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={showExcluded}
              onChange={(e) => {
                setShowExcluded(e.target.checked);
                setPage(1);
              }}
            />
            查看未匹配资源（{run.excluded.length} 份，可手动勾选补充）
          </label>
          <div className="export-table-tools">
            <input
              aria-label="筛选导出结果"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="在匹配结果中查找…"
            />
            <Button
              quiet
              disabled={locked}
              onClick={() => setSelected(run.records.map((r) => r.id))}
            >
              全选匹配
            </Button>
            <Button quiet disabled={locked} onClick={() => setSelected([])}>
              清空选择
            </Button>
          </div>
          <div className="export-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    <SelectionCheckbox
                      aria-label="选择当前页资源"
                      selected={
                        rows.filter((r) => selectedSet.has(r.id)).length
                      }
                      total={rows.length}
                      disabled={locked}
                      onChange={(e) =>
                        setSelected((old) =>
                          updateSelection(
                            old,
                            rows.map((r) => r.id),
                            e.target.checked,
                          ),
                        )
                      }
                    />
                  </th>
                  {columns.map((c, i) => (
                    <th key={i}>{c.label}</th>
                  ))}
                  <th>匹配依据</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`导出${r.title}`}
                        checked={selectedSet.has(r.id)}
                        disabled={locked}
                        onChange={(e) =>
                          setSelected((old) =>
                            updateSelection(old, [r.id], e.target.checked),
                          )
                        }
                      />
                    </td>
                    {columns.map((c, i) => (
                      <td key={i}>
                        {c.field === "shareUrls" ||
                        c.field === "extractionCodes"
                          ? "导出时核验本人分享"
                          : r[c.field] || "—"}
                      </td>
                    ))}
                    <td>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            label="导出结果翻页"
            page={page}
            pageSize={25}
            total={filtered.length}
            disabled={locked}
            onPageChange={setPage}
          >
            {filtered.length} 份结果 · 第 {page} /{" "}
            {Math.max(1, Math.ceil(filtered.length / 25))} 页
          </Pagination>
        </>
      ) : (
        <Empty
          title={
            run.state === "completed"
              ? "没有匹配的资源"
              : "筛选结果将出现在这里"
          }
        >
          {run.state === "completed"
            ? "可调整主题或检索范围，重新提交需求。"
            : "核对方案后开始筛选，结果附带匹配依据。"}
        </Empty>
      )}
      <div className="export-save-row">
        <Select
          aria-label="资源导出格式"
          value={format}
          onValueChange={(nextValue) => setFormat(nextValue as ExportFormat)}
          items={[
            { value: "xlsx", label: "Excel 工作簿（.xlsx）" },
            { value: "csv", label: "CSV 表格（.csv）" },
            { value: "md", label: "Markdown 表格（.md）" },
            { value: "json", label: "JSON 数据（.json）" },
            { value: "txt", label: "文本清单（.txt）" },
          ]}
        />
        <Button
          primary
          disabled={
            locked ||
            run.state !== "completed" ||
            !selected.length ||
            columns.some((c) => !c.label.trim())
          }
          onClick={async () => {
            setWorking(true);
            try {
              const path = await command("resourceExport.file", {
                runId: run.id,
                ids: selected,
                columns,
                format,
              });
              if (path)
                notify(`已导出 ${selected.length} 份资源：${path}`, "success");
            } finally {
              setWorking(false);
            }
          }}
        >
          <Download size={15} />
          导出所选资源
        </Button>
      </div>
      <small>
        截图还原表头、顺序和字段含义；当前导出为标准表格，不复刻合并单元格与装饰样式。未记录的信息留空。本人链接、提取码列在保存前重新核验；提取码仅在选入该列时导出，不发送给AI。
      </small>
    </Panel>
  );
}
