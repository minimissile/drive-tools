import { useState } from "react";
import type { BitProfileCommand } from "../../shared/bitbrowser";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { Button, Field, LoadingState } from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";

export function BitBrowserPageControls({
  command,
  disabled,
  revision,
}: {
  command: BitProfileCommand;
  disabled: boolean;
  revision: string;
}) {
  const query = useIpcQuery("bit.pages", command, {
    keepPrevious: true,
    revision,
  });
  const { notify } = useAppActions();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const perform = async (minutes?: number) => {
    if (pending) return;
    setPending(true);
    setFailure("");
    try {
      if (minutes !== undefined) {
        await ipc("bit.idlePolicy", {
          ...command,
          idleMinutes: minutes as 0 | 10 | 30 | 60,
        });
      } else {
        const result = await ipc("bit.cleanPages", command);
        notify(
          result.closed
            ? `已清理 ${result.closed} 个临时页面。`
            : "没有可安全关闭的临时页面，已保留其他页面。",
          "info",
        );
      }
      query.reload();
    } catch (cause) {
      setFailure(
        cause instanceof Error ? cause.message : "操作未完成，请重试。",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="bit-page-controls" aria-label="页面保留与清理">
      <div className="row spread">
        <h3>页面保留与清理</h3>
        <Button
          quiet
          size="compact"
          disabled={pending || query.loading}
          onClick={query.reload}
        >
          刷新页面状态
        </Button>
      </div>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
        title="页面状态暂不可读；若后端有更新，请先应用更新"
      />
      {!query.data && !query.error ? (
        <LoadingState compact label="正在读取页面状态…" />
      ) : null}
      {query.data ? (
        <>
          <p className="muted">
            重复打开会优先复用已有页面。编辑页、填写过内容的页面，以及手动打开的窗口均保留。
          </p>
          <div className="bit-page-control-actions">
            <p>
              {query.data.connected
                ? `${query.data.temporary} 个空闲临时页 · ${query.data.protected} 个保留页`
                : query.data.busy
                  ? "窗口任务进行中，稍后刷新页面状态"
                  : "尚无本次运行可管理的页面，历史页面均保留"}
            </p>
            <Button
              size="compact"
              disabled={
                disabled ||
                pending ||
                query.loading ||
                !query.data.connected ||
                !query.data.temporary ||
                query.data.busy
              }
              onClick={() => void perform()}
            >
              {pending ? "处理中…" : "清理临时页面"}
            </Button>
            <Field label="自动关闭空闲窗口">
              <Select
                aria-label="自动关闭空闲窗口"
                value={String(query.data.idleMinutes)}
                disabled={disabled || pending || query.loading}
                onValueChange={(value) => void perform(Number(value))}
                items={[
                  { value: "0", label: "不自动关闭" },
                  { value: "10", label: "空闲 10 分钟" },
                  { value: "30", label: "空闲 30 分钟" },
                  { value: "60", label: "空闲 60 分钟" },
                ]}
              />
            </Field>
          </div>
          <p className="muted">
            {query.data.owner === "panxu"
              ? "仅关闭盘序自动启动、没有任务和保留页面的窗口。"
              : "此窗口由你打开或已保留，自动关闭设置仅适用于之后由盘序自动启动的窗口。"}{" "}
            最后一个标签页会保留，避免清理时关闭整个窗口。
          </p>
        </>
      ) : null}
      {failure ? (
        <p role="alert" className="danger-text">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
