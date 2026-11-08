import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { Header } from "../ui/primitives";
import { useAppActions } from "../state";
import TrafficKnowledge from "../traffic/TrafficKnowledge";
import { useTrafficDiscovery } from "../traffic/useTrafficDiscovery";
import { TrafficQuery } from "../traffic/TrafficQuery";
import { TrafficResults } from "../traffic/TrafficResults";
import { TrafficPools } from "../traffic/TrafficPools";
import BaiduTraffic from "../traffic/baidu/BaiduTraffic";
export default function Traffic() {
  const { notify } = useAppActions();
  const model = useTrafficDiscovery();
  const { tab, setTab, setResult, setQueryFeedback, seeds, setSeeds } = model;
  return (
    <Tabs
      value={tab}
      onChange={(next) => {
        setTab(next);
        setResult(null);
        setQueryFeedback(null);
      }}
    >
      <Header
        title="流量词库"
        description="筛选积累的关键词，整理词池，带入找词与内容创作。"
      />
      <TabList
        label="流量词库功能"
        items={[
          ["knowledge", "关键词库"],
          ["pools", "我的词池"],
          ["words", "5118找词"],
          ["baidu", "百度营销"],
          ["hotspots", "找热点"],
        ]}
      />
      <TabPanel value={tab}>
        {tab === "baidu" ? (
          <BaiduTraffic onOpenKnowledge={() => setTab("knowledge")} />
        ) : tab === "knowledge" ? (
          <TrafficKnowledge
            onOpenPools={() => setTab("pools")}
            onAppend={(words) => {
              const current = seeds
                .split(/[,，\n]/)
                .map((s) => s.trim())
                .filter(Boolean);
              const combined = [...new Set([...current, ...words])];
              if (
                combined.length > 50 ||
                combined.some((w) => w.length > 100)
              ) {
                notify(
                  "找词最多50个种子词，每词最多100字，请减少选择。",
                  "warning",
                );
                return;
              }
              setSeeds(combined.join("，"));
              setTab("words");
              notify("已带入找词，可展开AI联想；尚未发出外部请求。", "info");
            }}
          />
        ) : tab === "pools" ? (
          <TrafficPools model={model} />
        ) : (
          <>
            <TrafficQuery model={model} />
            <TrafficResults model={model} />
          </>
        )}
      </TabPanel>
    </Tabs>
  );
}
