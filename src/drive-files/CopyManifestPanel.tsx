import { useRef, useState } from "react";
import type { RemoteFile, ResourceCopy } from "../../shared/types";
import { ipc } from "../api/client";
import { useAppActions, useAppNavigation } from "../state";
import { Button, Notice } from "../ui/primitives";

export function CopyManifestPanel({
  copy,
  path,
  files,
  disabled,
  mounted,
  onBusyChange,
}: {
  copy: ResourceCopy;
  path: string;
  files: RemoteFile[];
  disabled: boolean;
  mounted: { current: boolean };
  onBusyChange(value: boolean): void;
}) {
  const { refresh, notify } = useAppActions();
  const { navigate } = useAppNavigation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const submit = async () => {
    if (lock.current || disabled || !files.length) return;
    lock.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      await ipc("drive.adoptCopy", {
        copyId: copy.id,
        accountId: copy.accountId,
        path,
        files,
        confirmed: true,
      });
      if (!mounted.current) return;
      notify("已更新资源清单，请回资源库核验或重新创建本人分享。", "success");
      await refresh().catch(() => {
        if (mounted.current)
          notify("清单已更新，本地列表刷新失败，无需重复提交。", "warning");
      });
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "清单核验失败。");
    } finally {
      lock.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  };
  return (
    <section className="drive-copy-manifest" aria-label="更新当前资源清单">
      <h3>更新当前资源清单</h3>
      <p>
        此目录关联当前资源。勾选需要保留的项目后更新清单，所选项目会替换原清单，原分享与内容草稿需要重新核验和审阅。
      </p>
      {!copy.verifiedAt ? (
        <Notice warning>网盘内容已变更，旧清单与分享核验已失效。</Notice>
      ) : null}
      <div className="drive-browser-actions">
        <Button
          disabled={disabled || busy || !files.length}
          onClick={() => void submit()}
        >
          {busy
            ? "正在更新资源清单…"
            : `采用所选 ${files.length} 项更新资源清单`}
        </Button>
        <Button quiet disabled={busy} onClick={() => navigate("library")}>
          回资源库处理分享
        </Button>
      </div>
      {error ? <Notice danger>{error}</Notice> : null}
    </section>
  );
}
