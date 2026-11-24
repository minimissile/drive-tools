import { useEffect } from "react";
import { useTaskFocus } from "../tasks/TaskFocus";
import { PublishingWorkflow } from "./PublishingWorkflow";
import { Button, Header } from "../ui/primitives";
import { PublishUpload } from "./PublishUpload";
import { PublishHistory } from "./PublishHistory";
import { useOperation } from "./hooks";
import { usePublishingView } from "./usePublishingView";
import { useAppNavigation } from "../state";
import "./publishing.css";
import "../workbench/operations.css";

export default function Publish() {
  const { focus } = useTaskFocus();
  const { navigate } = useAppNavigation();
  const view = usePublishingView();
  const model = useOperation("publish");
  useEffect(() => {
    if (focus?.kind === "publish") view.update({ tab: "history" });
    if (focus?.kind === "template") view.update({ tab: "generate" });
  }, [focus, view.update]);
  const pageActions = (
    <div className="publishing-page-actions">
      {view.value.tab !== "generate" ? (
        <Button
          quiet
          size="compact"
          onClick={() => view.update({ tab: "generate" })}
        >
          返回五步制作表格
        </Button>
      ) : null}
      {view.value.tab !== "upload" ? (
        <Button
          quiet
          size="compact"
          onClick={() => view.update({ tab: "upload" })}
        >
          已有问答上传
        </Button>
      ) : null}
      {view.value.tab !== "history" ? (
        <Button
          quiet
          size="compact"
          onClick={() => view.update({ tab: "history" })}
        >
          发布记录
        </Button>
      ) : null}
      <Button quiet size="compact" onClick={() => navigate("zhidao-accounts")}>
        管理知道账号
      </Button>
    </div>
  );
  return (
    <div className="operations-workspace publishing-workspace">
      {view.value.tab !== "generate" ? (
        <Header title="问答发布" action={pageActions} />
      ) : null}
      {view.value.tab === "generate" ? (
        <PublishingWorkflow headerActions={pageActions} />
      ) : null}
      {view.value.tab === "upload" ? (
        <PublishUpload
          model={model}
          onGenerate={() => view.update({ tab: "generate" })}
          onSubmitted={() => view.update({ tab: "history" })}
        />
      ) : null}
      {view.value.tab === "history" ? <PublishHistory model={model} /> : null}
      {view.error ? (
        <p className="danger-text" role="alert">
          {view.error}
        </p>
      ) : null}
    </div>
  );
}
