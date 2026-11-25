import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Copy, MessageSquareText, RefreshCw } from "lucide-react";
import type { SharePassphraseTarget } from "../../shared/share-passphrase";
import type { Provider } from "../../shared/types";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { Button, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import "./share-passphrase.css";

/** Creation saves the command; displaying and copying it are entirely local. */
export function SharePassphrase({
  target,
  provider,
}: {
  target: SharePassphraseTarget;
  provider: Provider;
}) {
  const saved = useIpcQuery("share.passphrase", target);
  const { notify } = useAppActions();
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const inFlight = useRef(false),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const hasPhrase = !!saved.data?.text;
  const fetchPhrase = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFetching(true);
    setFetchError("");
    try {
      const value = await ipc("share.fetchPassphrase", target);
      if (!active.current) return;
      saved.setData(value);
      notify("中文口令已获取并保存。", "success");
    } catch (error) {
      if (active.current)
        setFetchError(
          error instanceof Error ? error.message : "获取口令失败，请重试。",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setFetching(false);
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
        <span className={hasPhrase ? "good-text" : "muted"}>
          {hasPhrase ? (
            <CheckCircle2 size={14} />
          ) : (
            <MessageSquareText size={14} />
          )}
          中文口令 ·{" "}
          {hasPhrase
            ? "已保存"
            : fetching
              ? "获取中…"
              : saved.loading
                ? "读取中…"
                : "未获取"}
        </span>
        <div className="row compact">
          {provider === "quark" && !hasPhrase ? (
            <Button
              quiet
              size="compact"
              disabled={fetching || saved.loading || !!saved.error}
              onClick={() => void fetchPhrase()}
            >
              <RefreshCw size={14} className={fetching ? "spin" : undefined} />
              {fetching
                ? "正在获取…"
                : saved.data?.issue || fetchError
                  ? "重试获取"
                  : "获取口令"}
            </Button>
          ) : null}
          <Button
            quiet
            size="compact"
            disabled={!hasPhrase || !!saved.error}
            onClick={() => void copy()}
          >
            <Copy size={14} />
            复制口令
          </Button>
        </div>
      </div>
      <QueryError
        error={saved.error}
        loading={saved.loading}
        onRetry={saved.reload}
      />
      {!saved.error && (fetchError || (!hasPhrase && saved.data?.issue)) ? (
        <Notice warning>{fetchError || saved.data?.issue}</Notice>
      ) : null}
      {hasPhrase ? (
        <div className="share-passphrase-value">{saved.data!.text}</div>
      ) : !saved.loading &&
        !saved.error &&
        !fetchError &&
        !saved.data?.issue ? (
        <p className="muted">
          {provider === "baidu"
            ? "此分享尚未记录中文口令。新建分享时会自动获取并保存。"
            : "新建分享时自动获取口令；已有分享可点击获取。需安装支持此功能的夸克官方桌面客户端。"}
        </p>
      ) : null}
    </div>
  );
}
