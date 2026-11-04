import { useEffect, useRef, useState } from "react";
import type {
  ZhihuParticipationKind,
  ZhihuParticipationStatus,
  ZhihuResearchKind,
} from "../../shared/zhihu-participation";
import { useAppActions } from "../state";

export const participationKindLabels: Record<ZhihuParticipationKind, string> = {
  read: "阅读",
  answer: "回答",
  comment: "评论",
  like: "点赞",
  follow: "关注作者",
};
export const researchKindLabels: Record<ZhihuResearchKind, string> = {
  question: "问题",
  answer: "回答",
  article: "文章",
  author: "作者",
};
export const participationStatusLabels: Record<
  ZhihuParticipationStatus,
  string
> = {
  planned: "已计划",
  needs_review: "待本人审阅",
  prepared: "已交付回答稿",
  done: "本人记录已处理",
  skipped: "本人记录不采用",
  executing: "执行中",
  queued: "已安排 · 待执行",
  succeeded: "官方状态已确认",
  attention: "需处理 · 待核对",
  failed: "执行失败",
};
export function participationStatusKind(
  status: ZhihuParticipationStatus,
): "normal" | "good" | "warning" | "danger" {
  if (status === "succeeded") return "good";
  if (status === "failed") return "danger";
  if (status === "attention" || status === "needs_review") return "warning";
  return "normal";
}
export type ParticipationAction = <T>(
  action: () => Promise<T>,
  message:
    | string
    | ((
        result: T,
      ) =>
        | string
        | { message: string; kind: "success" | "warning" | "info" | "error" }),
  onError?: (message: string) => void,
) => Promise<{ ok: true; value: T } | { ok: false }>;

export function useParticipationAction(reload: () => void) {
  const { notify } = useAppActions();
  const lock = useRef(false),
    mounted = useRef(true);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run: ParticipationAction = async (action, message, onError) => {
    if (lock.current) return { ok: false };
    lock.current = true;
    setPending(true);
    setError("");
    try {
      const value = await action();
      const feedback = typeof message === "function" ? message(value) : message;
      notify(
        typeof feedback === "string" ? feedback : feedback.message,
        typeof feedback === "string" ? "success" : feedback.kind,
      );
      reload();
      return { ok: true, value };
    } catch (cause) {
      const failure =
        cause instanceof Error ? cause.message : "本次操作未完成，请重试。";
      if (mounted.current) {
        if (onError) onError(failure);
        else setError(failure);
      }
      return { ok: false };
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return { pending, error, run };
}

export function participationTime(value: string) {
  return value ? new Date(`${value}+08:00`).toISOString() : null;
}
