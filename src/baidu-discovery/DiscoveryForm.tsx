import { useState } from "react";
import { Play } from "lucide-react";
import { z } from "zod";
import {
  discoveryInputSchema,
  discoverySeeds,
  type DiscoverySource,
  type DiscoveryInput,
} from "../../shared/baidu-discovery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";

const draftSchema = z.object({
  text: z.string().max(25000),
  suggest: z.boolean(),
  related: z.boolean(),
  auto: z.boolean(),
  depth: z.number(),
  maxQueries: z.number(),
  interval: z.number(),
});
export function DiscoveryForm({
  workspace,
  disabled,
  onStart,
}: {
  workspace: string;
  disabled: boolean;
  onStart(input: DiscoveryInput): Promise<void>;
}) {
  const draft = useLocalDraft(
    `panxu-baidu-discovery-form:${workspace}`,
    {
      text: "",
      suggest: true,
      related: true,
      auto: false,
      depth: 2,
      maxQueries: 100,
      interval: 3,
    },
    (value) => draftSchema.parse(value),
  );
  const [error, setError] = useState("");
  const value = draft.value,
    seeds = discoverySeeds(value.text);
  const start = () => {
    const sources: DiscoverySource[] = [];
    if (value.suggest) sources.push("suggest");
    if (value.related) sources.push("related");
    const parsed = discoveryInputSchema.safeParse({
      seeds,
      sources,
      maxDepth: value.auto ? value.depth : 1,
      maxQueries: value.maxQueries,
      intervalMs: value.interval * 1000,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "请检查采集条件。");
      return;
    }
    setError("");
    void onStart(parsed.data);
  };
  return (
    <Panel
      title="采集设置"
      className="baidu-discovery-config"
      extra={<small>设置自动暂存</small>}
    >
      <div className="baidu-discovery-form">
        <Field label="初始关键词" hint={`${seeds.length} 个 · 每行一词`}>
          <textarea
            aria-label="初始关键词"
            title="每行一词，也支持逗号和分号分隔"
            rows={3}
            maxLength={25000}
            placeholder={"画竹子教程\n水墨画入门\n国画竹子画法"}
            value={value.text}
            onChange={(e) => draft.update({ text: e.target.value })}
          />
        </Field>
        <div className="baidu-discovery-settings">
          <fieldset>
            <legend>采集来源</legend>
            <div className="baidu-discovery-checks">
              <label>
                <input
                  type="checkbox"
                  checked={value.suggest}
                  onChange={(e) => draft.update({ suggest: e.target.checked })}
                />
                下拉联想词
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={value.related}
                  onChange={(e) => draft.update({ related: e.target.checked })}
                />
                相关搜索词
              </label>
            </div>
          </fieldset>
          <div className="baidu-discovery-options">
            <Field label="查询上限" hint="最多500">
              <input
                aria-label="查询词上限"
                type="number"
                min={1}
                max={500}
                value={value.maxQueries || ""}
                onChange={(e) =>
                  draft.update({ maxQueries: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="间隔（秒）" hint="1.5–30">
              <input
                aria-label="查询间隔（秒）"
                type="number"
                min={1.5}
                max={30}
                step={0.5}
                value={value.interval || ""}
                onChange={(e) =>
                  draft.update({ interval: Number(e.target.value) })
                }
              />
            </Field>
          </div>
          <div className="baidu-discovery-auto">
            <label>
              <input
                type="checkbox"
                checked={value.auto}
                onChange={(e) => draft.update({ auto: e.target.checked })}
              />
              自动继续扩词
            </label>
            <Select
              aria-label="自动扩词层数"
              disabled={!value.auto}
              value={value.depth}
              items={[
                { value: 2, label: "采集到第2层" },
                { value: 3, label: "采集到第3层" },
              ]}
              onValueChange={(depth) => draft.update({ depth: Number(depth) })}
            />
          </div>
          <div className="baidu-discovery-actions">
            <Button
              primary
              disabled={disabled || !seeds.length}
              onClick={start}
            >
              <Play size={15} />
              开始采集
            </Button>
          </div>
        </div>
      </div>
      {error || draft.error ? (
        <Notice danger>{error || draft.error}</Notice>
      ) : null}
    </Panel>
  );
}
