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
    { text: saved.words.join("\n"), revision: saved.revision },
    (value) => schema.parse(value),
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const hintId = useId();
  const words = normalizeWechatTrafficWords(draft.value.text);
  const usage = wechatTrafficWordUsage(words, title, body);
  const dirty = JSON.stringify(words) !== JSON.stringify(saved.words);
  const conflict = draft.value.revision !== saved.revision && dirty;
  useEffect(() => {
    if (!dirty && draft.value.revision !== saved.revision)
      draft.update({ text: saved.words.join("\n"), revision: saved.revision });
  }, [dirty, saved, draft.value.revision, draft.update]);
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
        每行一个词，自动去掉空行和重复词。保存后用于这篇文章的 AI 改写。
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
      <Field label="搜索流量词" hint={`${words.length} 个`}>
        <textarea
          className="wechat-traffic-input"
          aria-describedby={hintId}
          disabled={pending}
          maxLength={12000}
          value={draft.value.text}
          onChange={(event) => {
            draft.update({ text: event.target.value });
            setError("");
          }}
          placeholder={"例如：\n电子版\n学习资料\n资料整理"}
        />
      </Field>
      {words.length ? (
        <div className="wechat-traffic-usage">
          <span className="muted">
            当前标题与正文已含 {usage.used.length}/{words.length} 个词
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
      {dirty ? (
        <p className="wechat-editor-dialog-help muted">
          保存词表后，会按同一原文的历史改写记录更新优先词。
        </p>
      ) : (
        <TrafficWordPriority plan={plan} wordCount={saved.words.length} />
      )}
      <p className="wechat-editor-dialog-help muted">
        标题优先选择最相关的 1–2 个词，正文自然融入其余相关词，不强行堆砌。
      </p>
    </Dialog>
  );
}
