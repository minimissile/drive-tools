import { useState } from "react";
import { z } from "zod";
import type {
  RuntimeLogEntry,
  RuntimeLogPage,
} from "../../shared/runtime-logs";
import { useAppActions } from "../state";
import { Button, Empty, Panel } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { LogWindow } from "../ui/LogWindow";
import { Dialog } from "../ui/Dialog";
import { formatRuntimeLogs } from "../lib/runtime-log";
import { useLocalDraft } from "../hooks/useLocalDraft";

export function TiebaLogs({
  logs,
  workspace,
  names,
}: {
  logs: RuntimeLogPage;
  workspace: string;
  names: Map<string, string>;
}) {
  const [held, setHeld] = useState<RuntimeLogEntry[] | null>(null),
    [follow, setFollow] = useState(true),
    [full, setFull] = useState(false);
  const filters = useLocalDraft(
    `tieba-autocare-log-view:${workspace}`,
    { onlyIssues: false },
    (value) => z.object({ onlyIssues: z.boolean() }).parse(value),
  );
  const { onlyIssues } = filters.value;
  const { notify } = useAppActions();
  const items = (held ?? logs.items).filter(
    (entry) => !onlyIssues || entry.level !== "info",
  );
  const context = (entry: { accountId: string | null }) =>
    entry.accountId ? (names.get(entry.accountId) ?? "历史账号") : "系统";
  const controls = (
    <div className="row compact">
      <CheckboxField
        label="只看异常"
        checked={onlyIssues}
        onChange={(event) =>
          filters.update({ onlyIssues: event.target.checked })
        }
      />
      <Button
        size="compact"
        onClick={() => {
          setHeld(held ? null : logs.items);
          setFollow(!held ? false : true);
        }}
      >
        {held ? "继续显示" : "暂停显示"}
      </Button>
      <Button
        size="compact"
        onClick={() => {
          setHeld(null);
          setFollow(true);
        }}
      >
        查看最新
      </Button>
      <Button
        size="compact"
        disabled={!items.length}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              formatRuntimeLogs(items, context),
            );
            notify("当前日志已复制", "success");
          } catch {
            notify("无法复制，可选择日志文字手动复制", "error");
          }
        }}
      >
        复制
      </Button>
    </div>
  );
  const body = (
    <div className="tieba-log-body">
      {items.length ? (
        <LogWindow
          items={items}
          simple
          label="贴吧自动养号运行日志"
          context={context}
          follow={follow && !held}
          onFollowChange={setFollow}
        />
      ) : (
        <Empty compact title={onlyIssues ? "当前日志没有异常" : "尚未运行"}>
          同步、签到和结果核对的过程会显示在这里。
        </Empty>
      )}
      <small className="muted">
        {held
          ? "只暂停日志显示，后台任务继续运行。"
          : `显示最近 ${logs.items.length} 条日志。`}
      </small>
    </div>
  );
  return (
    <>
      <Panel
        title="运行日志"
        className="tieba-logs"
        extra={
          <div className="row compact">
            {controls}
            <Button size="compact" onClick={() => setFull(true)}>
              全屏
            </Button>
          </div>
        }
      >
        {full ? <p className="muted">日志正在全屏窗口显示。</p> : body}
      </Panel>
      {full ? (
        <Dialog
          title="贴吧自动养号运行日志"
          size="fullscreen"
          className="tieba-log-dialog"
          onClose={() => setFull(false)}
          footer={controls}
        >
          {body}
        </Dialog>
      ) : null}
    </>
  );
}
