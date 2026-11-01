import { useEffect } from "react";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { useTaskFocus } from "../tasks/TaskFocus";
import { GenerationWorkbench } from "./GenerationWorkbench";
import { PublishUpload } from "./PublishUpload";
import { PublishHistory } from "./PublishHistory";
import { useOperation } from "./hooks";
import { usePublishingView } from "./usePublishingView";
import "./publishing.css";

export default function Publish() {
  const { focus } = useTaskFocus();
  const view = usePublishingView();
  const model = useOperation("publish");
  useEffect(() => {
    if (focus?.kind === "publish") view.update({ tab: "history" });
    if (focus?.kind === "template") view.update({ tab: "generate" });
  }, [focus, view.update]);
  return (
    <OperationsWorkspace
      title="问答发布"
      description="从资料生成问答，审核后批量上传，集中跟进平台审核与发布记录。"
    >
      <Tabs value={view.value.tab} onChange={(tab) => view.update({ tab })}>
        <TabList
          label="百度知道问答发布"
          items={[
            ["generate", "生成问答"],
            ["upload", "审核上传"],
            ["history", "发布记录"],
          ]}
        />
        <TabPanel value="generate">
          <GenerationWorkbench onReady={() => view.update({ tab: "upload" })} />
        </TabPanel>
        <TabPanel value="upload">
          <PublishUpload
            model={model}
            onGenerate={() => view.update({ tab: "generate" })}
            onSubmitted={() => view.update({ tab: "history" })}
          />
        </TabPanel>
        <TabPanel value="history">
          <PublishHistory model={model} />
        </TabPanel>
      </Tabs>
      {view.error ? (
        <p className="danger-text" role="alert">
          {view.error}
        </p>
      ) : null}
    </OperationsWorkspace>
  );
}
