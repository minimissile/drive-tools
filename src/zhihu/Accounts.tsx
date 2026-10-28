import { useState } from "react";
import type { ZhihuSnapshot } from "../../shared/zhihu";
import { ipc } from "../api/client";
import { Button, Empty, Field, Notice, Panel, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import { CheckboxField } from "../ui/CheckboxField";
import { formatTime } from "../lib/format";
export type ZhihuAction = (
  action: () => Promise<unknown>,
  message: string,
  onError?: (message: string) => void,
) => Promise<boolean>;
export function ZhihuAccounts({
  accounts,
  busy,
  run,
  manage,
}: {
  accounts: ZhihuSnapshot["accounts"];
  busy: boolean;
  run: ZhihuAction;
  manage(): void;
}) {
  const [selected, setSelected] = useState("");
  const account = accounts.find((a) => a.id === selected) ?? accounts[0];
  if (!account)
    return (
      <Panel title="连接知乎账号">
        <Empty
          title="还没有知乎账号"
          action={
            <Button primary onClick={manage}>
              管理账号与环境
            </Button>
          }
        >
          在账号管理中选择知乎，并关联已有比特浏览器环境。
        </Empty>
      </Panel>
    );
  return (
    <div className="zhihu-account-layout">
      <Panel
        title="知乎账号"
        extra={
          <Button quiet onClick={manage}>
            管理账号
          </Button>
        }
      >
        <div className="zhihu-account-list">
          {accounts.map((a) => (
            <button
              key={a.id}
              className="zhihu-account-choice"
              aria-pressed={a.id === account.id}
              onClick={() => setSelected(a.id)}
            >
              <span>
                <strong>{a.nickname || a.alias}</strong>
                <small>
                  {a.environmentName} ·{" "}
                  {a.engine === "bitbrowser" ? "比特" : "需关联比特"}
                </small>
              </span>
              <Status kind={a.plan.active ? "good" : "warning"}>
                {a.plan.progress?.level == null
                  ? "等级未知"
                  : `Lv.${a.plan.progress.level}`}
              </Status>
            </button>
          ))}
        </div>
      </Panel>
      <AccountPlan
        key={account.id + account.plan.progress?.checkedAt}
        account={account}
        peers={
          account.ip ? accounts.filter((a) => a.ip === account.ip).length : 0
        }
        busy={busy}
        run={run}
      />
    </div>
  );
}
function AccountPlan({
  account: a,
  peers,
  busy,
  run,
}: {
  account: ZhihuSnapshot["accounts"][number];
  peers: number;
  busy: boolean;
  run: ZhihuAction;
}) {
  const [policy, setPolicy] = useState({
    accountId: a.id,
    targetLevel: a.plan.targetLevel,
    dailyLimit: a.plan.dailyLimit,
    weeklyLimit: a.plan.weeklyLimit,
    gapMinutes: a.plan.gapMinutes,
  });
  const [manual, setManual] = useState(false),
    [level, setLevel] = useState(a.plan.progress?.level ?? 0),
    [creator, setCreator] = useState(false),
    [note, setNote] = useState("");
  const p = a.plan.progress;
  return (
    <Panel
      title={a.nickname || a.alias}
      extra={
        <Status kind={a.plan.active ? "good" : "normal"}>
          {a.plan.active ? "养号已启用" : "养号已暂停"}
        </Status>
      }
    >
      <div className="zhihu-account-facts">
        <span>
          创作者{" "}
          {p?.creator === true
            ? "已入驻"
            : p?.creator === false
              ? "未入驻"
              : "待核实"}
        </span>
        <span>目标 Lv.{a.plan.targetLevel}</span>
        <span>
          今日 {a.today} / {a.plan.dailyLimit}
        </span>
        <span>
          本周 {a.week} / {a.plan.weeklyLimit}
        </span>
      </div>
      <p className="muted">
        {a.environmentName} · 出口 {a.ip || "尚未检查"} ·{" "}
        {a.status === "connected" ? "身份已核实" : "需要检查登录"}
      </p>
      {peers > 1 ? (
        <Notice warning={peers > 3}>
          此出口关联 {peers} 个知乎账号。文章建议每个 IP 对应 2–3
          个账号；所有账号仍会检查发布间隔。
        </Notice>
      ) : null}
      <div className="row wrap">
        <Button
          disabled={busy}
          onClick={() =>
            void run(
              () => ipc("websiteAccounts.login", { id: a.id }),
              "已打开知乎登录窗口",
            )
          }
        >
          打开登录窗口
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await ipc("websiteAccounts.check", { id: a.id });
              if (r.status !== "connected") throw new Error(r.message);
            }, "知乎身份已核实")
          }
        >
          检查登录
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void run(
              () => ipc("zhihu.progress.check", { accountId: a.id }),
              "创作者状态已读取",
            )
          }
        >
          检查创作者等级
        </Button>
        <Button quiet disabled={busy} onClick={() => setManual(!manual)}>
          手动记录等级
        </Button>
      </div>
      <p className="muted">
        {p
          ? `${p.source === "manual" ? "人工记录" : "官方页面识别"} · ${formatTime(p.checkedAt)} · ${p.note}`
          : "先入驻官方创作者中心，再检查实际等级。无法识别时，可查看官方页面后手动记录。"}
      </p>
      {manual ? (
        <div className="zhihu-manual-record">
          <div className="zhihu-fields">
            <Field label="实际创作等级">
              <input
                type="number"
                min={0}
                max={10}
                value={level}
                onChange={(e) => setLevel(Number(e.target.value))}
              />
            </Field>
            <Field label="核实依据">
              <input
                value={note}
                maxLength={500}
                placeholder="例如：已在创作者中心核对今日等级"
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
          <CheckboxField
            checked={creator}
            onChange={(e) => setCreator(e.target.checked)}
            label="我已核实此账号入驻了创作者中心"
          />
          <Button
            disabled={busy || note.trim().length < 5}
            onClick={() =>
              void run(
                () =>
                  ipc("zhihu.progress.record", {
                    accountId: a.id,
                    creator,
                    level,
                    note,
                  }),
                "实际等级已记录",
              ).then((ok) => {
                if (ok) setManual(false);
              })
            }
          >
            保存实际等级
          </Button>
        </div>
      ) : null}
      <div className="zhihu-fields zhihu-policy-fields">
        <Field label="目标等级">
          <Select
            value={String(policy.targetLevel)}
            items={Array.from({ length: 7 }, (_, i) => ({
              value: String(i + 4),
              label: `Lv.${i + 4}`,
            }))}
            onValueChange={(v) =>
              setPolicy({ ...policy, targetLevel: Number(v) })
            }
          />
        </Field>
        <Field label="每日上限">
          <input
            type="number"
            min={1}
            max={10}
            value={policy.dailyLimit}
            onChange={(e) =>
              setPolicy({ ...policy, dailyLimit: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="每周上限">
          <input
            type="number"
            min={1}
            max={70}
            value={policy.weeklyLimit}
            onChange={(e) =>
              setPolicy({ ...policy, weeklyLimit: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="最小间隔（分钟）">
          <input
            type="number"
            min={60}
            max={1440}
            value={policy.gapMinutes}
            onChange={(e) =>
              setPolicy({ ...policy, gapMinutes: Number(e.target.value) })
            }
          />
        </Field>
      </div>
      <div className="row wrap">
        <Button
          disabled={busy}
          onClick={() =>
            void run(() => ipc("zhihu.plan.save", policy), "养号规则已保存")
          }
        >
          保存规则
        </Button>
        <Button
          primary={!a.plan.active}
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                ipc("zhihu.plan.active", {
                  accountId: a.id,
                  active: !a.plan.active,
                }),
              a.plan.active
                ? "已暂停养号计划"
                : "养号计划已启用，启动调度后执行",
            )
          }
        >
          {a.plan.active ? "暂停养号计划" : "启用养号计划"}
        </Button>
      </div>
      <Notice>
        {a.plan.message}。到达目标等级后停止养号；发布结果未知时需先核对。
      </Notice>
    </Panel>
  );
}
