import { ArrowRight } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Pool } from "../../shared/types";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import { Button, Field, Panel } from "../ui/primitives";
import { TrafficPoolCard } from "./TrafficPoolCard";
import { poolSummary } from "./pools";

import type { TrafficModel } from "./useTrafficDiscovery";
export function TrafficPools({ model }: { model: TrafficModel }) {
  const { data } = useAppData();
  const { resource, select } = useAppSelection();
  const { command, notify } = useAppActions();
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
  const fingerprint = JSON.stringify([
    manualName,
    manualWords,
    manualBound,
    resource?.id,
  ]);
  const latestFingerprint = useRef(fingerprint);
  latestFingerprint.current = fingerprint;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const copy = (pool: Pool, expected: string) => {
    if (latestFingerprint.current !== expected) {
      notify(
        "词池已读取，但整理内容已有修改；再次点击复制编辑可替换当前内容。",
        "warning",
      );
      return;
    }
    setManualName(`${pool.name.slice(0, 90)} 副本`);
    setManualWords(pool.keywords.map((word) => word.word).join("\n"));
    setManualBound(!!pool.resourceId);
    if (pool.resourceId) select(pool.resourceId);
    const form = document.querySelector<HTMLDetailsElement>(
      ".knowledge-manual-pool",
    );
    if (form) {
      form.open = true;
      form.scrollIntoView({ block: "start" });
      form
        .querySelector<HTMLInputElement>("input")
        ?.focus({ preventScroll: true });
    }
  };
  return (
    <>
      <details className="knowledge-manual-pool">
        <summary>手工整理词池</summary>
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
            const submitted = latestFingerprint.current;
            const saved = await command(
              "pool.manual",
              {
                name: manualName,
                words: manualWords,
                resourceId: manualBound ? (resource?.id ?? null) : null,
              },
              "手工词池已保存在本地，未调用付费接口。",
            );
            if (
              saved &&
              mounted.current &&
              latestFingerprint.current === submitted
            ) {
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
      </details>
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
              <TrafficPoolCard
                key={p.id}
                pool={poolSummary(p)}
                resourceTitle={
                  p.resourceId
                    ? (data!.resources.find(
                        (resource) => resource.id === p.resourceId,
                      )?.title ?? "关联资源未在当前列表")
                    : "尚未关联资源"
                }
                draftFingerprint={fingerprint}
                onCopy={copy}
                onSearch={() => openSearch({ poolId: p.id })}
              />
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
