import { useLocalDraft } from "../hooks/useLocalDraft";
import type { DistributionTask } from "../../shared/distribution";
import { distributionStatusLabels } from "../../shared/distribution";
import { ipc } from "../api/client";
import { Dialog } from "../ui/Dialog";
import { Button, Field, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import type { DistributionModel } from "./useDistribution";

const outcomes = [
  "submitted",
  "processing",
  "reviewing",
  "published",
  "rejected",
  "failed",
  "skipped",
] as const;
type Outcome = (typeof outcomes)[number];
interface Draft {
  status: Outcome;
  note: string;
  receipt: string;
  url: string;
}
export function ResolveDialog({
  task,
  workspace,
  model,
  onClose,
}: {
  task: DistributionTask;
  workspace: string;
  model: DistributionModel;
  onClose(): void;
}) {
  const draft = useLocalDraft<Draft>(
    `distribution:resolve:v2:${workspace}:${task.id}`,
    { status: "submitted", note: "", receipt: "", url: "" },
    (value) => {
      const saved = value as Partial<Draft>;
      return {
        status:
          saved?.status && outcomes.includes(saved.status)
            ? saved.status
            : "submitted",
        note: typeof saved?.note === "string" ? saved.note.slice(0, 2000) : "",
        receipt:
          typeof saved?.receipt === "string" ? saved.receipt.slice(0, 500) : "",
        url: typeof saved?.url === "string" ? saved.url.slice(0, 2000) : "",
      };
    },
  );
  return (
    <Dialog title="核对平台结果" busy={model.busy} onClose={onClose}>
      <form
        className="distribution-resolve"
        onSubmit={(event) => {
          event.preventDefault();
          void model
            .run(
              () =>
                ipc("distribution.resolve", {
                  taskId: task.id,
                  ...draft.value,
                }),
              "平台结果已保存；刷新失败时重试读取即可。",
            )
            .then((result) => {
              if (result) {
                draft.clear();
                onClose();
              }
            });
        }}
      >
        <p>{task.title}</p>
        <Notice>
          请先在官网查询本条链接的实际结果。结果未知时不会自动重投；确认未提交或被拒绝后，可登记失败，再重试明确失败项。
        </Notice>
        <Field label="官网阶段">
          <Select
            value={draft.value.status}
            items={outcomes.map((status) => ({
              value: status,
              label: distributionStatusLabels[status],
            }))}
            onValueChange={(status) =>
              draft.update({ status: status as Outcome })
            }
          />
        </Field>
        <Field label="核对说明" required>
          <textarea
            required
            maxLength={2000}
            value={draft.value.note}
            onChange={(event) => draft.update({ note: event.target.value })}
            placeholder="填写官网查询结果或失败原因…"
          />
        </Field>
        <Field label="官网任务号 / 回执" hint="可选">
          <input
            maxLength={500}
            value={draft.value.receipt}
            onChange={(event) => draft.update({ receipt: event.target.value })}
          />
        </Field>
        <Field label="官网结果链接" hint="可选">
          <input
            type="url"
            maxLength={2000}
            value={draft.value.url}
            onChange={(event) => draft.update({ url: event.target.value })}
          />
        </Field>
        {draft.error ? <Notice warning>{draft.error}</Notice> : null}
        <Button
          type="submit"
          primary
          disabled={model.busy || !draft.value.note.trim()}
        >
          保存核对结果
        </Button>
      </form>
    </Dialog>
  );
}
