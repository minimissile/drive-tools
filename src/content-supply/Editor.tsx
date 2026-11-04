import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppNavigation } from "../state";
import { Button, Field, Notice, Panel, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import { CheckboxField } from "../ui/CheckboxField";
import { updateSelection } from "../lib/selection";
import { SupplySourcePanel } from "./SourcePanel";
import { SupplyDeliveryPanel } from "./Delivery";
import {
  supplyBody,
  supplyEditorialSchema,
  type SupplyDraft,
  type SupplyEditorial,
} from "../../shared/content-supply";
import type { OperationsSnapshot } from "../../shared/intelligent-operations";

// Rights evidence comes from saved business records; fresh delivery/fee consent is never restored.
const textDraftSchema = supplyEditorialSchema.omit({
  textBasis: true,
  textEvidence: true,
  imageBasis: true,
  imageEvidence: true,
  commentBasis: true,
  commentEvidence: true,
});
const rightsValues = (e: SupplyEditorial) => ({
  textBasis: e.textBasis,
  textEvidence: e.textEvidence,
  imageBasis: e.imageBasis,
  imageEvidence: e.imageEvidence,
  commentBasis: e.commentBasis,
  commentEvidence: e.commentEvidence,
});
const basisItems = [
  { value: "unknown", label: "尚未核实" },
  { value: "own", label: "本人原创" },
  { value: "authorized", label: "已获得授权" },
  { value: "license", label: "许可范围内使用" },
  { value: "public-domain", label: "公共领域" },
  { value: "quotation", label: "必要引用 · 说明范围" },
];

export function SupplyEditor({
  workspace,
  draft,
  latest,
  operations,
  ai,
  onSaved,
  onOpenWeibo,
}: {
  workspace: string;
  draft: SupplyDraft;
  latest?: SupplyDraft;
  operations?: OperationsSnapshot;
  ai: { configured: boolean; model: string };
  onSaved(value: SupplyDraft): void;
  onOpenWeibo(accountId: string, postId: string): Promise<void>;
}) {
  const { notify } = useAppActions(),
    { navigate, openSettings } = useAppNavigation();
  const local = useLocalDraft(
    `content-supply-editor-v1:${workspace}:${draft.id}:${draft.version}`,
    textDraftSchema.parse(draft.editorial),
    (v) => textDraftSchema.parse(v),
  );
  const [rights, setRights] = useState(() => rightsValues(draft.editorial));
  const [aiAssisted, setAiAssisted] = useState(
    draft.editorial.aiAssisted || local.value.aiAssisted,
  );
  const [feeConsent, setFeeConsent] = useState(false);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const e = supplyEditorialSchema.parse({
    ...local.value,
    ...rights,
    aiAssisted,
  });
  const changed =
    JSON.stringify(e) !==
    JSON.stringify(supplyEditorialSchema.parse(draft.editorial));
  const stale = !!latest && latest.version !== draft.version;
  const immutable = draft.stage === "delivered",
    held = draft.stage === "held",
    disabled = !!busy || draft.stage !== "editing" || stale;
  const source = draft.source!;
  const body = supplyBody(source, e);
  const update = (patch: Partial<typeof local.value>) => {
    local.update(patch);
    setFeeConsent(false);
  };
  const run = async (
    label: string,
    action: () => Promise<SupplyDraft>,
    message: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError("");
    try {
      const next = await action();
      local.clear();
      notify(message, "success");
      if (alive.current) onSaved(next);
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      lock.current = false;
      if (alive.current) setBusy("");
    }
  };
  const selection = (
    key: "imageIds" | "commentIds",
    id: string,
    checked: boolean,
  ) => {
    setRights((old) =>
      key === "commentIds"
        ? { ...old, commentBasis: "unknown", commentEvidence: "" }
        : { ...old, imageBasis: "unknown", imageEvidence: "" },
    );
    update({
      [key]: updateSelection(
        e[key],
        [id],
        checked,
        key === "imageIds" ? 9 : 50,
      ),
    });
  };
  return (
    <div className="supply-editor-layout">
      <SupplySourcePanel
        source={source}
        editorial={e}
        draftId={draft.id}
        disabled={disabled}
        showRefresh={!immutable && !held}
        refreshDisabled={disabled || changed}
        selection={selection}
        onAttachComments={
          immutable || held || changed || stale
            ? undefined
            : (ids) =>
                run(
                  "读取评论",
                  () =>
                    ipc("contentSupply.attachComments", {
                      id: draft.id,
                      version: draft.version,
                      commentIds: ids,
                    }),
                  "本地评论已加入选材快照，尚未自动采用",
                )
        }
        onRefresh={() =>
          void run(
            "补全中",
            () =>
              ipc("contentSupply.refreshSource", {
                id: draft.id,
                version: draft.version,
              }),
            "已继续原素材补全，成功图片会复用",
          )
        }
      />
      <Panel
        title="编辑稿"
        extra={
          <Status kind={immutable ? "good" : "normal"}>
            {immutable
              ? "已交付 · 待渠道审阅"
              : held
                ? "暂不采用"
                : `待编辑 · v${draft.version}`}
          </Status>
        }
      >
        {stale ? (
          <Notice warning>
            编辑单已在其他窗口更新。当前文字仍在本机暂存。
            <Button size="compact" onClick={() => onSaved(latest!)}>
              载入最新版本
            </Button>
          </Notice>
        ) : null}
        {immutable ? (
          <Notice>
            本编辑单已锁定。后续正文修改请在原渠道稿中完成，渠道审阅会按版本重新校验。
          </Notice>
        ) : null}
        {held ? (
          <Notice warning>
            暂不采用：{draft.reason}
            <Button
              size="compact"
              disabled={!!busy || stale}
              onClick={() =>
                void run(
                  "恢复中",
                  () =>
                    ipc("contentSupply.reopen", {
                      id: draft.id,
                      version: draft.version,
                    }),
                  "编辑单已恢复，等待重新编辑",
                )
              }
            >
              重新编辑
            </Button>
          </Notice>
        ) : null}
        {local.restored && !immutable ? (
          <small className="supply-muted">
            已恢复当前版本的本机文字暂存；费用与交付确认未恢复。
          </small>
        ) : null}
        <div className="supply-edit-fields">
          <Field label="关联计划">
            <Select
              aria-label="编辑关联计划"
              disabled={disabled || !operations}
              value={e.planId}
              items={[
                { value: "", label: "独立编辑单" },
                ...(operations?.plans ?? []).map((plan) => ({
                  value: plan.id,
                  label: plan.name,
                })),
              ]}
              onValueChange={(planId) => update({ planId })}
            />
          </Field>
          <Field label="面向账号">
            <Select
              aria-label="编辑目标账号"
              disabled={disabled || !operations}
              value={e.accountId}
              items={[
                { value: "", label: "公共编辑稿" },
                ...(operations?.accounts ?? [])
                  .filter(
                    (account) =>
                      account.channel === "zhihu" ||
                      account.channel === "weibo",
                  )
                  .map((account) => ({
                    value: account.id,
                    label: `${account.channel === "zhihu" ? "知乎" : "微博"} · ${account.label}`,
                  })),
              ]}
              onValueChange={(accountId) => {
                update({ accountId });
              }}
            />
          </Field>
        </div>
        <div className="supply-edit-fields">
          <Field label="内容方向">
            <input
              aria-label="编辑内容方向"
              value={e.direction}
              maxLength={1000}
              disabled={disabled}
              onChange={(event) => update({ direction: event.target.value })}
            />
          </Field>
          <Field label="受众">
            <input
              aria-label="编辑受众"
              value={e.audience}
              maxLength={1000}
              disabled={disabled}
              onChange={(event) => update({ audience: event.target.value })}
            />
          </Field>
        </div>
        <Field label="这篇要解决什么问题">
          <textarea
            aria-label="编辑核心问题"
            className="supply-short-text"
            value={e.angle}
            maxLength={2000}
            disabled={disabled}
            placeholder="围绕来源提出一个具体、与账号方向有关的问题"
            onChange={(event) => update({ angle: event.target.value })}
          />
        </Field>
        <Field label="作者新增判断与依据">
          <textarea
            aria-label="作者新增判断与依据"
            className="supply-short-text"
            value={e.contribution}
            maxLength={8000}
            disabled={disabled}
            placeholder="提供自己的判断、实际步骤或可核对事实；不填写未经证实的亲测与资历"
            onChange={(event) => update({ contribution: event.target.value })}
          />
        </Field>
        <Field label="内容用途">
          <Select
            aria-label="供稿内容用途"
            value={e.purpose}
            disabled={disabled}
            items={[
              { value: "warming", label: "日常内容 · 不含链接或推广" },
              { value: "regular", label: "常规内容" },
            ]}
            onValueChange={(purpose) =>
              update({ purpose: purpose as "warming" | "regular" })
            }
          />
        </Field>
        <Field label="稿件标题">
          <input
            aria-label="供稿标题"
            value={e.title}
            maxLength={100}
            disabled={disabled}
            onChange={(event) => update({ title: event.target.value })}
          />
        </Field>
        <Field label="正文">
          <textarea
            aria-label="供稿正文"
            className="supply-body"
            value={e.body}
            maxLength={45000}
            disabled={disabled}
            placeholder="在这里写有信息增量的正文，或先保存观点后按次生成初稿"
            onChange={(event) => update({ body: event.target.value })}
          />
        </Field>
        <small className="supply-muted">
          正文 {e.body.length} 字符 · 引用评论 {e.commentIds.length} 条 · 图片{" "}
          {e.imageIds.length}{" "}
          张；交付时追加所选评论与出处，完整原帖链接保存在来源记录中。
        </small>
        <details className="supply-details">
          <summary>事实核对与素材使用依据</summary>
          <Field label="待核事实、版本与引用范围">
            <textarea
              aria-label="供稿事实核对"
              className="supply-short-text"
              value={e.checks}
              maxLength={8000}
              disabled={disabled}
              onChange={(event) => update({ checks: event.target.value })}
            />
          </Field>
          {(
            [
              "text",
              ...(e.imageIds.length ? ["image"] : []),
              ...(e.commentIds.length ? ["comment"] : []),
            ] as const
          ).map((kind) => {
            const basisKey = `${kind}Basis` as
                "textBasis" | "imageBasis" | "commentBasis",
              evidenceKey = `${kind}Evidence` as
                "textEvidence" | "imageEvidence" | "commentEvidence";
            const label =
              kind === "text"
                ? "原文参考"
                : kind === "image"
                  ? "所选图片"
                  : "所选评论";
            return (
              <div className="supply-rights" key={kind}>
                <Field label={`${label}依据`}>
                  <Select
                    aria-label={`${label}依据`}
                    value={rights[basisKey]}
                    disabled={disabled}
                    items={
                      kind === "text"
                        ? [
                            basisItems[0],
                            {
                              value: "reference",
                              label: "仅作背景参考，不复制表达",
                            },
                            ...basisItems.slice(1),
                          ]
                        : basisItems
                    }
                    onValueChange={(value) => {
                      setRights((old) => ({ ...old, [basisKey]: value }));
                    }}
                  />
                </Field>
                <Field label={`${label}说明`}>
                  <input
                    aria-label={`${label}说明`}
                    value={rights[evidenceKey]}
                    maxLength={2000}
                    disabled={disabled}
                    placeholder="授权/许可链接、本人作品依据或必要引用范围"
                    onChange={(event) => {
                      setRights((old) => ({
                        ...old,
                        [evidenceKey]: event.target.value,
                      }));
                    }}
                  />
                </Field>
              </div>
            );
          })}
        </details>
        <CheckboxField
          label="本稿实际使用了AI辅助"
          hint={
            draft.editorial.aiAssisted
              ? "该稿已有AI参与记录，人工润色后仍保留。"
              : "按真实创作过程填写；自动生成后会记录AI参与。"
          }
          checked={e.aiAssisted}
          disabled={disabled || draft.editorial.aiAssisted}
          onChange={(event) => {
            setAiAssisted(event.target.checked);
            local.update({ aiAssisted: event.target.checked });
          }}
        />
        {error || local.error ? (
          <Notice danger>{error || local.error}</Notice>
        ) : null}
        {!immutable && !held ? (
          <div className="supply-save-row">
            <Button
              primary
              disabled={disabled || !changed || !!local.error}
              onClick={() =>
                void run(
                  "保存中",
                  () =>
                    ipc("contentSupply.save", {
                      id: draft.id,
                      version: draft.version,
                      editorial: e,
                    }),
                  "编辑稿已保存，尚未审阅",
                )
              }
            >
              {busy === "保存中" ? "保存中…" : "保存编辑稿"}
            </Button>
            <small className="supply-muted">
              {changed ? "有未保存修改" : "当前版本已保存"}
            </small>
          </div>
        ) : null}
        {!immutable && !held ? (
          <details className="supply-details">
            <summary>AI辅助初稿 · 按次使用现有预算</summary>
            <p className="supply-muted">
              模型：{ai.model || "尚未配置"}
              。只使用已保存的观点和文字资料，不让模型虚构图片画面、经验或评论。生成结果仍待审阅。
            </p>
            <CheckboxField
              label="同意本次AI调用，使用设置中的模型与预算"
              checked={feeConsent}
              disabled={disabled || changed || !ai.configured}
              onChange={(event) => setFeeConsent(event.target.checked)}
            />
            <div className="row">
              <Button
                disabled={
                  disabled ||
                  changed ||
                  !feeConsent ||
                  !ai.configured ||
                  !e.angle ||
                  e.contribution.length < 10
                }
                onClick={() =>
                  void run(
                    "生成中",
                    () =>
                      ipc("contentSupply.generate", {
                        id: draft.id,
                        version: draft.version,
                        confirmed: true,
                      }),
                    "AI辅助初稿已保存，等待核对与审阅",
                  )
                }
              >
                {busy === "生成中" ? "生成中…" : "生成本次初稿"}
              </Button>
              <Button size="compact" onClick={() => openSettings("ai")}>
                模型与预算
              </Button>
            </div>
          </details>
        ) : null}
        {!immutable && !held ? (
          <details className="supply-details">
            <summary>暂不采用此素材</summary>
            <p className="supply-muted">
              不相关、资料不足或没有新增判断时，可以保留来源并结束当前编辑。
            </p>
            <Field label="暂不采用原因">
              <input
                aria-label="暂不采用原因"
                maxLength={2000}
                value={holdReason}
                disabled={disabled}
                onChange={(event) => setHoldReason(event.target.value)}
              />
            </Field>
            <Button
              size="compact"
              disabled={disabled || changed || !holdReason.trim()}
              onClick={() =>
                void run(
                  "暂存中",
                  () =>
                    ipc("contentSupply.hold", {
                      id: draft.id,
                      version: draft.version,
                      reason: holdReason,
                    }),
                  "已保留来源并标为暂不采用",
                )
              }
            >
              保留来源，暂不采用
            </Button>
          </details>
        ) : null}
        {!held ? (
          <SupplyDeliveryPanel
            key={`${e.accountId}:${changed}`}
            draft={draft}
            editorial={e}
            body={body}
            changed={changed}
            stale={stale}
            operations={operations}
            busy={busy}
            run={run}
            onOpenWeibo={onOpenWeibo}
          />
        ) : null}
      </Panel>
    </div>
  );
}
