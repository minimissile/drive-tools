import type {
  AutocareConfig,
  AutocareSnapshot,
} from "../../shared/zhihu-autocare";
import { Field } from "../ui/primitives";
import { Switch } from "../ui/Switch";

export function AutocareAccountTargets({
  config,
  update,
  accounts,
  disabled = false,
}: {
  config: AutocareConfig;
  update(patch: Partial<AutocareConfig>): void;
  accounts: AutocareSnapshot["accounts"];
  disabled?: boolean;
}) {
  const selected = accounts.filter((account) =>
    config.accountIds.includes(account.id),
  );
  if (!selected.length) return null;
  const targets = config.accountTargets ?? {};
  return (
    <div className="autocare-settings" aria-label="每个账号的内容方向">
      <p className="autocare-help muted">
        默认提升创作分，皮皮虾优先。按领域养号会筛选该账号的素材、推荐问题及互动目标；无匹配内容就等待。
      </p>
      {selected.map((account) => {
        const target = targets[account.id] ?? { enabled: false, domain: "" };
        const setTarget = (patch: Partial<typeof target>) =>
          update({
            accountTargets: {
              ...targets,
              [account.id]: { ...target, ...patch },
            },
          });
        return (
          <div className="autocare-settings" key={account.id}>
            <div className="row between">
              <strong>{account.nickname || account.alias}</strong>
              <label className="autocare-power">
                <span>按领域养号</span>
                <Switch
                  aria-label={`${account.nickname || account.alias}按领域养号`}
                  checked={target.enabled}
                  disabled={disabled}
                  onCheckedChange={(enabled) => setTarget({ enabled })}
                />
              </label>
            </div>
            {target.enabled ? (
              <Field label="内容营销领域关键词">
                <input
                  aria-label={`${account.nickname || account.alias}的内容营销领域关键词`}
                  placeholder="例如：办公效率、PPT、资料整理"
                  maxLength={120}
                  value={target.domain}
                  disabled={disabled}
                  onChange={(event) =>
                    setTarget({ domain: event.target.value })
                  }
                />
                <small className="muted">
                  多个关键词用顿号分隔，按文字命中任一词筛选；不代表语义相关性判断。填写后保存应用。
                </small>
              </Field>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
