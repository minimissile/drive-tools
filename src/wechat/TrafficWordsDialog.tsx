import { useEffect, useId, useState } from "react";
import { z } from "zod";
import {
  normalizeWechatTrafficWords,
  wechatTrafficWordsInput,
  wechatTrafficWordUsage,
  type WechatTrafficWords,
  type WechatTrafficWordPlan,
} from "../../shared/wechat-traffic-words";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Dialog } from "../ui/Dialog";
import { Button, Field, Notice } from "../ui/primitives";
import "./article-rewrite.css";
import { TrafficWordPriority } from "./TrafficWordPriority";

const schema = z.object({
  text: z.string().max(12000),
  revision: z.number().int().nonnegative(),
  edited: z.boolean().optional(),
});
export function TrafficWordsDialog({
  storageKey,
  saved,
  plan,
  title,
  body,
  onSave,
  onClose,
}: {
  storageKey: string;
  saved: WechatTrafficWords;
  plan: WechatTrafficWordPlan;
  title: string;
  body: string;
  onSave(words: string[], revision: number): Promise<void>;
  onClose(): void;
}) {
  const draft = useLocalDraft(
    storageKey,
    {
      text: saved.words.join("\n"),
      revision: saved.revision,
      edited: false as boolean | undefined,
    },
    (value) => schema.parse(value),
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const hintId = useId();
  const words = normalizeWechatTrafficWords(draft.value.text);
  const usage = wechatTrafficWordUsage(words, title, body);
  const matchesSaved = JSON.stringify(words) === JSON.stringify(saved.words);
  const edited =
    draft.value.edited ?? (draft.value.revision > 0 || words.length > 0);
  const dirty = edited && !matchesSaved;
  const coverage = !dirty ? plan.deliveryCoverage : undefined;
  const conflict = draft.value.revision !== saved.revision && dirty;
  useEffect(() => {
    if (!dirty && (!matchesSaved || draft.value.revision !== saved.revision))
      draft.update({
        text: saved.words.join("\n"),
        revision: saved.revision,
        edited: false,
      });
  }, [dirty, matchesSaved, saved, draft.value.revision, draft.update]);
  const save = async () => {
    const parsed = wechatTrafficWordsInput.safeParse(
      draft.value.text.split(/\r\n?|\n/),
    );
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "请检查流量词。");
      return;
    }
    setPending(true);
    setError("");
    try {
      await onSave(parsed.data, draft.value.revision);
      draft.clear();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "流量词未保存，请重试。",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title="填写流量词"
      className="wechat-traffic-dialog"
      busy={pending}
      onClose={onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button
            primary
            disabled={pending || conflict}
            onClick={() => void save()}
          >
            {pending ? "正在保存…" : "保存流量词"}
          </Button>
        </>
      }
    >
      <p className="wechat-editor-dialog-copy" id={hintId}>
        每行一个词，自动去除首尾空格、空行和重复词。保存后用于这篇文章的 AI
        改写。
      </p>
      {conflict ? (
        <Notice warning>
          其他窗口已更新流量词，当前输入已保留。
          <Button
            quiet
            size="compact"
            onClick={() => {
              draft.update({
                text: saved.words.join("\n"),
                revision: saved.revision,
                edited: false,
              });
              setError("");
            }}
          >
            载入最新流量词
          </Button>
        </Notice>
      ) : error ? (
        <Notice danger>
          <span role="alert">{error}</span>
        </Notice>
      ) : null}
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      <div className="wechat-traffic-layout">
        <Field label="搜索流量词" hint={`${words.length} 个`}>
          <textarea
            className="wechat-traffic-input"
            aria-describedby={hintId}
            disabled={pending}
            maxLength={12000}
            value={draft.value.text}
            onBlur={() =>
              draft.update({
                text: normalizeWechatTrafficWords(draft.value.text).join("\n"),
              })
            }
            onChange={(event) => {
              draft.update({ text: event.target.value, edited: true });
              setError("");
            }}
            placeholder={"例如：\n电子版\n学习资料\n资料整理"}
          />
        </Field>
        <aside className="wechat-traffic-summary" aria-label="流量词使用情况">
          {words.length ? (
            <div className="wechat-traffic-usage">
              <span className="muted">
                本稿标题与正文已用 {usage.used.length}/{words.length} 个词
              </span>
              {usage.used.length ? (
                <details>
                  <summary>已使用（{usage.used.length}）</summary>
                  <p>{usage.used.join("、")}</p>
                </details>
              ) : null}
              {usage.unused.length ? (
                <details>
                  <summary>未使用（{usage.unused.length}）</summary>
                  <p>{usage.unused.join("、")}</p>
                </details>
              ) : null}
            </div>
          ) : null}
          {coverage?.count ? (
            <div className="wechat-traffic-usage">
              <strong>
                同源送稿覆盖 {coverage.coveredWords.length}/{words.length} 个词
              </strong>
              <details>
                <summary>查看 {coverage.count} 次送稿的覆盖</summary>
                <p>
                  已覆盖：{coverage.coveredWords.join("、") || "暂无可确认的词"}
                </p>
                {coverage.incomplete ? (
                  <p className="muted">
                    部分旧送稿的正文已变更，按可确认的内容统计。
                  </p>
                ) : null}
              </details>
            </div>
          ) : null}
          {dirty ? (
            <p className="wechat-editor-dialog-help muted">
              保存词表后更新同源送稿覆盖与下次优先词。
            </p>
          ) : (
            <TrafficWordPriority plan={plan} wordCount={saved.words.length} />
          )}
          <p className="wechat-editor-dialog-help muted">
            标题与正文分开使用相关词，优先覆盖新词，核心词可以重复。
          </p>
        </aside>
      </div>
    </Dialog>
  );
}
