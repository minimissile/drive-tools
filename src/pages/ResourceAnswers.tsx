import { useResourceAnswers } from "../resource-answers/useResourceAnswers";
import { AnswerSourceForm } from "../resource-answers/AnswerSourceForm";
import { AnswerVersions } from "../resource-answers/AnswerVersions";
import { AnswerMedia } from "../resource-answers/AnswerMedia";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import "../resource-answers/resource-answers.css";
export default function ResourceAnswers() {
  const model = useResourceAnswers();
  const { current } = model;
  return (
    <OperationsWorkspace
      title="资源问答"
      description="输入问题，结合已有资源生成内容；补充说明，逐版校准。"
    >
      <div className="resource-answers-layout">
        <AnswerSourceForm model={model} />
        <div className="resource-answers-results">
          <AnswerVersions model={model} />
          {current?.status === "completed" && current.draftId ? (
            <AnswerMedia key={current.draftId} draftId={current.draftId} />
          ) : null}
        </div>
      </div>
    </OperationsWorkspace>
  );
}
