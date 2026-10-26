import test from "node:test";
import assert from "node:assert/strict";
import { answerStyleNames } from "../shared/answer-styles";
import { answerInput } from "../shared/zhidao";
import {
  answerDraftSchema,
  defaultAnswerDraft,
} from "../src/zhidao/answer-draft";
import { answerInstruction } from "../core/zhidao/answer-prompt";
import { questionFingerprint } from "../core/zhidao/answer-history";

test("新增情感风格可提交和恢复，旧风格草稿保持兼容", () => {
  for (const style of answerStyleNames) {
    assert.equal(
      answerInput.parse({
        mode: "manual",
        question: "感情遇到困惑怎么办？",
        style,
      }).style,
      style,
    );
    assert.equal(
      answerDraftSchema.parse({ ...defaultAnswerDraft, style }).style,
      style,
    );
  }
  assert.equal(answerDraftSchema.parse(defaultAnswerDraft).style, "清晰实用");
});
test("情感提示先共情、自然表达，第一人称只表达观点而不编造经历", () => {
  const firstPerson = answerInstruction("第一人称共鸣", {
    category: "emotion",
  });
  assert.match(firstPerson, /先回应提问者具体/);
  assert.match(firstPerson, /优先使用第一人称/);
  assert.match(firstPerson, /我的理解是/);
  assert.match(firstPerson, /不能声称.*我也经历过/);
  assert.match(firstPerson, /不替当事人断言/);
  assert.match(firstPerson, /evidence.requirements/);
  assert.match(
    answerInstruction("清晰实用", { category: "emotion" }),
    /不强行编号/,
  );
  assert.match(answerInstruction("步骤详解", {}), /第一段直接回答/);
  assert.doesNotMatch(answerInstruction("步骤详解", {}), /这是情感交流/);
});
test("历史题目指纹消除空白、标点、全角差异但保留有意义的符号", () => {
  assert.equal(
    questionFingerprint(" 如何 沟通？ "),
    questionFingerprint("如何沟通?"),
  );
  assert.equal(questionFingerprint("ＡＢＣ？"), questionFingerprint("abc"));
  assert.notEqual(
    questionFingerprint("C++怎么学"),
    questionFingerprint("C怎么学"),
  );
});
