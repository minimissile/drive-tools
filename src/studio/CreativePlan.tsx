import { Select } from "../ui/Select";
import { Field } from "../ui/primitives";
import type { CreativePackage } from "../../shared/studio";
import { studioRatios } from "../../shared/studio-options";

export function CreativePlan({
  value,
  onChange,
  disabled,
}: {
  value: CreativePackage;
  onChange(value: CreativePackage): void;
  disabled: boolean;
}) {
  const kind = value.format === "video" ? "video" : "image";
  return (
    <>
      <Field label="当前版本画面比例">
        <Select
          aria-label="当前内容画面比例"
          value={value.aspectRatio}
          disabled={disabled}
          onValueChange={(nextValue) =>
            onChange({
              ...value,
              aspectRatio: nextValue as CreativePackage["aspectRatio"],
            })
          }
          items={[...studioRatios.map((r) => ({ value: r, label: r }))]}
        />
      </Field>
      {kind === "video" ? (
        <>
          <Field label="动态画面要求" hint="主体、动作、场景、镜头运动与转场">
            <textarea
              aria-label="视频画面要求"
              value={value.videoPrompt}
              maxLength={8000}
              disabled={disabled}
              rows={6}
              onChange={(e) =>
                onChange({ ...value, videoPrompt: e.target.value })
              }
            />
          </Field>
          <Field label="口播参考稿" hint="供审阅和后期配音使用">
            <textarea
              aria-label="视频口播参考"
              value={value.voiceover}
              maxLength={5000}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...value, voiceover: e.target.value })
              }
            />
          </Field>
          <small>
            原生音频由视频模型能力决定；参考口播不代表已经自动配音、添加字幕或完成口型同步。
          </small>
        </>
      ) : (
        value.cards.map((card, i) => (
          <details className="creative-card-plan" key={i} open={i === 0}>
            <summary>
              第 {i + 1} 页 · {card.heading || "图片方案"}
              <small className="creative-card-summary">
                文案：{card.copy || "尚未填写页面文字"}
              </small>
              <small className="creative-card-summary">
                画面：{card.imagePrompt || "尚未填写画面要求"}
              </small>
            </summary>
            <Field label="页面标题">
              <input
                aria-label={`第${i + 1}页标题`}
                disabled={disabled}
                value={card.heading}
                maxLength={120}
                onChange={(e) =>
                  onChange({
                    ...value,
                    cards: value.cards.map((v, n) =>
                      n === i ? { ...v, heading: e.target.value } : v,
                    ),
                  })
                }
              />
            </Field>
            <Field label="页面文字">
              <textarea
                aria-label={`第${i + 1}页文案`}
                disabled={disabled}
                value={card.copy}
                maxLength={1500}
                onChange={(e) =>
                  onChange({
                    ...value,
                    cards: value.cards.map((v, n) =>
                      n === i ? { ...v, copy: e.target.value } : v,
                    ),
                  })
                }
              />
            </Field>
            <Field label="图片画面要求">
              <textarea
                aria-label={`第${i + 1}页画面要求`}
                disabled={disabled}
                value={card.imagePrompt}
                maxLength={4000}
                onChange={(e) =>
                  onChange({
                    ...value,
                    cards: value.cards.map((v, n) =>
                      n === i ? { ...v, imagePrompt: e.target.value } : v,
                    ),
                  })
                }
              />
            </Field>
          </details>
        ))
      )}
    </>
  );
}
