import { useEffect, useState } from "react";
import { z } from "zod";
import { miningCategories, miningInput } from "../../shared/zhidao";
import { useAppData, useAppNavigation } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";
import { OperationsWorkspace } from "./Workspace";
import { useOperation, useOperationAction } from "./hooks";
import { RunPanel } from "./RunPanel";
import { ResultTable } from "./Results";
export default function Mining() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation();
  const model = useOperation("mine"),
    action = useOperationAction();
  const draft = useLocalDraft(
    `panxu-mining:${data!.dataPath}`,
    {
      category: "软件" as (typeof miningCategories)[number],
      count: 50,
    },
    (v) => miningInput.omit({ live: true }).parse(v),
  );
  const [selected, setSelected] = useState<string[]>([]),
    [poolName, setPoolName] = useState(""),
    [live, setLive] = useState(false);
  useEffect(() => setSelected([]), [model.id]);
  return (
    <OperationsWorkspace
      title="热门挖词"
      description="从公开榜单获取具体名称，保留来源与历史去重；实际不足目标时保留实际结果。"
    >
      <Panel title="新建挖词任务">
        <div className="operations-form-grid">
          <Field label="资源领域">
            <Select
              value={draft.value.category}
              onValueChange={(category) =>
                draft.update({
                  category: category as (typeof miningCategories)[number],
                })
              }
              items={miningCategories.map((value) => ({ value, label: value }))}
            />
          </Field>
          <Field label="目标数量" hint="1–500个名称">
            <input
              type="number"
              min={1}
              max={500}
              value={draft.value.count}
              onChange={(e) => draft.update({ count: Number(e.target.value) })}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          补充公开搜索候选并用现有 AI 整理（产生模型费用）
        </label>
        {draft.error ? <Notice danger>{draft.error}</Notice> : null}
        <div className="operations-actions">
          <Button
            primary
            disabled={!!action.pending || model.running}
            onClick={() =>
              void action.run(
                "zhidao.start",
                {
                  kind: "mine",
                  input: { ...draft.value, live },
                  authorized: true,
                },
                (run) => {
                  setLive(false);
                  setSelected([]);
                  model.pick(run);
                },
                "挖词任务已开始",
              )
            }
          >
            开始挖词
          </Button>
          <small>榜单抓取不调用付费模型；AI 仅在勾选后执行。</small>
        </div>
      </Panel>
      <RunPanel model={model}>
        {(items) => (
          <>
            <div className="operations-selection">
              <span>已选{selected.length}项，跨页保留，最多100项</span>
              <Field label="词池名称">
                <input
                  value={poolName}
                  onChange={(e) => setPoolName(e.target.value)}
                  placeholder="例如：本周软件选题"
                  maxLength={100}
                />
              </Field>
              <Button
                disabled={
                  !selected.length || !poolName.trim() || !!action.pending
                }
                onClick={() =>
                  void action.run(
                    "zhidao.mine.pool",
                    { id: model.id, itemIds: selected, name: poolName },
                    undefined,
                    "已保存到现有词池",
                  )
                }
              >
                保存到词池
              </Button>
              <Button
                disabled={!selected.length || !!action.pending}
                onClick={() =>
                  void action.run(
                    "zhidao.mine.words",
                    { id: model.id, itemIds: selected },
                    (names) => {
                      localStorage.setItem(
                        `panxu-collect-handoff:${data!.dataPath}`,
                        JSON.stringify(names),
                      );
                      navigate("zhidao-collect");
                    },
                  )
                }
              >
                用所选词采集
              </Button>
            </div>
            <ResultTable
              items={items}
              selected={selected}
              onSelect={setSelected}
              onChanged={model.refresh}
            />
          </>
        )}
      </RunPanel>
    </OperationsWorkspace>
  );
}
