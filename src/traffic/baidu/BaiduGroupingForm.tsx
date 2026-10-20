import { Button, Field, Notice } from "../../ui/primitives";
import { Select } from "../../ui/Select";
import type { ResearchDraft } from "./research-draft";
import type { useBaiduResearch } from "./useBaiduResearch";
import { useState } from "react";
import { z } from "zod";
import { useAppActions } from "../../state";
import type { useBaiduGroupFile } from "./useBaiduGroupFile";

export function BaiduGroupingForm({
  draft,
  groupFile,
  canSubmit,
  dimensionsCount,
  templates,
  model,
  onSaveTemplate,
}: {
  draft: ResearchDraft;
  groupFile: ReturnType<typeof useBaiduGroupFile>;
  canSubmit: boolean;
  dimensionsCount: number;
  templates: ReturnType<typeof useBaiduResearch>;
  model: ReturnType<typeof useBaiduResearch>;
  onSaveTemplate(): Promise<void>;
}) {
  const d = draft.value,
    { file, uploaded, uploading } = groupFile,
    { notify } = useAppActions();
  const [selectedTemplate, setSelectedTemplate] = useState("");
  return (
    <>
      <Field
        label="待分组关键词表格"
        hint="XLSX第一列放关键词，最多10万词，文件不超过8MB"
      >
        <input
          type="file"
          accept=".xlsx"
          aria-label="分组关键词文件"
          disabled={uploading}
          onChange={(e) => void groupFile.choose(e.target.files?.[0] ?? null)}
        />
      </Field>
      <div className="row wrap">
        <Button
          disabled={!canSubmit || !file || !!uploaded}
          onClick={() => void groupFile.upload()}
        >
          {uploading
            ? "正在上传…"
            : uploaded
              ? "已上传到百度"
              : "上传关键词到百度"}
        </Button>
        {file ? (
          <span>
            {file.name}
            {uploaded ? " · 已上传" : " · 已在本机暂存，尚未上传"}
          </span>
        ) : null}
      </div>
      <p>
        <strong>分组维度</strong>
        <small>
          {" "}
          · 最多7个维度，每维度最多20个词根；未填写内容的维度不参与分组。
        </small>
      </p>
      <div className="baidu-dimensions">
        {d.dimensions.map((dimension, index) => (
          <div className="baidu-dimension" key={index}>
            <Field label={`维度${index + 1}名称`}>
              <input
                aria-label={`分组维度${index + 1}名称`}
                value={dimension.dimensionName}
                maxLength={100}
                onChange={(e) =>
                  draft.update({
                    dimensions: d.dimensions.map((x, i) =>
                      i === index ? { ...x, dimensionName: e.target.value } : x,
                    ),
                  })
                }
              />
            </Field>
            <Field label="词根" hint="逗号、分号或换行分隔">
              <textarea
                aria-label={`分组维度${index + 1}词根`}
                rows={3}
                maxLength={2100}
                value={dimension.roots}
                onChange={(e) =>
                  draft.update({
                    dimensions: d.dimensions.map((x, i) =>
                      i === index ? { ...x, roots: e.target.value } : x,
                    ),
                  })
                }
              />
            </Field>
            <Button
              quiet
              onClick={() =>
                draft.update({
                  dimensions: d.dimensions.filter((_, i) => i !== index),
                })
              }
            >
              移除此维度
            </Button>
          </div>
        ))}
      </div>
      <div className="row wrap">
        <Button
          quiet
          disabled={d.dimensions.length >= 7}
          onClick={() =>
            draft.update({
              dimensions: [
                ...d.dimensions,
                {
                  type: 4,
                  dimensionName: `自定义${d.dimensions.length + 1}`,
                  roots: "",
                },
              ],
            })
          }
        >
          添加自定义维度
        </Button>
        <Button
          quiet
          disabled={!canSubmit}
          onClick={() => void templates.run({})}
        >
          读取分组模板
        </Button>
      </div>
      {Array.isArray(templates.result?.data) ? (
        <Field label="套用已有模板">
          <Select
            value={selectedTemplate}
            aria-label="已有分组模板"
            items={[
              { value: "", label: "请选择模板" },
              ...(
                templates.result.data as {
                  templateId: string | number;
                  templateName: string;
                }[]
              ).map((t) => ({
                value: t.templateId,
                label: t.templateName,
              })),
            ]}
            onValueChange={async (templateId) => {
              if (!templateId) return;
              setSelectedTemplate(templateId);
              const r = await model.run(
                { operation: "templateDetail", templateId },
                false,
              );
              if (r && Array.isArray(r.data)) {
                const parsed = z
                  .array(
                    z.object({
                      dimensionName: z.string(),
                      keywordRoot: z.array(z.string()).min(1).max(20),
                    }),
                  )
                  .min(1)
                  .max(7)
                  .safeParse(r.data);
                if (parsed.success)
                  draft.update({
                    dimensions: parsed.data.map((x) => ({
                      type:
                        (
                          {
                            region: 1,
                            businessPoint: 2,
                            keyword: 3,
                          } as Record<string, number>
                        )[x.dimensionName] ?? 4,
                      dimensionName:
                        (
                          {
                            region: "地域",
                            businessPoint: "业务",
                            keyword: "词性",
                          } as Record<string, string>
                        )[x.dimensionName] ?? x.dimensionName,
                      roots: x.keywordRoot.join("\n"),
                    })),
                  });
                else {
                  setSelectedTemplate("");
                  notify("百度模板格式变化，未覆盖当前规则。", "error");
                }
              } else {
                setSelectedTemplate("");
              }
            }}
          />
        </Field>
      ) : null}
      <div className="baidu-form-grid">
        <Field label="分组模板名称">
          <input
            maxLength={100}
            value={d.templateName}
            onChange={(e) => draft.update({ templateName: e.target.value })}
          />
        </Field>
        <Button
          disabled={!canSubmit || !dimensionsCount || !d.templateName.trim()}
          onClick={() => void onSaveTemplate()}
        >
          保存分组模板到百度
        </Button>
      </div>
      <label>
        <input
          type="checkbox"
          checked={d.outputUngroupedWords}
          onChange={(e) =>
            draft.update({ outputUngroupedWords: e.target.checked })
          }
        />{" "}
        输出结果中附上原始关键词
      </label>
    </>
  );
}
