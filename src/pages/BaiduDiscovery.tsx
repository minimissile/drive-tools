import { useAppData } from "../state";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import { useBaiduDiscovery } from "../baidu-discovery/useBaiduDiscovery";
import { DiscoveryForm } from "../baidu-discovery/DiscoveryForm";
import { DiscoveryResults } from "../baidu-discovery/DiscoveryResults";
import { DiscoveryTaskPanel } from "../baidu-discovery/DiscoveryTaskPanel";
import "../baidu-discovery/discovery.css";

export default function BaiduDiscoveryPage() {
  const { data } = useAppData();
  return <DiscoveryWorkspace key={data!.dataPath} workspace={data!.dataPath} />;
}
function DiscoveryWorkspace({ workspace }: { workspace: string }) {
  const model = useBaiduDiscovery(workspace);
  const run = model.run;
  return (
    <div className="baidu-discovery-workspace">
      <OperationsWorkspace
        title="百度批量扩词"
        description="后台采集联想词与相关搜索，清理后导出或配资料生成问答。"
      >
        <div className="baidu-discovery-layout">
          <DiscoveryForm
            workspace={workspace}
            disabled={
              !!model.pending ||
              model.running ||
              !!model.history.error ||
              (!model.history.data && model.history.loading)
            }
            onStart={model.start}
          />
          <DiscoveryTaskPanel model={model} />
          {run ? (
            <DiscoveryResults
              key={run.id}
              workspace={workspace}
              run={run}
              model={model}
            />
          ) : null}
        </div>
      </OperationsWorkspace>
    </div>
  );
}
