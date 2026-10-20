import { Button, Field, Notice } from "../../ui/primitives";
import { Select } from "../../ui/Select";
import type { ResearchDraft } from "./research-draft";
import type { useBaiduResearch } from "./useBaiduResearch";

export function BaiduRankingForm({
  draft,
  canSubmit,
  businessOptions,
  businesses,
  readyDate,
}: {
  draft: ResearchDraft;
  canSubmit: boolean;
  businessOptions: { value: string; label: string }[];
  businesses: ReturnType<typeof useBaiduResearch>;
  readyDate: ReturnType<typeof useBaiduResearch>;
}) {
  const d = draft.value;
  return (
    <>
      <div className="baidu-form-grid">
        <Field label="榜单">
          <Select
            aria-label="关键词榜单类型"
            value={d.rankTab}
            onValueChange={(rankTab) => draft.update({ rankTab })}
            items={[
              { value: "search", label: "热搜词榜" },
              { value: "cost", label: "高消费词榜" },
              { value: "conversion", label: "高转化词榜" },
            ]}
          />
        </Field>
        <Field label="推广业务">
          <Select
            aria-label="榜单推广业务"
            value={d.businessId}
            onValueChange={(businessId) => draft.update({ businessId })}
            items={[
              {
                value: "",
                label: businessOptions.length
                  ? "请选择业务"
                  : "先读取百度业务目录",
              },
              ...businessOptions,
            ]}
          />
        </Field>
      </div>
      <div className="row wrap">
        <Button
          quiet
          disabled={!canSubmit}
          onClick={() => void businesses.run({})}
        >
          读取业务目录
        </Button>
        <Button
          quiet
          disabled={!canSubmit || readyDate.pending}
          onClick={() => void readyDate.run({})}
        >
          读取榜单更新日期
        </Button>
        {readyDate.result ? (
          <span>
            榜单日期：
            {typeof readyDate.result.data === "string"
              ? readyDate.result.data
              : JSON.stringify(readyDate.result.data)}
          </span>
        ) : null}
      </div>
    </>
  );
}
