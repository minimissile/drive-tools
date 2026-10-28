import { useEffect, useRef, useState } from "react";
import type { DriveShareResult } from "../../shared/zhidao";
import { ipc } from "../api/client";
import { useAppActions, useAppNavigation } from "../state";
import { Button, Notice } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";

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
  const [rights, setRights] = useState(false);
  const [result, setResult] = useState<DriveShareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reset, setReset] = useState(false);
  const lock = useRef(false);
  const selectionKey = JSON.stringify(selected);
  useEffect(() => {
    setRights(false);
  }, [selectionKey]);
  const share = async () => {
    if (lock.current) return;
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
      setRights(false);
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
  return (
    <div className="drive-share-controls">
      <label className="check">
        <input
          type="checkbox"
          checked={rights}
          disabled={disabled || busy}
          onChange={(e) => setRights(e.target.checked)}
        />
        我有权分享所选项目，并归档到资源库
      </label>
      <div className="drive-browser-actions">
        <Button
          primary
          disabled={disabled || busy || !rights || !selected.length}
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
              <Button quiet disabled={busy} onClick={() => setReset(true)}>
                已在网盘核对未创建，准备重试
              </Button>
            </Notice>
          ) : null}
        </div>
      ) : null}
      {reset ? (
        <Dialog
          title="确认平台未创建分享"
          busy={busy}
          onClose={() => setReset(false)}
        >
          <Notice warning>
            只有确认未生成分享，才清除未知请求记录。已存在的分享仍需核对，不会重复建链。
          </Notice>
          <div className="dialog-actions">
            <Button onClick={() => setReset(false)} disabled={busy}>
              取消
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                onBusyChange(true);
                setError("");
                try {
                  await ipc("drive.share.reset", {
                    accountId,
                    fileIds: result!.failures.map((f) => f.id),
                    confirmed: true,
                  });
                  if (mounted.current) {
                    setReset(false);
                    setResult(null);
                    setRights(false);
                  }
                } catch (e) {
                  if (mounted.current)
                    setError(e instanceof Error ? e.message : "解除记录失败。");
                } finally {
                  if (mounted.current) {
                    onBusyChange(false);
                    setBusy(false);
                  }
                }
              }}
            >
              确认未创建
            </Button>
          </div>
          {error ? <Notice danger>{error}</Notice> : null}
        </Dialog>
      ) : null}
    </div>
  );
}
