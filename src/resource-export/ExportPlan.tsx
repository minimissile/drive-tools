import { Pause, Play } from "lucide-react";
import { Button, Field, Notice, Panel } from "../ui/primitives";

import type { ExportModel } from "./useResourceExport";
const stateNames = {
  planned: "等待确认",
  running: "正在筛选",
  paused: "可继续",
  completed: "筛选完成",
  failed: "等待重试",
};
export function ExportPlan({ model }: { model: ExportModel }) {
  const {
    run,
    columns,
    criteria,
    setCriteria,
    brief,
    setBrief,
    scanning,
    continueScan,
    locked,
    scan,
  } = model;
  if (!run) return null;
  return (
    <Panel
      title="02 / 核对方案"
      extra={
        <span className="tag">
          {stateNames[scanning ? "running" : run.state]}
        </span>
      }
    >
      <h3>{run.plan.title}</h3>
      <Field
        label="筛选条件"
        hint={
          run.input.imageCount
            ? "结合截图识别，开始前请核对"
            : "保留原始文字需求，开始前可修改"
        }
      >
        <textarea
          aria-label="AI理解的筛选条件"
          value={criteria}
          disabled={locked || run.scanned > 0}
          maxLength={6000}
          onChange={(e) => setCriteria(e.target.value)}
        />
      </Field>
      <Field label="短文要求" hint="可选；完成筛选后生成">
        <textarea
          aria-label="短文要求"
          value={brief}
          maxLength={6000}
          rows={3}
          disabled={locked || run.scanned > 0}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="例如：面向英语教师，300字，按使用场景介绍"
        />
      </Field>
      {[...run.plan.warnings, ...run.warnings].length ? (
        <details className="export-boundaries">
          <summary>
            检索与格式说明（
            {run.plan.warnings.length + run.warnings.length}）
          </summary>
          {[...run.plan.warnings, ...run.warnings].map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </details>
      ) : null}
      <div className="export-progress">
        <progress
          aria-label="资源筛选进度"
          value={run.scanned}
          max={Math.max(1, run.total)}
        />
        <span>
          已判断 {run.scanned} / {run.total} 份，匹配 {run.records.length} 份
        </span>
      </div>
      <small>
        按提交时的全量资源快照，每批最多30份；可暂停或重启后继续。AI判断可能遗漏，请核对结果。
      </small>
      {run.error ? (
        <Notice warning>
          {run.error} 已完成的批次保留。重新继续会调用 AI。
        </Notice>
      ) : null}
      <div className="row">
        {scanning ? (
          <Button
            onClick={() => {
              continueScan.current = false;
            }}
          >
            <Pause size={14} />
            当前批次后暂停
          </Button>
        ) : run.state !== "completed" ? (
          <Button
            primary
            disabled={
              locked ||
              !criteria.trim() ||
              !columns.length ||
              columns.some((c) => !c.label.trim())
            }
            onClick={() => void scan()}
          >
            <Play size={14} />
            {run.scanned ? "继续筛选" : "确认并开始筛选"}
          </Button>
        ) : (
          <span className="good-text">全量筛选已完成，可以勾选导出。</span>
        )}
      </div>
    </Panel>
  );
}
