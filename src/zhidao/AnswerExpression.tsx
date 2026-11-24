import {
  answerStyleDetails,
  answerStyleNames,
} from "../../shared/answer-styles";
import {
  zhidaoAnswerLanguage,
  zhidaoAnswerLanguageLabels,
} from "../../shared/zhidao-answer-language";
import type { z } from "zod";
import type { answerDraftSchema } from "./answer-draft";
import { Field } from "../ui/primitives";
import { Select } from "../ui/Select";
import { answerLanguageSample } from "./answer-language-samples";

type Draft = z.infer<typeof answerDraftSchema>;
export function AnswerExpression({
  value,
  update,
}: {
  value: Draft;
  update(patch: Partial<Draft>): void;
}) {
  const detail = answerStyleDetails[value.style];
  return (
    <section
      className="answer-expression"
      aria-labelledby="answer-expression-title"
    >
      <div className="answer-section-heading">
        <h3 id="answer-expression-title">回答表达</h3>
        <p>让回答贴近问题，也贴近提问的人。</p>
      </div>
      <div className="answer-expression-options">
        <Field label="回答风格">
          <Select
            value={value.style}
            onValueChange={(style) =>
              update({ style: style as Draft["style"] })
            }
            items={answerStyleNames.map((style) => ({
              value: style,
              label: style,
            }))}
          />
        </Field>
        <Field label="回答语言">
          <Select
            value={value.language}
            onValueChange={(language) =>
              update({ language: zhidaoAnswerLanguage.parse(language) })
            }
            items={zhidaoAnswerLanguage.options.map((language) => ({
              value: language,
              label: zhidaoAnswerLanguageLabels[language],
            }))}
          />
        </Field>
      </div>
      <div
        className="answer-style-preview"
        aria-live="polite"
        aria-atomic="true"
      >
        <p>{detail.description}</p>
        <blockquote>
          {answerLanguageSample(value.language, value.style)}
        </blockquote>
        <small>
          {zhidaoAnswerLanguageLabels[value.language]}语气示例 ·
          实际回答会结合每道题生成
        </small>
      </div>
      {value.mode === "auto" ? (
        <Field label="补充回答要求（可选）">
          <textarea
            rows={3}
            maxLength={2000}
            value={value.instructions}
            onChange={(e) => update({ instructions: e.target.value })}
            placeholder="例如：先回应对方的感受，用第一人称提出温和、具体的建议。"
          />
        </Field>
      ) : null}
      <p className="answer-expression-note">
        第一人称表达理解和建议，不编造亲身经历。
      </p>
    </section>
  );
}
