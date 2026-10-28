import { useRef, useState } from "react";
import type { DriveShareResult } from "../../shared/zhidao";
import { ipc } from "../api/client";
import { useAppActions, useAppNavigation } from "../state";
import { Button, Notice } from "../ui/primitives";

export function DriveSharePanel({
  accountId,
  path,
  selected,
  disabled,
  mounted,
  onBusyChange,
}: {
  accountId: string;
  path: string;
  selected: string[];
  disabled: boolean;
  mounted: { current: boolean };
  onBusyChange(value: boolean): void;
}) {
  const { notify, refresh } = useAppActions();
  const { navigate } = useAppNavigation();
  const [result, setResult] = useState<DriveShareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const share = async () => {
    if (lock.current || disabled || !selected.length) return;
    lock.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const next = await ipc("drive.files.share", {
        accountId,
        path,
        fileIds: selected,
        rightsConfirmed: true,
      });
      if (!mounted.current) return;
      setResult(next);
      notify(
        `已核验归档 ${next.urls.length} 个分享${next.failures.length ? `，${next.failures.length} 项待处理` : ""}。`,
        next.failures.length ? "warning" : "success",
      );
      await refresh().catch(() => {
        if (mounted.current)
          notify("分享已完成，本地列表刷新失败，请稍后刷新。", "warning");
      });
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "分享失败，请核对结果。");
    } finally {
      lock.current = false;
      if (mounted.current) {
        onBusyChange(false);
        setBusy(false);
      }
    }
  };
  const resetUncreated = async () => {
    if (lock.current || disabled || !result?.failures.length) return;
    lock.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      await ipc("drive.share.reset", {
        accountId,
        fileIds: result.failures.map((file) => file.id),
        confirmed: true,
      });
      if (mounted.current) {
        setResult(null);
        notify("已解除待处理分享记录，可重新选择文件后分享。", "success");
      }
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "解除记录失败。");
    } finally {
      lock.current = false;
      if (mounted.current) {
        onBusyChange(false);
        setBusy(false);
      }
    }
  };
  return (
    <div className="drive-share-controls">
      <p>分别分享所选项目并归档到资源库，请确保有权分享这些文件。</p>
      <div className="drive-browser-actions">
        <Button
          primary
          disabled={disabled || busy || !selected.length}
          onClick={() => void share()}
        >
          {busy ? "正在分享与核验…" : "分别分享并归档"}
        </Button>
        <Button quiet onClick={() => navigate("zhidao-templates")}>
          去生成问答模板
        </Button>
      </div>
      {error ? <Notice danger>{error}</Notice> : null}
      {result ? (
        <div className="drive-share-results">
          {result.urls.map((url) => (
            <div key={url} className="drive-share-result-url">
              已归档：{url}
            </div>
          ))}
          {result.failures.length ? (
            <Notice warning>
              {result.failures.map((f) => (
                <p key={f.id}>
                  {f.name}：{f.message}
                </p>
              ))}
              <p>
                在网盘确认未创建分享后，可解除待处理记录；再次分享由你手动发起。
              </p>
              <Button
                quiet
                disabled={disabled || busy}
                onClick={() => void resetUncreated()}
              >
                已核对未创建，解除待处理记录
              </Button>
            </Notice>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
