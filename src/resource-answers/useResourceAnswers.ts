import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions, useAppData } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import {
  answerStyles,
  type ResourceAnswer,
} from "../../shared/resource-answers";
const formSchema = z.object({
  question: z.string().max(4000),
  resources: z.array(z.object({ id: z.string(), title: z.string() })).max(10),
  style: z.enum(answerStyles),
  format: z.enum(["text", "mixed", "image"]),
  instruction: z.string().max(4000),
  selectedId: z.string(),
});
export function useResourceAnswers() {
  const { data } = useAppData();
  const { notify } = useAppActions();
  const form = useLocalDraft(
    `panxu-resource-answers:${data!.dataPath}`,
    {
      question: "",
      resources: [] as { id: string; title: string }[],
      style: "清晰实用" as const,
      format: "text" as const,
      instruction: "",
      selectedId: "",
    },
    (v) => formSchema.parse(v),
  );
  const history = useIpcQuery("resourceAnswers.list", undefined, {
    keepPrevious: true,
    refreshInterval: 4000,
  });
  const [query, setQuery] = useState("");
  const resources = useIpcQuery(
    "resource.page",
    { query, page: 1, pageSize: 50 },
    { delay: 200, keepPrevious: true },
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [freshRun, setFreshRun] = useState<ResourceAnswer | null>(null);
  const current =
    history.data?.find((r) => r.id === form.value.selectedId) ??
    (freshRun?.id === form.value.selectedId ? freshRun : undefined);
  const inputHint = !form.value.question.trim()
    ? "先写下问题，再选择用于回答的资源。"
    : !form.value.resources.length
      ? "至少选择一份参考资源后，即可生成内容。"
      : history.error
        ? "请先重试读取历史版本，确认已有结果后再生成。"
        : !history.data && history.loading
          ? "正在读取已保存版本，请稍候。"
          : "每次生成都会保存为独立版本。";
  const canGenerate =
    !!form.value.question.trim() &&
    form.value.resources.length > 0 &&
    !history.error &&
    !!history.data &&
    !pending;
  const pick = (run: ResourceAnswer) => {
    setError("");
    form.update({
      question: run.input.question,
      resources: run.resources,
      style: run.input.style,
      format: run.input.format,
      instruction: "",
      selectedId: run.id,
    });
  };
  const generate = async (calibrate: boolean) => {
    if (lock.current || !canGenerate) return;
    const previous = calibrate ? current : null;
    if (calibrate && (!previous || !form.value.instruction.trim())) return;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      const result = await ipc("resourceAnswers.generate", {
        requestId: crypto.randomUUID(),
        question: form.value.question,
        resourceIds: form.value.resources.map((r) => r.id),
        style: form.value.style,
        format: form.value.format,
        instruction: calibrate ? form.value.instruction : "",
        previousId: previous?.id ?? null,
      });
      if (!mounted.current) return;
      setFreshRun(result);
      form.update({ selectedId: result.id, instruction: "" });
      history.reload();
      notify(
        result.draftId
          ? "内容版本已保存；图片可在画面方案确认后单独生成。"
          : "文字内容已保存，可直接复制或补充说明继续校准。",
        "success",
      );
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "生成失败，需求与原版本已保留。",
        );
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return {
    form,
    history,
    current,
    pick,
    generate,
    pending,
    error,
    query,
    setQuery,
    resources,
    canGenerate,
    inputHint,
  };
}
export type ResourceAnswersModel = ReturnType<typeof useResourceAnswers>;
