import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { Header } from "../ui/primitives";
import { useAppActions } from "../state";
import TrafficKnowledge from "../traffic/TrafficKnowledge";
import { useTrafficDiscovery } from "../traffic/useTrafficDiscovery";
import { TrafficCosts } from "../traffic/TrafficCosts";
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
        title="发现新词，也发现新的内容机会。"
        description="百度关键词、5118找词与热点候选；整理搜索需求，积累本地词池。"
      />
      <TabList
        label="流量发现功能"
        items={[
          ["words", "找词与词池"],
          ["baidu", "百度营销"],
          ["hotspots", "找热点"],
          ["costs", "调用与费用"],
          ["knowledge", "本地知识库"],
        ]}
      />
      <TabPanel value={tab}>
        {tab === "baidu" ? (
          <BaiduTraffic onOpenKnowledge={() => setTab("knowledge")} />
        ) : tab === "knowledge" ? (
          <TrafficKnowledge
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
        ) : tab === "costs" ? (
          <TrafficCosts />
        ) : (
          <>
            <TrafficQuery model={model} />
            <TrafficResults model={model} />
            <TrafficPools model={model} />
          </>
        )}
      </TabPanel>
    </Tabs>
  );
}
