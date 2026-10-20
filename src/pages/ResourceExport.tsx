import { QueryError } from "../ui/QueryError";
import { FileOutput } from "lucide-react";
import { Header, LoadingState, Panel } from "../ui/primitives";
import { useAppData } from "../state";
import { useResourceExport } from "../resource-export/useResourceExport";
import { ExportRequest } from "../resource-export/ExportRequest";
import { ExportPlan } from "../resource-export/ExportPlan";
import { ExportTable } from "../resource-export/ExportTable";
import { ExportArticle } from "../resource-export/ExportArticle";
import "../resource-export.css";
export default function ResourceExportPage() {
  const { data } = useAppData();
  const model = useResourceExport(data!.dataPath);
  return (
    <>
      <Header
        title="把资源库，整理成你需要的样子。"
        description="用文字描述筛选目标，或附上一张表格截图。从需求到清单，再到一篇主题短文。"
        action={
          <span className="tag">
            <FileOutput size={14} /> AI 资源导出
          </span>
        }
      />
      <div
        className={`export-workspace ${model.run?.state === "completed" ? "export-completed" : ""}`}
      >
        {model.run?.state === "completed" ? (
          <details className="export-input-summary">
            <summary>筛选已完成 · 查看需求、历史或开始新导出</summary>
            <ExportRequest model={model} />
          </details>
        ) : (
          <ExportRequest model={model} />
        )}
        <div className="export-result-column">
          {model.loading && !model.run ? (
            <Panel>
              <LoadingState label="正在恢复导出工作区…">
                正在读取最近记录，当前输入会保留。
              </LoadingState>
            </Panel>
          ) : model.historyError && !model.run ? (
            <Panel>
              <QueryError
                error={model.historyError}
                loading={model.loading}
                onRetry={model.retryHistory}
                title="导出工作区暂未恢复"
                compact={false}
              />
            </Panel>
          ) : !model.run ? (
            <Panel className="export-welcome">
              <div className="export-welcome-icon">
                <FileOutput size={36} />
              </div>
              <h2>先说你想整理什么</h2>
              <p>
                主题筛选、格式筛选、截图表头、资料推荐。
                <br />
                每一行都来自本地资源，每一个结果都可以核对。
              </p>
              <div className="export-process">
                <span>01 解析需求</span>
                <span>02 全库筛选</span>
                <span>03 核对导出</span>
              </div>
            </Panel>
          ) : (
            <>
              <ExportPlan model={model} />
              <ExportTable model={model} />
              <ExportArticle model={model} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
