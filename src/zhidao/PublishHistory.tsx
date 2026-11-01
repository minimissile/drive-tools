import { useEffect } from "react";
import { Send } from "lucide-react";
import type { OperationModel } from "./hooks";
import { RunPanel } from "./RunPanel";
import { ResultTable } from "./Results";

export function PublishHistory({ model }: { model: OperationModel }) {
  const firstId = model.history.data?.items[0]?.id;
  const { id, pick } = model;
  useEffect(() => {
    if (!id && firstId) pick({ id: firstId });
  }, [id, firstId, pick]);
  return (
    <RunPanel
      model={model}
      title="发布记录"
      emptyTitle="还没有发布记录"
      emptyDescription="审核并上传问答后，可在这里查看提交进度、查询平台审核并核对异常结果。"
      emptyIcon={Send}
    >
      {(items) => (
        <ResultTable
          items={items}
          publication
          running={model.running}
          onChanged={model.refresh}
        />
      )}
    </RunPanel>
  );
}
