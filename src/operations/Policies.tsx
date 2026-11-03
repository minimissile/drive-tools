import { z } from "zod";
import type {
  OperationsSnapshot,
  OperationsAccount,
} from "../../shared/intelligent-operations";
import { operationsChannelPolicy } from "../../shared/intelligent-operations";
import { CheckboxField } from "../ui/CheckboxField";
import { Field, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import { channelNames } from "./labels";
import type { PlanFields } from "./Plans";

export function ChannelEditor({
  policy: p,
  accounts,
  availableAccounts,
  capability,
  busy,
  updatePolicy,
  updateAccounts,
}: {
  policy: z.output<typeof operationsChannelPolicy>;
  accounts: PlanFields["accounts"];
  availableAccounts: OperationsAccount[];
  capability?: OperationsSnapshot["capabilities"][number];
  busy: boolean;
  updatePolicy(p: z.output<typeof operationsChannelPolicy>): void;
  updateAccounts(a: PlanFields["accounts"]): void;
}) {
  const options = availableAccounts.filter((a) => a.channel === p.channel);
  return (
    <div className="operations-channel">
      <div className="operations-channel-heading">
        <CheckboxField
          label={channelNames[p.channel]}
          checked={p.enabled}
          disabled={busy}
          onChange={(e) => updatePolicy({ ...p, enabled: e.target.checked })}
        />
        <Status kind={capability?.automatic ? "normal" : "warning"}>
          {capability?.automatic ? "已接入执行能力" : "人工交接"}
        </Status>
      </div>
      <p className="operations-quiet">
        {capability?.description || "读取平台能力后展示可执行范围。"}
      </p>
      {p.enabled ? (
        <>
          <div className="operations-fields four">
            <Field label="内容用途">
              <Select
                value={p.purpose}
                items={[
                  { value: "warming", label: "养号内容" },
                  { value: "regular", label: "正式内容" },
                ]}
                onValueChange={(v) =>
                  updatePolicy({ ...p, purpose: v as typeof p.purpose })
                }
              />
            </Field>
            <Field label="每日发布上限">
              <input
                type="number"
                min={1}
                max={10}
                value={p.dailyLimit}
                onChange={(e) =>
                  updatePolicy({ ...p, dailyLimit: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="最小间隔（分钟）">
              <input
                type="number"
                min={60}
                max={1440}
                value={p.gapMinutes}
                onChange={(e) =>
                  updatePolicy({ ...p, gapMinutes: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="进度检查间隔（小时）">
              <input
                type="number"
                min={1}
                max={168}
                value={p.checkHours}
                onChange={(e) =>
                  updatePolicy({ ...p, checkHours: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="执行开始时间">
              <input
                type="time"
                value={p.windowStart}
                onChange={(e) =>
                  updatePolicy({ ...p, windowStart: e.target.value })
                }
              />
            </Field>
            <Field label="执行结束时间" hint="北京时间，当天时段">
              <input
                type="time"
                value={p.windowEnd}
                onChange={(e) =>
                  updatePolicy({ ...p, windowEnd: e.target.value })
                }
              />
            </Field>
          </div>
          <div className="operations-account-options">
            {options.length ? (
              options.map((a) => {
                const current = accounts.find((p) => p.accountId === a.id);
                const patch = (change: Partial<NonNullable<typeof current>>) =>
                  updateAccounts(
                    accounts.map((p) =>
                      p.accountId === a.id ? { ...p, ...change } : p,
                    ),
                  );
                return (
                  <div key={a.id} className="operations-account-option">
                    <div>
                      <CheckboxField
                        checked={!!current}
                        label={a.label}
                        hint={`${a.environmentName || channelNames[p.channel]} · ${p.channel === "wechat" ? "内容交接映射" : a.connected ? "身份已连接" : a.message}`}
                        onChange={(e) =>
                          updateAccounts(
                            e.target.checked
                              ? [
                                  ...accounts,
                                  {
                                    accountId: a.id,
                                    channel: p.channel,
                                    paused: false,
                                    dailyLimit: null,
                                    gapMinutes: null,
                                    positioning: "",
                                    windowStart: null,
                                    windowEnd: null,
                                  },
                                ]
                              : accounts.filter((p) => p.accountId !== a.id),
                          )
                        }
                      />
                      {current ? (
                        <CheckboxField
                          label="单独暂停此账号"
                          checked={current.paused}
                          onChange={(e) => patch({ paused: e.target.checked })}
                        />
                      ) : null}
                    </div>
                    {current ? (
                      <div className="operations-fields">
                        <Field label="账号日上限" hint="留空继承">
                          <input
                            type="number"
                            min={1}
                            max={p.dailyLimit}
                            value={current.dailyLimit ?? ""}
                            placeholder={String(p.dailyLimit)}
                            onChange={(e) =>
                              patch({
                                dailyLimit:
                                  e.target.value === ""
                                    ? null
                                    : Number(e.target.value),
                              })
                            }
                          />
                        </Field>
                        <Field label="账号间隔（分钟）" hint="留空继承">
                          <input
                            type="number"
                            min={p.gapMinutes}
                            max={1440}
                            value={current.gapMinutes ?? ""}
                            placeholder={String(p.gapMinutes)}
                            onChange={(e) =>
                              patch({
                                gapMinutes:
                                  e.target.value === ""
                                    ? null
                                    : Number(e.target.value),
                              })
                            }
                          />
                        </Field>
                      </div>
                    ) : null}
                    {current ? (
                      <details className="operations-account-detail">
                        <summary>账号定位与执行时段</summary>
                        <div className="operations-fields">
                          <div className="wide">
                            <Field
                              label="账号定位"
                              hint="此账号的内容侧重，留空沿用计划方向"
                            >
                              <textarea
                                value={current.positioning ?? ""}
                                maxLength={1000}
                                placeholder="例如：面向初学者，侧重入门步骤"
                                onChange={(e) =>
                                  patch({ positioning: e.target.value })
                                }
                              />
                            </Field>
                          </div>
                          <Field
                            label="账号开始时间"
                            hint={`留空继承 ${p.windowStart}`}
                          >
                            <input
                              type="time"
                              value={current.windowStart ?? ""}
                              onChange={(e) =>
                                patch({ windowStart: e.target.value || null })
                              }
                            />
                          </Field>
                          <Field
                            label="账号结束时间"
                            hint={`留空继承 ${p.windowEnd}`}
                          >
                            <input
                              type="time"
                              value={current.windowEnd ?? ""}
                              onChange={(e) =>
                                patch({ windowEnd: e.target.value || null })
                              }
                            />
                          </Field>
                        </div>
                        <p className="operations-quiet">
                          北京时间，仅可在渠道时段内进一步收紧。
                        </p>
                      </details>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="operations-quiet">
                {p.channel === "wechat"
                  ? "先到连接与设置 → 浏览器绑定添加公众号渠道。当前仅安排内容与人工交接。"
                  : "还没有可关联账号，请先在账号管理中完成绑定。"}
              </p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
