import { useAppNavigation } from "../state";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import { GenerationWorkbench } from "./GenerationWorkbench";
import { usePublishingView } from "./usePublishingView";

export default function Templates() {
  const { navigate } = useAppNavigation();
  const view = usePublishingView();
  return (
    <OperationsWorkspace
      title="问答模板"
      description="导入资源表格或选择本人资料，配置赛道与回答结构，预览后生成待审核问答。"
    >
      <GenerationWorkbench
        onReady={() => {
          view.update({ tab: "upload" });
          navigate("zhidao-publish");
        }}
      />
    </OperationsWorkspace>
  );
}
