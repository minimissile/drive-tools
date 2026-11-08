import { useState } from "react";
import type { DistributionOverview } from "../../shared/distribution";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import type { DistributionModel } from "./useDistribution";

export function PlatformRules({
  item,
  workspace,
  model,
}: {
  item: DistributionOverview["platforms"][number];
  workspace: string;
  model: DistributionModel;
}) {
  const { platform } = item;
  const [editing, setEditing] = useState(false);
  const draft = useLocalDraft(
    `distribution:platform:v1:${workspace}:${platform.id}`,
    { alias: item.alias, note: item.note },
    (value) => {
      const saved = value as { alias?: unknown; note?: unknown };
      return {
        alias:
          typeof saved?.alias === "string"
            ? saved.alias.slice(0, 100)
            : item.alias,
        note:
          typeof saved?.note === "string"
            ? saved.note.slice(0, 2000)
            : item.note,
      };
    },
  );
  return (
    <Panel className="distribution-rules">
      <h2>投稿须知</h2>
      <p className="muted">{platform.summary}</p>
      <ul>
        {platform.rules.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      <p className="muted">
        提交成功后，平台仍需处理或审核，收录结果以官网为准。
      </p>
      <div className="distribution-session row spread">
        <div>
          <strong>{item.alias || "平台备注"}</strong>
          {item.note && !editing ? (
            <p className="distribution-rule-note">{item.note}</p>
          ) : null}
        </div>
        <Button
          quiet
          size="compact"
          onClick={() => setEditing((value) => !value)}
        >
          {editing
            ? "收起编辑"
            : item.alias || item.note
              ? "编辑备注"
              : "添加备注"}
        </Button>
      </div>
      {editing ? (
        <form
          className="distribution-settings"
          onSubmit={(event) => {
            event.preventDefault();
            void model
              .run(
                () =>
                  ipc("distribution.configure", {
                    platformId: platform.id,
                    ...draft.value,
                  }),
                "平台备注已保存",
              )
              .then((result) => {
                if (result) {
                  draft.clear();
                  setEditing(false);
                }
              });
          }}
        >
          <Field label="备注名称" hint="可填写常用账号昵称或平台用途">
            <input
              value={draft.value.alias}
              maxLength={100}
              onChange={(event) => draft.update({ alias: event.target.value })}
              placeholder="例如：资源分享主账号"
            />
          </Field>
          <Field label="补充说明">
            <textarea
              value={draft.value.note}
              maxLength={2000}
              onChange={(event) => draft.update({ note: event.target.value })}
              placeholder="记录投稿注意事项，请勿填写密码…"
            />
          </Field>
          {draft.error ? <Notice warning>{draft.error}</Notice> : null}
          <div>
            <Button type="submit" disabled={model.busy}>
              保存备注
            </Button>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}
