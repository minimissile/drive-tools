import { Select } from "../ui/Select";
import { useState } from "react";
import { Button, Empty, Field, Notice, Panel } from "../ui/primitives";
import { formatTime } from "../lib/format";
import { useAppActions, useAppActivity } from "../state";
import { SearchDialog } from "./Dialogs";
import type { SearchDetail } from "../../shared/search";
const number = (value: number | null | undefined) =>
  value == null ? "—" : value.toLocaleString("zh-CN");
const money = (value: number | null | undefined) =>
  value == null ? "—" : `¥${(value / 100).toFixed(2)}`;
const localDate = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
    new Date(),
  );
export function Effects({
  detail,
  onSaved,
}: {
  detail: SearchDetail;
  onSaved(): void;
}) {
  const { command, notify } = useAppActions(),
    { busy } = useAppActivity(),
    [open, setOpen] = useState(false);
  const latest = detail.effects.find((e) => e.scope === "article"),
    accounts = detail.effects.filter((e) => e.scope === "account");
  return (
    <Panel
      title="发布效果"
      extra={
        <Button
          disabled={!detail.publications.length || busy > 0}
          onClick={() => setOpen(true)}
        >
          录入效果数据
        </Button>
      }
    >
      <div className="search-metrics">
        <div>
          <small>阅读量</small>
          <strong>{number(latest?.views)}</strong>
        </div>
        <div>
          <small>转存量</small>
          <strong>{number(latest?.saves)}</strong>
        </div>
        <div>
          <small>有效拉新</small>
          <strong>{number(latest?.newUsers)}</strong>
        </div>
        <div>
          <small>已结算收益</small>
          <strong>{money(latest?.revenueCents)}</strong>
        </div>
      </div>
      <small>
        {latest
          ? `最近录入的单篇数据：${latest.periodStart} — ${latest.periodEnd} · ${latest.source}`
          : "尚未录入单篇数据；未知数值保留为空。"}
      </small>
      {!detail.publications.length ? (
        <Notice>先在“发布准备”回填已发布文章地址，再录入效果数据。</Notice>
      ) : null}
      {accounts.length ? (
        <Notice>账号汇总单独保存，未计入上方单篇文章指标。</Notice>
      ) : null}
      {detail.effects.length ? (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>统计周期 / 来源</th>
                  <th>范围</th>
                  <th>阅读</th>
                  <th>转存</th>
                  <th>拉新</th>
                  <th>已结算收益</th>
                </tr>
              </thead>
              <tbody>
                {detail.effects.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.periodStart} — {e.periodEnd}
                      <small>
                        {e.source} · {formatTime(e.createdAt)}
                      </small>
                    </td>
                    <td>{e.scope === "article" ? "单篇文章" : "账号汇总"}</td>
                    <td>{number(e.views)}</td>
                    <td>{number(e.saves)}</td>
                    <td>{number(e.newUsers)}</td>
                    <td>{money(e.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <Button
              disabled={busy > 0}
              onClick={async () => {
                const path = await command("search.effectsExport", {
                  id: detail.topic.id,
                });
                if (path) notify(`效果记录已导出：${path}`, "success");
              }}
            >
              导出效果 CSV
            </Button>
          </div>
          <small>
            每条为指定周期的记录，不自动叠加累计值或计算无法核实的转化率。
          </small>
        </>
      ) : (
        <Empty title="还没有效果记录">
          可先手工填写后台数据，保留周期和来源。
        </Empty>
      )}
      {open ? (
        <EffectDialog
          detail={detail}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            onSaved();
          }}
        />
      ) : null}
    </Panel>
  );
}
function EffectDialog({
  detail,
  onClose,
  onSaved,
}: {
  detail: SearchDetail;
  onClose(): void;
  onSaved(): void;
}) {
  const { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const [publicationId, setPublicationId] = useState(
      detail.publications[0]?.id ?? "",
    ),
    [scope, setScope] = useState<"article" | "account">("article"),
    [start, setStart] = useState(localDate),
    [end, setEnd] = useState(localDate),
    [source, setSource] = useState(""),
    [values, setValues] = useState({
      views: "",
      saves: "",
      newUsers: "",
      revenue: "",
    });
  const labels = {
    views: "阅读量",
    saves: "转存量",
    newUsers: "有效拉新",
    revenue: "已结算人民币 / 元",
  };
  return (
    <SearchDialog title="录入效果数据" onClose={onClose}>
      <Field label="已发布文章">
        <Select
          value={publicationId}
          onValueChange={(nextValue) => setPublicationId(nextValue)}
          items={[
            ...detail.publications.map((p) => ({
              value: p.id,
              label: (
                <>
                  {p.url} · v{p.draftVersion}
                </>
              ),
            })),
          ]}
        />
      </Field>
      <Field label="归因范围">
        <Select
          value={scope}
          onValueChange={(nextValue) =>
            setScope(nextValue as "article" | "account")
          }
          items={[
            { value: "article", label: "可归因到本篇文章" },
            { value: "account", label: "仅有账号汇总数据" },
          ]}
        />
      </Field>
      <div className="field-pair">
        <Field label="统计开始">
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="统计结束">
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
      </div>
      <div className="field-pair">
        {(Object.keys(values) as (keyof typeof values)[]).map((key) => (
          <Field key={key} label={labels[key]}>
            <input
              type="number"
              min="0"
              step={key === "revenue" ? "0.01" : "1"}
              value={values[key]}
              onChange={(e) =>
                setValues((v) => ({ ...v, [key]: e.target.value }))
              }
              placeholder="未知留空"
            />
          </Field>
        ))}
      </div>
      <Field label="数据来源" required>
        <input
          value={source}
          maxLength={500}
          onChange={(e) => setSource(e.target.value)}
          placeholder="例如：CSDN 创作后台 / 推广结算报表"
        />
      </Field>
      {scope === "account" ? (
        <Notice warning>此数据属于账号汇总，不归因到当前文章。</Notice>
      ) : null}
      <div className="actions">
        <Button
          primary
          disabled={!source.trim() || !publicationId || busy > 0}
          onClick={async () => {
            if (
              Object.entries(values).some(
                ([k, v]) =>
                  v !== "" &&
                  (!Number.isFinite(Number(v)) ||
                    Number(v) < 0 ||
                    (k !== "revenue" && !Number.isInteger(Number(v)))),
              )
            ) {
              notify("请输入非负数，数量须为整数，未知数据留空。", "warning");
              return;
            }
            if (values.revenue && !/^\d+(\.\d{1,2})?$/.test(values.revenue)) {
              notify("人民币金额最多保留两位小数。", "warning");
              return;
            }
            const r = await command(
              "search.effect",
              {
                publicationId,
                scope,
                periodStart: start,
                periodEnd: end,
                views: values.views === "" ? null : Number(values.views),
                saves: values.saves === "" ? null : Number(values.saves),
                newUsers:
                  values.newUsers === "" ? null : Number(values.newUsers),
                revenueCents:
                  values.revenue === ""
                    ? null
                    : Math.round(Number(values.revenue) * 100),
                source,
              },
              "效果记录已保存。",
            );
            if (r) onSaved();
          }}
        >
          保存本次数据
        </Button>
      </div>
    </SearchDialog>
  );
}
