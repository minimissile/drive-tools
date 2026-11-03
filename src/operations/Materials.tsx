import { useState } from "react";
import type { OperationsSnapshot } from "../../shared/intelligent-operations";
import { CheckboxField } from "../ui/CheckboxField";
import { Pagination } from "../ui/Pagination";
import { Button, Empty, Field, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import { channelNames } from "./labels";
import type { PlanFields } from "./Plans";

export function MaterialPicker({
  value,
  snapshot: s,
  update,
}: {
  value: Pick<PlanFields, "channels" | "accounts" | "materialIds">;
  snapshot: OperationsSnapshot;
  update(ids: string[]): void;
}) {
  const [channel, setChannel] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const enabled = value.channels.filter((c) => c.enabled).map((c) => c.channel);
  const materials = s.materials.filter(
    (m) =>
      enabled.includes(m.channel) &&
      (channel === "all" || m.channel === channel) &&
      (!m.accountId ||
        value.accounts.some((a) => a.accountId === m.accountId)) &&
      m.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const actual = Math.min(page, Math.max(1, Math.ceil(materials.length / 8)));
  const selected = new Set(value.materialIds);
  return (
    <section className="operations-form-section" aria-label="计划素材范围">
      <div className="operations-channel-heading">
        <h3>计划素材范围 · 已选 {value.materialIds.length}</h3>
        <Button
          quiet
          size="compact"
          disabled={!value.materialIds.length}
          onClick={() => update([])}
        >
          清空选择
        </Button>
      </div>
      <p className="operations-quiet">
        仅认领这里选定的本地内容；留空不安排既有稿件。自主智能体需另获原创权限才可补充新稿，既有微博仍需核对准确版本。
      </p>
      <div className="operations-toolbar">
        <Field label="素材渠道">
          <Select
            value={channel}
            items={[
              { value: "all", label: "全部已启用渠道" },
              ...enabled.map((v) => ({ value: v, label: channelNames[v] })),
            ]}
            onValueChange={(v) => {
              setChannel(v);
              setPage(1);
            }}
          />
        </Field>
        <Field label="搜索素材">
          <input
            value={search}
            placeholder="按标题查找"
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
      </div>
      {materials.length ? (
        <>
          <div className="operations-table-scroll">
            <table className="operations-table">
              <thead>
                <tr>
                  <th>选择与内容</th>
                  <th>渠道 / 审核</th>
                </tr>
              </thead>
              <tbody>
                {materials.slice((actual - 1) * 8, actual * 8).map((m) => (
                  <tr key={m.id}>
                    <td>
                      <CheckboxField
                        checked={selected.has(m.id)}
                        label={m.title}
                        onChange={(e) => {
                          const next = new Set(selected);
                          e.target.checked ? next.add(m.id) : next.delete(m.id);
                          update([...next]);
                        }}
                      />
                      <small>
                        {m.accountId
                          ? s.accounts.find((a) => a.id === m.accountId)
                              ?.label || "原账号"
                          : "按计划匹配账号"}
                      </small>
                      <details>
                        <summary>查看内容摘要</summary>
                        <p>{m.preview}</p>
                      </details>
                    </td>
                    <td>
                      {channelNames[m.channel]}
                      <small>
                        {m.purpose === "warming" ? "养号内容" : "正式内容"}
                      </small>
                      <Status kind={m.reviewed ? "good" : "warning"}>
                        {m.reviewed ? "已审核" : "待审核"}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            label="计划素材分页"
            page={actual}
            pageSize={8}
            total={materials.length}
            onPageChange={setPage}
          />
        </>
      ) : (
        <Empty
          title={
            search || channel !== "all"
              ? "没有匹配的素材"
              : "当前范围没有本地素材"
          }
        >
          先启用渠道、关联账号并准备本地内容，再选择本计划可以安排的素材。
        </Empty>
      )}
    </section>
  );
}
