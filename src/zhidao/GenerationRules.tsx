import { useState } from "react";
import { X } from "lucide-react";
import { answerStyleNames } from "../../shared/answer-styles";
import {
  generationTracks,
  type GenerationRules as Rules,
} from "../../shared/zhidao-generation";
import { Button, Field } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";

export function GenerationRuleFields({
  value,
  onChange,
  disabled,
}: {
  value: Rules;
  onChange(patch: Partial<Rules>): void;
  disabled: boolean;
}) {
  const [word, setWord] = useState("");
  const addWord = () => {
    const next = word.trim();
    if (next && value.keywords.length < 12 && !value.keywords.includes(next)) {
      onChange({ keywords: [...value.keywords, next] });
      setWord("");
    }
  };
  return (
    <>
      <section className="generation-rule-section">
        <h3>赛道与生成方式</h3>
        <div className="generation-pair">
          <Field label="内容赛道">
            <Select
              value={value.track}
              disabled={disabled}
              onValueChange={(track) =>
                onChange({
                  track: track as Rules["track"],
                  prefixes: generationTracks[track as Rules["track"]].prefixes,
                  suffixes: "？",
                })
              }
              items={Object.entries(generationTracks).map(([key, track]) => ({
                value: key as Rules["track"],
                label: track.label,
              }))}
            />
          </Field>
          <Field label="生成方式">
            <Select
              value={value.mode}
              disabled={disabled}
              onValueChange={(mode) =>
                onChange({ mode: mode as Rules["mode"] })
              }
              items={[
                { value: "template", label: "按模板整理 · 不调用AI" },
                { value: "ai", label: "AI 定制 · 按模型计费" },
              ]}
            />
          </Field>
        </div>
        {value.mode === "ai" ? (
          <Field label="回答风格">
            <Select
              value={value.style}
              disabled={disabled}
              onValueChange={(style) =>
                onChange({ style: style as Rules["style"] })
              }
              items={answerStyleNames.map((style) => ({
                value: style,
                label: style,
              }))}
            />
          </Field>
        ) : null}
        <p className="generation-caption">
          {generationTracks[value.track].guidance}
        </p>
      </section>
      <details className="generation-rule-section" open>
        <summary>问题标题规则</summary>
        <div className="generation-pair">
          <Field label="标题前缀" hint="每行一个，可留空">
            <textarea
              aria-label="标题前缀"
              rows={3}
              maxLength={2000}
              value={value.prefixes}
              disabled={disabled}
              onChange={(event) => onChange({ prefixes: event.target.value })}
            />
          </Field>
          <Field label="标题后缀" hint="每行一个，可留空">
            <textarea
              aria-label="标题后缀"
              rows={3}
              maxLength={2000}
              value={value.suffixes}
              disabled={disabled}
              onChange={(event) => onChange({ suffixes: event.target.value })}
            />
          </Field>
        </div>
        <p className="generation-caption">
          按资料组合前缀、名称和后缀，自动控制在49字内。默认使用自然问句，避免重复“求、免费、下载”等词。
        </p>
      </details>
      <details className="generation-rule-section" open>
        <summary>回答内容与资料入口</summary>
        <CheckboxField
          checked={value.preferSummary}
          disabled={disabled}
          onChange={(event) =>
            onChange({ preferSummary: event.target.checked })
          }
          label="优先使用资源表中的真实简介"
          hint="有简介时使用简介与赛道建议；缺少简介时使用下方模板。"
        />
        <Field
          label="简介模板"
          hint="支持 {资源名称}、{资源简介}、{SEO关键词}、{使用建议}"
        >
          <textarea
            aria-label="简介模板"
            rows={4}
            value={value.introTemplate}
            maxLength={2000}
            disabled={disabled}
            onChange={(event) =>
              onChange({ introTemplate: event.target.value })
            }
          />
        </Field>
        <div className="generation-pair">
          <Field label="正文长度上限">
            <Select
              value={String(value.maxChars)}
              disabled={disabled}
              onValueChange={(maxChars) =>
                onChange({ maxChars: Number(maxChars) })
              }
              items={[200, 400, 600, 1000, 2000].map((count) => ({
                value: String(count),
                label: `${count}字`,
              }))}
            />
          </Field>
          <Field label="资料入口位置">
            <Select
              value={value.linkPosition}
              disabled={disabled}
              onValueChange={(linkPosition) =>
                onChange({
                  linkPosition: linkPosition as Rules["linkPosition"],
                })
              }
              items={[
                { value: "last", label: "解答之后（推荐）" },
                { value: "first", label: "回答开头" },
              ]}
            />
          </Field>
        </div>
        <CheckboxField
          checked={value.includeImage}
          disabled={disabled}
          onChange={(event) => onChange({ includeImage: event.target.checked })}
          label="包含表格中的图片链接"
          hint="仅在已映射图片列且该行有HTTPS图片时加入，不自动生成或抓取图片。"
        />
      </details>
      <section className="generation-rule-section">
        <h3>关键词提示</h3>
        <div className="generation-keywords">
          {value.keywords.map((keyword) => (
            <span key={keyword}>
              {keyword}
              <Button
                quiet
                size="compact"
                disabled={disabled}
                aria-label={`移除关键词 ${keyword}`}
                onClick={() =>
                  onChange({
                    keywords: value.keywords.filter(
                      (entry) => entry !== keyword,
                    ),
                  })
                }
              >
                <X size={12} />
              </Button>
            </span>
          ))}
        </div>
        <Field
          label="添加关键词"
          as="div"
          hint={`${value.keywords.length}/12个；仅在与资料内容相关时使用`}
        >
          <div className="generation-keyword-input">
            <input
              aria-label="关键词提示"
              placeholder="输入关键词，按回车添加"
              value={word}
              maxLength={40}
              disabled={disabled || value.keywords.length >= 12}
              onChange={(event) => setWord(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  addWord();
                }
              }}
            />
            <Button
              disabled={
                disabled ||
                !word.trim() ||
                value.keywords.length >= 12 ||
                value.keywords.includes(word.trim())
              }
              onClick={addWord}
            >
              添加
            </Button>
          </div>
        </Field>
      </section>
    </>
  );
}
