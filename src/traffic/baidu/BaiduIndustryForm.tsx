import { Button, Field, Notice } from "../../ui/primitives";
import { Select } from "../../ui/Select";
import type { ResearchDraft } from "./research-draft";
import type { useBaiduResearch } from "./useBaiduResearch";

export function BaiduIndustryForm({
  draft,
  canSubmit,
  industryOptions,
  industries,
  industryChildren,
}: {
  draft: ResearchDraft;
  canSubmit: boolean;
  industryOptions: { value: string; label: string }[];
  industries: ReturnType<typeof useBaiduResearch>;
  industryChildren: ReturnType<typeof useBaiduResearch>;
}) {
  const d = draft.value;
  return (
    <>
      <div className="baidu-form-grid">
        <Field label="数据分类">
          <Select
            aria-label="行业洞察分类"
            value={d.category}
            onValueChange={(category) => draft.update({ category, trade: "" })}
            items={[
              { value: "trade", label: "按行业查看" },
              { value: "business", label: "按推广业务查看" },
            ]}
          />
        </Field>
        <Field label="行业或推广业务">
          <Select
            aria-label="行业洞察业务"
            value={d.trade}
            onValueChange={(trade) => draft.update({ trade })}
            items={[
              { value: "", label: "请选择行业或业务" },
              ...industryOptions,
            ]}
          />
        </Field>
      </div>
      <Button
        quiet
        disabled={!canSubmit}
        onClick={() => void industries.run({})}
      >
        读取行业与业务目录
      </Button>
      {d.category === "business" ? (
        <Button
          quiet
          disabled={!canSubmit || !d.trade}
          onClick={() =>
            void industryChildren.run({ trades: d.trade.split(" / ") })
          }
        >
          读取下级推广业务
        </Button>
      ) : null}
      <div className="baidu-form-grid" data-columns="3">
        <Field label="开始日期">
          <input
            aria-label="洞察开始日期"
            type="date"
            value={d.startDate}
            onChange={(e) => draft.update({ startDate: e.target.value })}
          />
        </Field>
        <Field label="结束日期">
          <input
            aria-label="洞察结束日期"
            type="date"
            value={d.endDate}
            onChange={(e) => draft.update({ endDate: e.target.value })}
          />
        </Field>
        <Field label="设备">
          <Select
            value={d.industryDevice}
            onValueChange={(industryDevice) => draft.update({ industryDevice })}
            items={[
              { value: "all", label: "全部设备" },
              { value: "pc", label: "计算机" },
              { value: "wise", label: "移动" },
            ]}
          />
        </Field>
      </div>
      <div className="baidu-form-grid">
        <Field label="查看内容">
          <Select
            aria-label="行业洞察内容"
            value={d.industryView}
            onValueChange={(industryView) => draft.update({ industryView })}
            items={[
              { value: "words", label: "行业搜索词" },
              { value: "trend", label: "行业搜索趋势" },
            ]}
          />
        </Field>
        {d.industryView === "words" ? (
          <Field label="词榜类型">
            <Select
              aria-label="行业词榜类型"
              value={d.wordType}
              onValueChange={(wordType) => draft.update({ wordType })}
              items={[
                { value: "hotWord", label: "热搜词" },
                { value: "newWord", label: "新增词" },
                { value: "boomingWord", label: "激增词" },
              ]}
            />
          </Field>
        ) : (
          <>
            <Field label="地域范围">
              <Select
                value={d.geoGran}
                onValueChange={(geoGran) => draft.update({ geoGran })}
                items={[
                  { value: "country", label: "全国" },
                  { value: "province", label: "省份" },
                  { value: "city", label: "城市" },
                ]}
              />
            </Field>
            {d.geoGran !== "country" ? (
              <Field
                label="省份或城市名称"
                hint="使用原站地域名称，多个用逗号分隔"
              >
                <input
                  value={d.geoTarget}
                  onChange={(e) => draft.update({ geoTarget: e.target.value })}
                />
              </Field>
            ) : null}
          </>
        )}
      </div>
      <Notice>
        行业洞察使用百度观星盘登录。首次使用请点击“打开对应官方工具”完成平台验证，之后复用该账号会话。
      </Notice>
    </>
  );
}
