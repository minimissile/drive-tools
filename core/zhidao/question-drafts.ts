import type { OperationsStore } from "./store";
import { questionFingerprint } from "./answer-history";
import {
  zhidaoQuestionIssue,
  zhidaoAnswerIssue,
} from "../../shared/zhidao-content";
import type { QuestionDraftInsertResult } from "../../shared/zhidao-publishing";
import { randomInt } from "node:crypto";
import { safeHtmlAnswer } from "./parsers";
import { parseShare } from "../links";
import { AppError } from "../errors";

function shuffled<T>(entries: T[]): T[] {
  const values = [...entries];
  for (let index = values.length - 1; index > 0; index--) {
    const next = randomInt(index + 1);
    [values[index], values[next]] = [values[next], values[index]];
  }
  return values;
}

/** Local question rows join the existing edit, review and upload workflow. No model or platform calls. */
export function insertQuestionDrafts(
  store: OperationsStore,
  source: {
    id: string;
    name: string;
    questions: { key: string; title: string; sourceUrl: string }[];
    links: string;
    materials: string[];
  },
): QuestionDraftInsertResult {
  const linkLines = source.links
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!linkLines.length || linkLines.length > 100)
    throw new AppError(
      "QUESTION_LINKS",
      "请填写1–100条百度网盘链接，每行一条，可带提取码。",
    );
  const links = shuffled(
    linkLines.map((line, index) => {
      const link = parseShare(line);
      if (link.provider !== "baidu")
        throw new AppError(
          "QUESTION_LINKS",
          `第${index + 1}行需使用百度网盘分享链接。`,
        );
      if (link.code && !/^[a-z\d]{4}$/i.test(link.code))
        throw new AppError(
          "QUESTION_LINKS",
          `第${index + 1}行的百度网盘提取码需为4位字母或数字。`,
        );
      return link;
    }),
  );
  const materials = shuffled(
    source.materials.map((material) => material.trim()),
  );
  if (
    !materials.length ||
    materials.some((material) => !!zhidaoAnswerIssue(material))
  )
    throw new AppError(
      "QUESTION_MATERIALS",
      "请填写有具体内容的资料文案，不能只有链接或提取码。",
    );
  return store.db.transaction(() => {
    const existing = store.db.all<{ question: string; key: string }>(
      "SELECT json_extract(i.data,'$.question') question,i.item_key key FROM operation_items i JOIN operation_runs r ON r.id=i.run_id WHERE r.kind IN ('template','answer','publish') AND i.status!='skipped'",
    );
    const titles = new Set(
      existing.map((row) => questionFingerprint(row.question || "")),
    );
    const sourceKeys = new Set(existing.map((row) => row.key));
    const questions = source.questions.filter((question) => {
      const key = `question-import:${source.id}:${question.key}`;
      const title = questionFingerprint(question.title);
      if (sourceKeys.has(key) || titles.has(title)) return false;
      sourceKeys.add(key);
      titles.add(title);
      return true;
    });
    if (!questions.length)
      return {
        added: 0,
        duplicates: source.questions.length,
        titleIssues: 0,
        runId: null,
      };
    const run = store.create(
      "template",
      `${source.name} · 待审核问答`,
      { sourceKind: "question-import", sourceId: source.id },
      questions.length,
    );
    for (const [index, question] of questions.entries()) {
      const link = links[index % links.length],
        material = materials[index % materials.length];
      store.put(run.id, `question-import:${source.id}:${question.key}`, {
        name: question.title,
        question: question.title,
        answer: safeHtmlAnswer(material, link.url, link.code),
        link: link.url,
        code: link.code,
        sourceUrl: question.sourceUrl,
        sourceName: source.name,
        status: "ready",
        reviewed: false,
        message: "已随机分配资料文案与网盘链接，请核对是否切题后审核。",
      });
    }
    store.state(
      run.id,
      "completed",
      `已插入${questions.length}条问答，资料文案与网盘链接已分配，请逐条审核后上传。`,
      questions.length,
    );
    return {
      added: questions.length,
      duplicates: source.questions.length - questions.length,
      titleIssues: questions.filter(
        (question) => !!zhidaoQuestionIssue(question.title),
      ).length,
      runId: run.id,
    };
  });
}
