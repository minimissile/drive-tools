import { useState } from "react";
import { ExternalLink, LockKeyhole } from "lucide-react";
import type { DistributionOverview } from "../../shared/distribution";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice, Panel, Status } from "../ui/primitives";
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
      <div className="distribution-platform-heading">
        <div>
          <h2>{platform.name}</h2>
          <p>{platform.summary}</p>
        </div>
        <div className="row">
          <Status
            kind={platform.format === "unverified" ? "warning" : "normal"}
          >
            {platform.format === "unverified" ? "规则待核实" : "规则已查阅"}
          </Status>
          <Button onClick={() => void model.open()} disabled={model.busy}>
            <ExternalLink size={14} />
            打开投稿页
          </Button>
        </div>
      </div>
      <dl className="distribution-facts">
        <div>
          <dt>登录要求</dt>
          <dd>{platform.login === "required" ? "必须登录" : "未见登录门槛"}</dd>
        </div>
        <div>
          <dt>单批建议上限</dt>
          <dd>
            {platform.batchLimit
              ? `${platform.batchLimit.toLocaleString()} 条`
              : "待登录核实"}
          </dd>
        </div>
        <div>
          <dt>每日平台限额</dt>
          <dd>
            {platform.dailyLimit
              ? `${platform.dailyLimit.toLocaleString()} 条 / 用户`
              : platform.format === "unverified"
                ? "待登录核实"
                : "未公开"}
          </dd>
        </div>
        <div>
          <dt>本地近 24h 提交</dt>
          <dd>{item.submittedToday.toLocaleString()} 条</dd>
        </div>
      </dl>
      <details>
        <summary>
          查看投稿规则与待确认事项 <span>查阅于 {platform.checkedAt}</span>
        </summary>
        <ul>
          {platform.rules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <div className="distribution-unknown">
          <strong>待确认</strong>
          <ul>
            {platform.unknowns.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
        <p className="muted">
          来源：
          <a
            href={platform.submitUrl}
            onClick={(event) => {
              event.preventDefault();
              void model.open();
            }}
          >
            {platform.submitUrl}
          </a>
        </p>
        <p className="muted">
          点击自动分发后按批提交并保存回执。平台后台处理与收录结果仍以官网查询为准，可在逐条记录中核对。
        </p>
      </details>
      <div className="distribution-session row spread">
        <div>
          <LockKeyhole size={14} />
          <span>{item.alias || "单平台常用会话"}</span>
          <small>独立保存登录 · 登录状态以官网为准</small>
        </div>
        <div className="row">
          {platform.loginUrl ? (
            <Button
              quiet
              size="compact"
              disabled={model.busy}
              onClick={() => void model.open("login")}
            >
              打开登录页
            </Button>
          ) : null}
          <Button
            quiet
            size="compact"
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? "收起备注" : "账号与规则备注"}
          </Button>
        </div>
      </div>
      {item.note && !editing ? (
        <p className="distribution-rule-note">{item.note}</p>
      ) : null}
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
          <Field
            label="常用账号备注"
            hint="只记昵称或用途，请勿填写密码和 Cookie"
          >
            <input
              value={draft.value.alias}
              maxLength={100}
              onChange={(event) => draft.update({ alias: event.target.value })}
              placeholder="例如：资源分享主账号"
            />
          </Field>
          <Field label="补充规则与注意事项">
            <textarea
              value={draft.value.note}
              maxLength={2000}
              onChange={(event) => draft.update({ note: event.target.value })}
              placeholder="记录登录后看到的规则、类别要求或处理经验…"
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
