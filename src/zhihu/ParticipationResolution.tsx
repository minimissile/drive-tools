import { useState } from "react";
import { z } from "zod";
import type { ZhihuParticipationActivity } from "../../shared/zhihu-participation";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { windowStorage } from "../storage/window-storage";
import { Button, Field, Notice } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { CheckboxField } from "../ui/CheckboxField";
import type { ParticipationAction } from "./participation-state";

const noteSchema = z.object({ note: z.string().max(2000).default("") });
export function ParticipationResolution({
  activity,
  outcome,
  scope,
  busy,
  run,
  close,
  onResolved,
}: {
  activity: ZhihuParticipationActivity;
  outcome: "done" | "skipped";
  scope: string;
  busy: boolean;
  run: ParticipationAction;
  close(): void;
  onResolved(activity: ZhihuParticipationActivity): void;
}) {
  const draftKey = `panxu-zhihu-participation-resolution-v1:${scope}:${activity.id}:${outcome}`;
  const editor = useLocalDraft(draftKey, noteSchema.parse({}), (value) =>
    noteSchema.parse(value),
  );
  const [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState("");
  const [version] = useState(activity.version);
  const stale = version !== activity.version;
  const saveRecord = () => {
    let submittedStorage: string | null | undefined;
    try {
      submittedStorage = windowStorage.getItem(draftKey);
    } catch {
      /* Local record persistence remains authoritative. */
    }
    void run(
      () =>
        ipc("zhihu.participation.resolve", {
          id: activity.id,
          version,
          outcome,
          note: editor.value.note,
          confirmed: true,
        }),
      "本人处理记录已保存，标注为本人记录而非官方回执",
      setError,
    ).then((result) => {
      setConfirmed(false);
      if (!result.ok) return;
      try {
        if (
          submittedStorage !== undefined &&
          windowStorage.getItem(draftKey) === submittedStorage
        )
          windowStorage.removeItem(draftKey);
      } catch {
        /* Keep the committed business result. */
      }
      onResolved(result.value);
      close();
    });
  };
  return (
    <Dialog
      title={outcome === "done" ? "记录本人已处理" : "记录本人不采用"}
      onClose={close}
      busy={busy}
      footer={
        <>
          <Button size="compact" disabled={busy} onClick={close}>
            返回
          </Button>
          <Button
            primary
            size="compact"
            disabled={
              busy || stale || !confirmed || editor.value.note.trim().length < 5
            }
            onClick={saveRecord}
          >
            保存本人记录
          </Button>
        </>
      }
    >
      <div className="participation-dialog">
        {error ? (
          <div role="alert">
            <Notice danger>{error}</Notice>
          </div>
        ) : null}
        {stale ? (
          <Notice warning>
            任务版本已经变化，请返回核对当前记录后重新登记。
          </Notice>
        ) : null}
        <Notice>
          这是你对实际处理情况的本人记录。系统没有据此证明已阅读、已点赞、已评论或已关注，不会补做任何远端互动。
        </Notice>
        <Field
          label={
            outcome === "done"
              ? "实际处理说明（至少5字）"
              : "不采用原因（至少5字）"
          }
        >
          <textarea
            value={editor.value.note}
            maxLength={2000}
            placeholder="记录实际处理内容及必要说明"
            onChange={(e) => editor.update({ note: e.target.value })}
          />
        </Field>
        {editor.error ? <Notice warning>{editor.error}</Notice> : null}
        <CheckboxField
          checked={confirmed}
          disabled={busy || stale}
          onChange={(e) => setConfirmed(e.target.checked)}
          label={
            outcome === "done"
              ? "我确认已经实际处理，此处仅保存本人记录"
              : "我确认不采用本项任务，并保留原因"
          }
        />
      </div>
    </Dialog>
  );
}
