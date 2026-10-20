import { Button, Field, Notice } from "../../ui/primitives";
import { Select } from "../../ui/Select";
import type { ResearchDraft } from "./research-draft";
import type { useBaiduResearch } from "./useBaiduResearch";
import { splitBaiduWords } from "./options";

export function BaiduKeywordListForm({
  draft,
  tool,
}: {
  draft: ResearchDraft;
  tool: "flow" | "mass";
}) {
  const d = draft.value;
  return (
    <>
      <Field
        label={tool === "mass" ? "种子词" : "待查询关键词"}
        hint={
          tool === "mass"
            ? "最多1000个种子词，逗号、分号或换行分隔"
            : "最多1000词，每词最多40字；支持从榜单和行业热词带入"
        }
      >
        <textarea
          aria-label={tool === "mass" ? "海量拓词种子词" : "流量查询关键词"}
          rows={5}
          maxLength={101000}
          value={d.words}
          onChange={(e) => draft.update({ words: e.target.value })}
        />
      </Field>
      <small>已输入 {splitBaiduWords(d.words).length} / 1000 词</small>
      {tool === "flow" ? (
        <div className="baidu-form-grid">
          <Field label="匹配模式">
            <Select
              aria-label="流量查询匹配模式"
              value={d.match}
              onValueChange={(match) => draft.update({ match })}
              items={[
                { value: "auto", label: "使用百度默认" },
                { value: "1-1", label: "精确匹配" },
                { value: "2-1", label: "短语匹配" },
                { value: "3-1", label: "智能匹配" },
              ]}
            />
          </Field>
          <Field label="参考出价（元）" hint="留空由百度估算">
            <input
              type="number"
              min="0.01"
              max="9999"
              step="0.01"
              value={d.price}
              onChange={(e) => draft.update({ price: e.target.value })}
            />
          </Field>
          <Field label="设备">
            <Select
              aria-label="流量查询设备"
              value={d.device}
              onValueChange={(v) => draft.update({ device: Number(v) })}
              items={[
                { value: 0, label: "全部设备" },
                { value: 1, label: "计算机" },
                { value: 2, label: "移动" },
              ]}
            />
          </Field>
        </div>
      ) : (
        <Field label="排除词根" hint="最多100个">
          <textarea
            rows={2}
            maxLength={10100}
            value={d.negative}
            onChange={(e) => draft.update({ negative: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}
