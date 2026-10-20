import { ArrowRight } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import { Button, Field, Panel } from "../ui/primitives";

import type { TrafficModel } from "./useTrafficDiscovery";
export function TrafficPools({ model }: { model: TrafficModel }) {
  const { data } = useAppData();
  const { resource, select } = useAppSelection();
  const { command } = useAppActions();
  const { navigate, openSearch } = useAppNavigation();
  const { busy } = useAppActivity();
  const {
    manualName,
    setManualName,
    manualWords,
    setManualWords,
    manualBound,
    setManualBound,
  } = model;
  return (
    <>
      <Panel title="手工整理词池">
        <Field label="手工词池名称">
          <input
            aria-label="手工词池名称"
            value={manualName}
            maxLength={100}
            onChange={(e) => setManualName(e.target.value)}
          />
        </Field>
        <Field label="关键词" hint="逗号或换行分隔，去重保存，最多1000词">
          <textarea
            aria-label="手工词池关键词"
            value={manualWords}
            maxLength={200000}
            onChange={(e) => setManualWords(e.target.value)}
          />
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={manualBound}
            disabled={!resource}
            onChange={(e) => setManualBound(e.target.checked)}
          />
          关联当前资源
          {resource ? `：${resource.title}` : "（请先选择资源）"}
        </label>
        <Button
          disabled={!manualName.trim() || !manualWords.trim() || busy > 0}
          onClick={async () => {
            const saved = await command(
              "pool.manual",
              {
                name: manualName,
                words: manualWords,
                resourceId: manualBound ? (resource?.id ?? null) : null,
              },
              "手工词池已保存在本地，未调用付费接口。",
            );
            if (saved) {
              setManualName("");
              setManualWords("");
            }
          }}
        >
          保存手工词池
        </Button>
        <small>
          手工词不附流量指数；复制已有词池进行整理时会另存副本，原稿引用保持有效。
        </small>
      </Panel>
      <Panel
        title="我的词池"
        extra={
          <Button
            quiet
            disabled={!data!.pools.length}
            onClick={() => navigate("studio")}
          >
            去创作 <ArrowRight size={14} />
          </Button>
        }
      >
        {data!.pools.length ? (
          <div className="pool-list">
            {data!.pools.map((p) => (
              <div key={p.id}>
                <strong>{p.name}</strong>
                <small>
                  {p.keywords.length}个词 ·{" "}
                  {p.resourceId
                    ? data!.resources.find((r) => r.id === p.resourceId)?.title
                    : "尚未关联资源"}
                </small>
                <div className="row compact">
                  {p.keywords.slice(0, 5).map((k) => (
                    <span className="tag" key={k.id}>
                      {k.word}
                    </span>
                  ))}
                </div>
                <Button quiet onClick={() => openSearch({ poolId: p.id })}>
                  创建搜索选题
                </Button>
                <Button
                  quiet
                  onClick={() => {
                    setManualName(`${p.name.slice(0, 90)} 副本`);
                    setManualWords(p.keywords.map((k) => k.word).join("\n"));
                    setManualBound(!!p.resourceId);
                    if (p.resourceId) select(p.resourceId);
                  }}
                >
                  复制编辑
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">
            选择相关词并保存，后续可以用于不同平台的内容创作。
          </p>
        )}
      </Panel>
    </>
  );
}
