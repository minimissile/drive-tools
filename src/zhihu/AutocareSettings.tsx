import { useState } from "react";
import {
  autocareConfigSchema,
  type AutocareConfig,
  type AutocareSnapshot,
} from "../../shared/zhihu-autocare";
import { Button, Empty, Field } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { AutocareAccountTargets } from "./AutocareAccountTargets";

export function AutocareSettings({
  snapshot: s,
  config: cfg,
  update,
  disabled,
  changed,
  onSave,
  onReset,
  onManageAccounts,
  openSettings,
}: {
  snapshot: AutocareSnapshot;
  config: AutocareConfig;
  update(patch: Partial<AutocareConfig>): void;
  disabled: boolean;
  changed: boolean;
  onSave(): void;
  onReset(): void;
  onManageAccounts(): void;
  openSettings(tab: "sources" | "ai"): void;
}) {
  const [expanded, setExpanded] = useState(!s.enabled);
  const supportsWindow =
    s.run !== undefined || s.todayPlan?.runStatus !== undefined;
  const actions = [
    s.config.publish && "发文",
    s.config.answerRecommended && "回答",
    (s.config.randomLikes || s.config.likeCandidates) && "随机点赞",
    s.config.followCandidates && "自动关注作者",
    s.config.randomComments && "随机评论",
    s.config.readRecommended && "读取内容",
  ].filter(Boolean);
  return (
    <details
      className="panel autocare-config"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <strong>操作与设置</strong>
        <span>
          {changed
            ? "有未保存的修改"
            : `${s.config.accountIds.length}个账号 · ${actions.join("、") || "未选择自动操作"} · 启动后2小时内`}
        </span>
      </summary>
      <div className="autocare-config-content">
        <div className="autocare-config-toolbar">
          <span className="muted">
            {s.enabled
              ? "保存后应用于未执行的任务；更换账号请先关闭总开关。"
              : "选好账号和操作，开启总开关即可保存并安排。"}
          </span>
          <div className="row compact">
            {changed ? (
              <Button
                quiet
                size="compact"
                disabled={disabled}
                onClick={onReset}
              >
                撤销修改
              </Button>
            ) : null}
            <Button
              primary
              size="compact"
              disabled={disabled || !changed || !supportsWindow}
              onClick={onSave}
            >
              {s.enabled ? "保存并应用" : "保存设置"}
            </Button>
          </div>
        </div>
        <fieldset disabled={disabled} className="autocare-settings">
          <div className="autocare-accounts">
            {s.accounts.map((a) => (
              <CheckboxField
                key={a.id}
                label={
                  <>
                    <strong>{a.nickname || a.alias}</strong>
                    <small>
                      {a.environmentName} ·{" "}
                      {a.status === "connected" ? "已登录" : "需检查登录"}
                    </small>
                  </>
                }
                checked={cfg.accountIds.includes(a.id)}
                disabled={s.enabled}
                onChange={(e) =>
                  update({
                    accountIds: e.target.checked
                      ? [...new Set([...cfg.accountIds, a.id])]
                      : cfg.accountIds.filter((id) => id !== a.id),
                  })
                }
              />
            ))}
            {!s.accounts.length ? (
              <Empty
                compact
                title="还没有知乎账号"
                action={
                  <Button size="compact" onClick={onManageAccounts}>
                    连接账号
                  </Button>
                }
              >
                先关联已登录的比特窗口。
              </Empty>
            ) : null}
          </div>
          <AutocareAccountTargets
            config={cfg}
            update={update}
            accounts={s.accounts}
            disabled={disabled}
          />
          <div className="autocare-operation-group">
            <h3>自动执行</h3>
            <div className="autocare-actions">
              <CheckboxField
                label="自动发文"
                checked={cfg.publish}
                onChange={(e) => update({ publish: e.target.checked })}
              />
              <CheckboxField
                label="回答推荐问题"
                checked={cfg.answerRecommended}
                onChange={(e) =>
                  update({ answerRecommended: e.target.checked })
                }
              />
              <CheckboxField
                label="随机点赞"
                checked={cfg.randomLikes || cfg.likeCandidates}
                onChange={(e) =>
                  update({
                    randomLikes: e.target.checked,
                    likeCandidates: false,
                  })
                }
              />
              <CheckboxField
                label="随机评论"
                checked={cfg.randomComments}
                onChange={(e) => update({ randomComments: e.target.checked })}
              />
              <CheckboxField
                label="自动关注作者"
                checked={cfg.followCandidates}
                onChange={(e) => update({ followCandidates: e.target.checked })}
              />
              <CheckboxField
                label="读取推荐内容"
                checked={cfg.readRecommended}
                onChange={(e) => update({ readRecommended: e.target.checked })}
              />
            </div>
            <p className="autocare-help">
              总开关在启动后2小时内自动安排所有已勾选操作。互动每轮选择一项；缺少正文时先读取，已有历史待办会重新核对后纳入。读取内容不计为本人阅读回执。
            </p>
          </div>
          <div className="autocare-primary-fields">
            <Field label="今日发布总上限">
              <input
                aria-label="今日文章与回答发布总上限"
                type="number"
                min={1}
                max={10}
                value={cfg.dailyLimit}
                onChange={(e) => update({ dailyLimit: Number(e.target.value) })}
              />
            </Field>
            <Field label="其中回答最多">
              <input
                aria-label="今日回答上限"
                type="number"
                min={1}
                max={3}
                value={cfg.answersPerDay}
                onChange={(e) =>
                  update({ answersPerDay: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="今日读取上限">
              <input
                aria-label="今日自动读取上限"
                type="number"
                min={1}
                max={10}
                value={cfg.researchPerDay}
                onChange={(e) =>
                  update({ researchPerDay: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="今日互动总上限">
              <input
                aria-label="今日点赞评论与关注总上限"
                type="number"
                min={1}
                max={10}
                value={cfg.interactionDailyLimit}
                onChange={(e) =>
                  update({ interactionDailyLimit: Number(e.target.value) })
                }
              />
            </Field>
          </div>
          <p className="autocare-help">
            本次已授权数量随后端更新自动应用。已消耗额度不重置；之后手动修改仍需保存，不延长本轮截止。
          </p>
          <details className="autocare-more">
            <summary>更多运行设置</summary>
            <p className="autocare-help">
              本模式固定按5分钟间隔错峰，生成尝试次数按所选任务数量预留，不需要逐项配置。
            </p>
            <p className="autocare-help">
              文章与回答共用发布额度。点赞、评论与关注共用互动额度，并与发布错峰。评论由AI结合全文生成，使用现有生成次数与金额预算。
            </p>
            <div className="autocare-primary-fields">
              <Field label="目标等级">
                <input
                  type="number"
                  min={4}
                  max={10}
                  value={cfg.targetLevel}
                  onChange={(e) =>
                    update({ targetLevel: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="每号每周最多">
                <input
                  type="number"
                  min={1}
                  max={70}
                  value={cfg.weeklyLimit}
                  onChange={(e) =>
                    update({ weeklyLimit: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <CheckboxField
              label="补采原帖评论作为生成参考（使用额外采集请求）"
              checked={cfg.includeComments}
              onChange={(e) => update({ includeComments: e.target.checked })}
            />
            <p className="muted">
              原图有已保存的使用依据时附图；其余采用有来源的文字稿。任务在本轮启动后2小时内随机安排，超出截止的项目保留未完成原因，不补跑到全天。
            </p>
            <Button
              size="compact"
              onClick={() =>
                update({
                  ...autocareConfigSchema.parse({}),
                  accountIds: cfg.accountIds,
                  accountTargets: cfg.accountTargets,
                })
              }
            >
              恢复推荐预设
            </Button>
          </details>
        </fieldset>
        <details className="autocare-more autocare-source-settings">
          <summary>数据源与模型设置</summary>
          <div className="autocare-budget">
            <span>
              模型：{s.modelName || "未设置"} · 今日生成 {s.generationCount}/
              {cfg.generationsPerDay} 次 · 全局AI日预算
              {s.globalAiBudgetMicros === null
                ? "未设置金额上限"
                : ` $${(s.globalAiBudgetMicros / 1e6).toFixed(2)}`}
            </span>
            <span>
              采集今日剩余 {s.requestsRemaining}/{s.requestsLimit} 次 ·{" "}
              {s.listPagesPerRun
                ? "库存不足时自动补采"
                : "新列表采集已关闭，仅用本地库存"}
            </span>
            <Button
              quiet
              size="compact"
              onClick={() => openSettings("sources")}
            >
              数据源设置
            </Button>
            <Button quiet size="compact" onClick={() => openSettings("ai")}>
              模型与预算
            </Button>
          </div>{" "}
        </details>
        <small className="muted">
          开启只做本地检查和排期，所有自动浏览操作使用比特无头模式；到时核验身份再执行。手动登录和验证在账号管理处理。
        </small>
      </div>
    </details>
  );
}
