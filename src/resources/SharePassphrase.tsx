import { useRef, useState } from "react";
import { CheckCircle2, Copy, MessageSquareText } from "lucide-react";
import type { SharePassphraseTarget } from "../../shared/share-passphrase";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { Button, Field } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import "./share-passphrase.css";

/** Local persistence/copy only. Never implies that a URL was converted to an App command. */
export function SharePassphrase({ target }: { target: SharePassphraseTarget }) {
  const saved = useIpcQuery("share.passphrase", target);
  const { notify } = useAppActions();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const save = async () => {
    if (lock.current || !text.trim()) return;
    lock.current = true;
    setPending(true);
    try {
      saved.setData(await ipc("share.savePassphrase", { ...target, text }));
      setText("");
      setEditing(false);
      notify("中文分享口令已保存。", "success");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "口令保存失败，请重试。",
        "error",
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const copy = async () => {
    try {
      const result = await ipc("share.copyPassphrase", target);
      await ipc("system.copyText", result);
      notify("中文口令已复制。", "success");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "口令复制失败，请重试。",
        "error",
      );
    }
  };
  return (
    <div className="share-passphrase">
      <div className="share-passphrase-heading">
        <span className={saved.data ? "good-text" : "muted"}>
          {saved.data ? (
            <CheckCircle2 size={14} />
          ) : (
            <MessageSquareText size={14} />
          )}
          中文口令 ·{" "}
          {saved.data ? "已保存" : saved.loading ? "读取中…" : "未获取"}
        </span>
        <div className="row compact">
          <Button
            quiet
            size="compact"
            disabled={!saved.data || !!saved.error}
            onClick={() => void copy()}
          >
            <Copy size={14} />
            复制口令
          </Button>
          <Button
            quiet
            size="compact"
            disabled={pending || !!saved.error}
            onClick={() => setEditing(!editing)}
          >
            {editing ? "收起" : saved.data ? "更新口令" : "保存官方口令"}
          </Button>
        </div>
      </div>
      <QueryError
        error={saved.error}
        loading={saved.loading}
        onRetry={saved.reload}
      />
      {saved.data ? (
        <div className="share-passphrase-value">{saved.data.text}</div>
      ) : null}
      {editing ? (
        <div className="share-passphrase-editor">
          <Field
            label="App 官方分享内容"
            hint="粘贴含中文口令和当前分享链接的完整内容。"
          >
            <textarea
              aria-label="App 官方分享内容"
              value={text}
              maxLength={8000}
              rows={5}
              disabled={pending}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <div className="row compact">
            <Button
              size="compact"
              primary
              disabled={pending || !text.trim()}
              onClick={() => void save()}
            >
              {pending ? "正在保存…" : "保存口令"}
            </Button>
            <span className="muted">保存后可单独复制中文口令。</span>
          </div>
        </div>
      ) : !saved.data && !saved.loading && !saved.error ? (
        <p className="muted">当前需粘贴 App 的完整官方分享内容，保存后可复制口令。</p>
      ) : null}
    </div>
  );
}
