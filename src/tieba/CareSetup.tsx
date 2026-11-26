import type { TiebaAutocareSnapshot } from "../../shared/tieba-autocare";
import {
  tiebaCareActionLabels,
  type TiebaCareAction,
} from "../../shared/tieba-actions";
import { updateSelection } from "../lib/selection";
import { Button, Panel, Status } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { tiebaAccountName } from "./account-label";
import { tiebaTime } from "./view-model";

export function TiebaCareSetup({
  snapshot: s,
  selected,
  actions,
  busy,
  stale,
  onSelection,
  onActions,
  onApply,
  onStop,
  onManage,
  onSync,
  onAccounts,
}: {
  snapshot: TiebaAutocareSnapshot;
  selected: string[];
  actions: TiebaCareAction[];
  busy: boolean;
  stale: boolean;
  onSelection(ids: string[]): void;
  onActions(actions: TiebaCareAction[]): void;
  onApply(): void;
  onStop(): void;
  onManage(): void;
  onSync(): void;
  onAccounts(): void;
}) {
  const selectedAccounts = s.accounts.filter((a) =>
    s.targets.some((t) => t.accountId === a.id && selected.includes(t.id)),
  );
  return (
    <Panel
      className="tieba-care-setup"
      title="自动化设置"
      extra={
        <Button quiet size="compact" onClick={onAccounts}>
          管理账号
        </Button>
      }
    >
      <fieldset className="tieba-care-fieldset">
        <legend>使用账号</legend>
        <div className="tieba-care-accounts">
          {s.accounts.map((account) => {
            const targets = s.targets.filter(
              (t) =>
                t.accountId === account.id &&
                t.uid === account.uid &&
                t.source !== "observed",
            );
            const ids = targets.map((t) => t.id);
            const count = ids.filter((id) => selected.includes(id)).length;
            return (
              <div key={account.id} className="tieba-care-account">
                <CheckboxField
                  label={tiebaAccountName(account)}
                  aria-label={`参与养号 ${tiebaAccountName(account)}`}
                  checked={count > 0}
                  disabled={busy || !ids.length}
                  onChange={(event) =>
                    onSelection(
                      updateSelection(selected, ids, event.target.checked, 300),
                    )
                  }
                />
                <small>
                  {ids.length
                    ? `${count} / ${ids.length} 个吧`
                    : "同步关注吧后可选"}
                </small>
              </div>
            );
          })}
          {!s.accounts.length ? (
            <span className="muted">先连接贴吧账号，再同步关注吧。</span>
          ) : null}
        </div>
        <div className="tieba-care-scope">
          <span>
            已选 {selectedAccounts.length} 个账号 · {selected.length} 个贴吧
          </span>
          <Button
            quiet
            size="compact"
            disabled={busy || !s.accounts.length}
            onClick={onManage}
          >
            管理贴吧
          </Button>
          <Button
            quiet
            size="compact"
            disabled={busy || !s.accounts.length}
            onClick={onSync}
          >
            同步账号与贴吧
          </Button>
        </div>
      </fieldset>
      <fieldset className="tieba-care-fieldset">
        <legend>自动化操作</legend>
        <div className="tieba-care-actions">
          {(["checkin", "like"] as const).map((value) => (
            <div key={value} className="tieba-care-action">
              <CheckboxField
                label={tiebaCareActionLabels[value]}
                aria-label={`自动化操作 ${tiebaCareActionLabels[value]}`}
                checked={actions.includes(value)}
                disabled={
                  busy ||
                  (value === "like" && !s.availableActions?.includes("like"))
                }
                onChange={(event) =>
                  onActions(
                    updateSelection(actions, [value], event.target.checked),
                  )
                }
              />
              <small>
                {value === "checkin"
                  ? "每个贴吧每天一次"
                  : s.availableActions?.includes("like")
                    ? "每账号每天一篇；跳过本人和已赞帖子"
                    : "应用顶部更新后可选"}
              </small>
            </div>
          ))}
        </div>
      </fieldset>
      <div className="tieba-care-footer">
        <div className="tieba-care-state">
          <Status kind={s.enabled ? "normal" : "warning"}>
            {s.busy ? "执行中" : s.enabled ? "已开启" : "已停止"}
          </Status>
          <span>{s.message}</span>
          <small>
            30分钟一轮 · 不同账号并行
            {s.run ? ` · 截止 ${tiebaTime(s.run.deadlineAt)}` : ""}
          </small>
        </div>
        <div className="row">
          <Button
            primary
            disabled={
              busy ||
              stale ||
              !selected.length ||
              !actions.length ||
              !s.availableActions
            }
            onClick={onApply}
            data-testid="tieba-care-apply"
          >
            {s.availableActions ? "保存并开启" : "应用更新后可开启"}
          </Button>
          <Button
            disabled={busy || !s.enabled}
            onClick={onStop}
            data-testid="tieba-care-stop"
          >
            停止
          </Button>
        </div>
      </div>
    </Panel>
  );
}
