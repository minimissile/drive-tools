import { useState } from "react";
import { ipc } from "../api/client";
import { useAppNavigation } from "../state";
import { Button, Field, Notice, Status } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";
import { formatTime } from "../lib/format";
import type { SupplyDraft, SupplyEditorial } from "../../shared/content-supply";
import type { OperationsSnapshot } from "../../shared/intelligent-operations";
import type { SupplyEditorAction } from "./types";
export function SupplyDeliveryPanel({
  draft,
  editorial: e,
  body,
  changed,
  stale,
  operations,
  busy,
  run,
  onOpenWeibo,
}: {
  draft: SupplyDraft;
  editorial: SupplyEditorial;
  body: string;
  changed: boolean;
  stale: boolean;
  operations?: OperationsSnapshot;
  busy: string;
  run: SupplyEditorAction;
  onOpenWeibo(accountId: string, postId: string): Promise<void>;
}) {
  const { navigate } = useAppNavigation();
  const defaultChannel =
    operations?.accounts.find((a) => a.id === e.accountId)?.channel === "weibo"
      ? "weibo"
      : "zhihu";
  const [channel, setChannel] = useState<"zhihu" | "weibo">(defaultChannel),
    [deliveryAccount, setDeliveryAccount] = useState(e.accountId),
    [deliveryConsent, setDeliveryConsent] = useState(false);
  const existing = draft.deliveries.find((d) => d.channel === channel);
  return (
    <>
      <section className="supply-delivery" aria-label="渠道交付">
        <h3 className="supply-subheading">交付渠道草稿</h3>
        <div className="supply-edit-fields">
          <Field label="目标渠道">
            <Select
              aria-label="供稿交付渠道"
              value={channel}
              disabled={!!busy}
              items={[
                { value: "zhihu", label: "知乎待审阅素材池" },
                { value: "weibo", label: "微博本地草稿" },
              ]}
              onValueChange={(value) => {
                setChannel(value as "zhihu" | "weibo");
                setDeliveryAccount("");
                setDeliveryConsent(false);
              }}
            />
          </Field>
          <Field label="交付账号">
            <Select
              aria-label="供稿交付账号"
              value={existing?.accountId ?? deliveryAccount}
              disabled={!!busy || !operations || !!existing}
              items={[
                {
                  value: "",
                  label:
                    channel === "zhihu"
                      ? "公共素材池 · 暂不分配账号"
                      : "请选择微博账号",
                },
                ...(operations?.accounts ?? [])
                  .filter((a) => a.channel === channel)
                  .map((a) => ({ value: a.id, label: a.label })),
              ]}
              onValueChange={(value) => {
                setDeliveryAccount(value);
                setDeliveryConsent(false);
              }}
            />
          </Field>
        </div>
        {!existing && e.accountId && deliveryAccount !== e.accountId ? (
          <Notice warning>本编辑单已面向指定账号，请选择同一账号交付。</Notice>
        ) : null}
        <details className="supply-details">
          <summary>完整交付正文 · {body.length} 字符</summary>
          <pre className="supply-preview">{body}</pre>
        </details>
        {existing ? (
          <>
            <Notice>此渠道已创建原稿，后续修改请在渠道中进行。</Notice>
            <p className="supply-muted">
              {existing.title} · {formatTime(existing.createdAt)} ·{" "}
              {existing.targetId}
            </p>
            <Button
              onClick={() =>
                channel === "zhihu"
                  ? navigate("zhihu-operations")
                  : void onOpenWeibo(existing.accountId, existing.targetId)
              }
            >
              打开{channel === "zhihu" ? "知乎素材池" : "微博账号草稿"}
            </Button>
            {e.planId && !existing.planLinked ? (
              <>
                <Button
                  size="compact"
                  disabled={!!busy || stale}
                  onClick={() =>
                    void run(
                      "关联中",
                      () =>
                        ipc("contentSupply.linkPlan", {
                          id: draft.id,
                          version: draft.version,
                          channel,
                        }),
                      "计划关联结果已更新，原稿保留",
                    )
                  }
                >
                  加入关联计划库存
                </Button>
                {existing.linkError ? (
                  <Notice warning>
                    渠道稿已保存；计划关联未完成：{existing.linkError}
                  </Notice>
                ) : null}
              </>
            ) : e.planId ? (
              <Status kind="good">已加入计划待审阅库存</Status>
            ) : null}
          </>
        ) : (
          <>
            <CheckboxField
              label="已核对本版正文、事实与素材使用依据，仅创建本地待审阅稿"
              checked={deliveryConsent}
              disabled={!!busy || changed || stale}
              onChange={(event) => setDeliveryConsent(event.target.checked)}
            />
            <Button
              primary
              disabled={
                !!busy ||
                changed ||
                stale ||
                !deliveryConsent ||
                !e.title ||
                e.body.length < 10 ||
                !e.angle ||
                e.contribution.length < 10 ||
                (channel === "weibo" &&
                  (!deliveryAccount || body.length > 2000)) ||
                (!!e.accountId && e.accountId !== deliveryAccount)
              }
              onClick={() =>
                void run(
                  "交付中",
                  async () =>
                    (
                      await ipc("contentSupply.deliver", {
                        id: draft.id,
                        version: draft.version,
                        channel,
                        accountId: deliveryAccount,
                        confirmed: true,
                      })
                    ).draft,
                  "渠道稿已创建，仍待审阅，未发布",
                )
              }
            >
              {busy === "交付中" ? "创建中…" : "创建待审阅渠道稿"}
            </Button>
          </>
        )}
      </section>
    </>
  );
}
