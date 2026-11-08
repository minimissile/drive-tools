import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  tiebaTopicSourceSchema,
  type TiebaTopicSource,
  type TiebaTopicsSnapshot,
} from "../../shared/tieba-topics";
import type { TiebaAutocareTarget } from "../../shared/tieba-autocare";
import type { FeedbackMessage } from "../lib/feedback";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice, Status } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import {
  tiebaTopicCanReconcile,
  tiebaTopicEditable,
  tiebaTopicEditorView,
  tiebaTopicFormHash,
  tiebaTopicRuleView,
  tiebaTopicStatusKind,
  tiebaTopicStatusLabels,
  emptyTiebaTopicSource,
  type TiebaTopicForm,
} from "./topic-view";
import { tiebaTime } from "./view-model";

type Run = (
  operation: () => Promise<TiebaTopicsSnapshot>,
  message: string | ((value: TiebaTopicsSnapshot) => FeedbackMessage),
) => Promise<TiebaTopicsSnapshot | null>;
export function TopicEditor({
  workspace,
  editorKey,
  target,
  initialDraftId,
  snapshot,
  busy,
  error,
  close,
  run,
}: {
  workspace: string;
  editorKey: string;
  target: TiebaAutocareTarget;
  initialDraftId: string;
  snapshot: TiebaTopicsSnapshot;
  busy: boolean;
  error: string;
  close(): void;
  run: Run;
}) {
  const initial = snapshot.drafts.find((draft) => draft.id === initialDraftId);
  const empty = { title: "", body: "", source: emptyTiebaTopicSource };
  const local = useLocalDraft(
    `tieba-topic-editor:${workspace}:${target.id}:${editorKey}`,
    {
      id: initial?.id ?? "",
      title: initial?.title ?? "",
      body: initial?.body ?? "",
      source: initial?.source ?? emptyTiebaTopicSource,
      version: initial?.version ?? 0,
      base: tiebaTopicFormHash(initial ?? empty),
      tab: "content" as "content" | "source" | "rules",
    },
    (value) =>
      z
        .object({
          id: z.string().max(150),
          title: z.string().max(30),
          body: z.string().max(10000),
          source: tiebaTopicSourceSchema,
          version: z.number().int().min(0),
          base: z.string().max(100000),
          tab: z.enum(["content", "source", "rules"]),
        })
        .parse(value),
  );
  const current = snapshot.drafts.find(
    (draft) => draft.id === (initialDraftId || local.value.id),
  );
  const derived = tiebaTopicEditorView(local.value, current);
  const objectMissing = !!(initialDraftId || local.value.id) && !current;
  const editable = !objectMissing && tiebaTopicEditable(current),
    form = editable ? derived.form : (current ?? derived.form);
  const [rights, setRights] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const rule = snapshot.rules.find((rule) => rule.targetId === target.id);
  const signature = tiebaTopicFormHash(form);
  useEffect(() => {
    setRights(false);
  }, [signature, current?.version, rule?.version]);
  const update = (patch: Partial<TiebaTopicForm>) => {
    local.update({
      ...patch,
      base: derived.changed
        ? local.value.base
        : tiebaTopicFormHash(current ?? empty),
      version: derived.changed ? local.value.version : (current?.version ?? 0),
    });
    setRights(false);
  };
  const source = (patch: Partial<TiebaTopicSource>) =>
    update({ source: { ...form.source, ...patch } });
  const save = async () => {
    const result = await run(
      () =>
        ipc("tieba.topics.save", {
          ...(current ? { id: current.id, version: current.version } : {}),
          targetId: target.id,
          title: form.title,
          body: form.body,
          source: form.source,
        }),
      "主题草稿已保存，请检查就绪状态",
    );
    if (!result || !mounted.current) return;
    const saved = result.drafts.find(
      (draft) => draft.id === (current?.id ?? result.savedDraftId),
    );
    if (saved)
      local.update({
        id: saved.id,
        title: saved.title,
        body: saved.body,
        source: saved.source,
        version: saved.version,
        base: tiebaTopicFormHash(saved),
      });
    setRights(false);
  };
  const needsSave = derived.changed || !current;
  const disabled = busy || !editable;
  const reset = () => {
    if (!current) return;
    local.update({
      title: current.title,
      body: current.body,
      source: current.source,
      version: current.version,
      base: tiebaTopicFormHash(current),
    });
    setRights(false);
  };
  return (
    <Dialog
      title="主题创作与图文发布"
      className="tieba-topic-editor"
      onClose={close}
      focus="container"
      footer={
        <>
          <span className="tieba-console-scope">
            {target.name}吧 ·{" "}
            {snapshot.accounts.find(
              (account) => account.id === target.accountId,
            )?.alias ?? "贴吧账号"}
            {current?.submittedAt
              ? ` · 原提交 ${tiebaTime(current.submittedAt)}`
              : ""}
          </span>
          <Button onClick={close}>关闭</Button>
          {editable ? (
            <>
              <Button
                disabled={
                  busy ||
                  derived.stale ||
                  (!derived.changed && !!current && current.status === "ready")
                }
                data-testid="tieba-topic-save"
                onClick={() => void save()}
              >
                保存并检查
              </Button>
              <Button
                disabled={
                  busy ||
                  needsSave ||
                  derived.stale ||
                  !rights ||
                  !rule ||
                  !form.source.body.trim() ||
                  (current?.generationAttempts ?? 0) >= 2
                }
                data-testid="tieba-topic-generate"
                onClick={() =>
                  current &&
                  void run(
                    () =>
                      ipc("tieba.topics.generate", {
                        id: current.id,
                        version: current.version,
                        confirmed: true,
                        rightsConfirmed: true,
                      }),
                    (value) => {
                      const result = value.drafts.find(
                        (draft) => draft.id === current.id,
                      );
                      return {
                        text:
                          result?.message ??
                          "生成结果未完整返回，请查看原稿记录。",
                        tone:
                          result?.status === "ready"
                            ? "success"
                            : result?.status === "failed"
                              ? "error"
                              : "warning",
                      };
                    },
                  )
                }
              >
                AI生成主题
              </Button>
              <Button
                primary
                disabled={
                  busy ||
                  needsSave ||
                  derived.stale ||
                  !rights ||
                  current?.status !== "ready"
                }
                data-testid="tieba-topic-submit"
                onClick={() =>
                  current &&
                  void run(
                    () =>
                      ipc("tieba.topics.submit", {
                        id: current.id,
                        version: current.version,
                        confirmed: true,
                        rightsConfirmed: true,
                      }),
                    (value) => {
                      const result = value.drafts.find(
                        (draft) => draft.id === current.id,
                      );
                      return {
                        text:
                          result?.status === "verified"
                            ? "官网已核实主题，请在复盘查看后续可见性"
                            : (result?.message ??
                              "原提交结果已保留，请核实官网状态"),
                        tone:
                          result?.status === "verified" ? "success" : "warning",
                      };
                    },
                  )
                }
              >
                提交主题与图片
              </Button>
            </>
          ) : null}
          {current && tiebaTopicCanReconcile(current) ? (
            <Button
              primary
              disabled={busy}
              data-testid="tieba-topic-reconcile"
              onClick={() =>
                void run(
                  () => ipc("tieba.topics.reconcile", { id: current.id }),
                  (value) => {
                    const result = value.drafts.find(
                      (draft) => draft.id === current.id,
                    );
                    return {
                      text: result?.message ?? "原主题结果仍待核实。",
                      tone:
                        result?.status === "verified" ? "success" : "warning",
                    };
                  },
                )
              }
            >
              只读核实原主题
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Notice danger>{error}</Notice> : null}
      {objectMissing ? (
        <Notice warning>
          原主题记录暂不可用，本地输入已保留。请关闭后重新读取原稿，不会创建替代稿。
        </Notice>
      ) : null}
      {local.error ? <Notice warning>{local.error}</Notice> : null}
      {derived.stale && editable ? (
        <Notice warning>
          此稿已在其他窗口更新，当前文字已保留。请复制需要的修改或恢复已保存正文后再操作。
        </Notice>
      ) : null}
      {current && !editable ? (
        <Notice warning>
          {current.status === "uncertain" || current.status === "pending_review"
            ? "原主题可能已提交，正文与图片已锁定；只核实原结果，不会重复发布。"
            : current.status === "attention"
              ? "生成费用或中断结果待检查，保留原稿，不重复生成或提交。"
              : current.status === "verified"
                ? "官网已核实原主题；后续可见性在运营复盘单独记录。"
                : "当前正在处理原主题，请等待结果；关闭后记录仍保留。"}
        </Notice>
      ) : null}
      <div className="tieba-console-toolbar">
        <Select
          aria-label="主题编辑内容"
          value={local.value.tab}
          items={[
            { value: "content", label: "标题、正文与图片" },
            { value: "source", label: "本人材料与引用" },
            { value: "rules", label: "该吧发布规则" },
          ]}
          onValueChange={(tab) =>
            local.update({ tab: tab as typeof local.value.tab })
          }
        />
        {current ? (
          <Status kind={tiebaTopicStatusKind(current.status)}>
            {tiebaTopicStatusLabels[current.status]}
          </Status>
        ) : (
          <span className="muted">本窗口新草稿</span>
        )}
        {editable && current ? (
          <Button
            quiet
            size="compact"
            disabled={busy || (!derived.changed && !derived.stale)}
            onClick={reset}
          >
            恢复已保存正文
          </Button>
        ) : null}
      </div>
      {local.value.tab === "content" ? (
        <div className="tieba-topic-content-grid">
          <div className="tieba-topic-writing">
            <Field label="主题标题" hint="最多30字">
              <input
                aria-label="贴吧主题标题"
                maxLength={30}
                disabled={disabled}
                value={form.title}
                onChange={(event) => update({ title: event.target.value })}
                data-testid="tieba-topic-title"
              />
            </Field>
            <Field
              label="主题正文"
              hint="就绪发布至少80字，最多10000字；请审阅AI生成内容。"
            >
              <textarea
                rows={9}
                maxLength={10000}
                aria-label="贴吧主题正文"
                disabled={disabled}
                value={form.body}
                onChange={(event) => update({ body: event.target.value })}
                data-testid="tieba-topic-body"
              />
            </Field>
            <p className="tieba-console-description">
              {form.body.trim().length} 字
              {derived.changed ? " · 本窗口修改未保存" : " · 已保存正文"}
            </p>
          </div>
          <div className="tieba-topic-images">
            <div className="tieba-reply-section-heading">
              <h3>本地图片 · {current?.images.length ?? 0}/6</h3>
              <Button
                size="compact"
                disabled={
                  disabled ||
                  needsSave ||
                  (current?.images.length ?? 0) >= 6 ||
                  !rule?.allowImages
                }
                data-testid="tieba-topic-images"
                onClick={() =>
                  current &&
                  void (async () => {
                    setRights(false);
                    await run(
                      () =>
                        ipc("tieba.topics.pickImages", {
                          id: current.id,
                          version: current.version,
                        }),
                      (value) => {
                        const result = value.drafts.find(
                          (draft) => draft.id === current.id,
                        );
                        const changed =
                          JSON.stringify(
                            result?.images.map((image) => image.id),
                          ) !==
                          JSON.stringify(
                            current.images.map((image) => image.id),
                          );
                        return {
                          text: changed
                            ? "本地图片附件已保存，请重新核对使用权。"
                            : "图片附件未变化。",
                          tone: changed ? "success" : "info",
                        };
                      },
                    );
                  })()
                }
              >
                添加图片
              </Button>
            </div>
            <p className="tieba-console-description">
              PNG/JPG，每张小于10MB。图片保存在本地草稿；先保存文字，再调整图片。
              {rule?.allowImages ? "" : "当前吧规尚未确认允许图片。"}
            </p>
            {current?.images.length ? (
              <ul className="tieba-topic-image-list">
                {current.images.map((image) => (
                  <li key={image.id}>
                    <TopicImage
                      draftId={current.id}
                      imageId={image.id}
                      name={image.name}
                    />
                    <div>
                      <strong>{image.name}</strong>
                      <small>本地附件已保存</small>
                      {editable ? (
                        <Button
                          quiet
                          size="compact"
                          disabled={busy || needsSave}
                          onClick={() => {
                            setRights(false);
                            void run(
                              () =>
                                ipc("tieba.topics.removeImage", {
                                  id: current.id,
                                  version: current.version,
                                  imageId: image.id,
                                }),
                              "本地图片附件已移除",
                            );
                          }}
                        >
                          移除
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tieba-console-description">
                未添加图片，也可以发布纯文字主题。
              </p>
            )}
          </div>
        </div>
      ) : null}
      {local.value.tab === "source" ? (
        <div className="tieba-topic-source-form">
          <p className="tieba-console-description">
            提供本人创作或已获授权的原始材料。引用网址只作来源记录，不会自动采集或将网页内容视为本人作品。
          </p>
          <div className="tieba-console-form-row">
            <Field label="材料权属">
              <Select
                aria-label="主题材料权属"
                value={form.source.kind}
                disabled={disabled}
                items={[
                  { value: "owned", label: "本人创作材料" },
                  { value: "licensed", label: "已获授权材料" },
                ]}
                onValueChange={(kind) =>
                  source({ kind: kind as "owned" | "licensed" })
                }
              />
            </Field>
            <Field label="材料名称">
              <input
                aria-label="主题材料名称"
                maxLength={200}
                disabled={disabled}
                value={form.source.title}
                onChange={(event) => source({ title: event.target.value })}
              />
            </Field>
          </div>
          <Field
            label="原始材料正文"
            hint="保留可核实的具体依据，AI仅据此准备主题。"
          >
            <textarea
              aria-label="主题原始材料"
              rows={8}
              maxLength={20000}
              disabled={disabled}
              value={form.source.body}
              onChange={(event) => source({ body: event.target.value })}
              data-testid="tieba-topic-source-body"
            />
          </Field>
          <Field label="引用来源网址（可选）">
            <input
              aria-label="主题引用来源网址"
              maxLength={2000}
              disabled={disabled}
              value={form.source.sourceUrl}
              onChange={(event) => source({ sourceUrl: event.target.value })}
            />
          </Field>
          <Field label="权利与使用说明">
            <textarea
              aria-label="主题材料使用权说明"
              rows={2}
              maxLength={2000}
              disabled={disabled}
              value={form.source.rightsNote}
              onChange={(event) => source({ rightsNote: event.target.value })}
            />
          </Field>
        </div>
      ) : null}
      {local.value.tab === "rules" ? (
        <TopicRules
          key={target.id}
          workspace={workspace}
          target={target}
          rule={rule}
          busy={busy}
          run={run}
        />
      ) : null}
      {editable ? (
        <div className="tieba-topic-authorization">
          <p className="tieba-console-description">
            AI生成会调用当前文案模型并计入全局预算，每稿最多2次生成尝试。修改或恢复内容后需重新核对材料与规则。
          </p>
          <CheckboxField
            label="我已核对材料和图片的使用权，并确认当前内容符合该吧规则"
            checked={rights}
            disabled={busy}
            onChange={(event) => setRights(event.target.checked)}
            data-testid="tieba-topic-rights"
          />
          {needsSave ? (
            <small>先保存当前文字与材料，再生成、添加图片或提交。</small>
          ) : null}
          {!rule ? (
            <small>尚未保存该吧发布规则，请在“该吧发布规则”记录后继续。</small>
          ) : null}
        </div>
      ) : null}
      {current?.message ? (
        <p className="tieba-reply-message">{current.message}</p>
      ) : null}
      {current?.checks.length ? (
        <details className="tieba-console-details">
          <summary>程序检查 · {current.checks.length} 项</summary>
          <ul>
            {current.checks.map((check, index) => (
              <li key={index}>{check}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {current?.receipt ? (
        <details className="tieba-console-details" open>
          <summary>官网回执</summary>
          <p>{current.receipt.message}</p>
          <p>核实时间 {tiebaTime(current.receipt.checkedAt)}</p>
          {current.receipt.url ? (
            <Button
              quiet
              size="compact"
              onClick={() =>
                void ipc("system.copyText", { text: current.receipt!.url! })
              }
            >
              复制主题官网链接
            </Button>
          ) : null}
        </details>
      ) : null}
      {!editable && derived.changed ? (
        <details className="tieba-console-details">
          <summary>本窗口保留的未保存文字与材料</summary>
          <p className="tieba-console-description">
            原稿进入当前状态后，下方本地修改仍保留，可复制保存。
          </p>
          <pre>{JSON.stringify(derived.form, null, 2)}</pre>
          <Button
            size="compact"
            onClick={() =>
              void ipc("system.copyText", {
                text: JSON.stringify(derived.form, null, 2),
              })
            }
          >
            复制本窗口修改
          </Button>
        </details>
      ) : null}
    </Dialog>
  );
}

function TopicRules({
  workspace,
  target,
  rule,
  busy,
  run,
}: {
  workspace: string;
  target: TiebaAutocareTarget;
  rule: TiebaTopicsSnapshot["rules"][number] | undefined;
  busy: boolean;
  run: Run;
}) {
  const local = useLocalDraft(
    `tieba-topic-rules:${workspace}:${target.id}`,
    {
      note: rule?.note ?? "",
      allowImages: rule?.allowImages ?? false,
      version: rule?.version ?? 0,
      base: rule?.note ?? "",
      baseAllowImages: rule?.allowImages ?? false,
    },
    (value) =>
      z
        .object({
          note: z.string().max(2000),
          allowImages: z.boolean(),
          version: z.number().int().min(0),
          base: z.string().max(2000),
          baseAllowImages: z.boolean(),
        })
        .parse(value),
  );
  const { changed, stale, note, allowImages } = tiebaTopicRuleView(
    local.value,
    rule,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = (patch: Partial<{ note: string; allowImages: boolean }>) =>
    local.update({
      ...patch,
      version: changed ? local.value.version : (rule?.version ?? 0),
      base: changed ? local.value.base : (rule?.note ?? ""),
      baseAllowImages: changed
        ? local.value.baseAllowImages
        : (rule?.allowImages ?? false),
    });
  return (
    <div className="tieba-topic-rules">
      <p className="tieba-console-description">
        查看该吧官网公告后，记录允许的内容、图片与其他限制；此记录不代替官网规则。
      </p>
      <Button
        quiet
        size="compact"
        onClick={() => void ipc("system.copyText", { text: target.url })}
      >
        复制该吧官网首页链接
      </Button>
      {stale ? (
        <Notice warning>
          其他窗口更新了吧规，原输入已保留，请先恢复当前记录。
        </Notice>
      ) : null}
      <Field label="已核对的发布规则" hint="20–2000字，写明该吧实际要求。">
        <textarea
          rows={6}
          aria-label="贴吧发布规则"
          disabled={busy}
          maxLength={2000}
          value={note}
          onChange={(event) => update({ note: event.target.value })}
          data-testid="tieba-topic-rule-note"
        />
      </Field>
      <CheckboxField
        label="该吧规则允许发布图片"
        checked={allowImages}
        disabled={busy}
        onChange={(event) => update({ allowImages: event.target.checked })}
      />
      <div className="row compact">
        <Button
          disabled={busy || (!changed && !stale)}
          onClick={() =>
            local.update({
              note: rule?.note ?? "",
              base: rule?.note ?? "",
              allowImages: rule?.allowImages ?? false,
              version: rule?.version ?? 0,
              baseAllowImages: rule?.allowImages ?? false,
            })
          }
        >
          恢复已保存规则
        </Button>
        <Button
          disabled={busy || stale || note.trim().length < 20}
          data-testid="tieba-topic-rule-save"
          onClick={() =>
            void (async () => {
              const result = await run(
                () =>
                  ipc("tieba.topics.rule", {
                    targetId: target.id,
                    version: rule?.version ?? 0,
                    note,
                    allowImages,
                    confirmed: true,
                  }),
                "该吧规则已保存，旧稿需重新检查",
              );
              const saved = result?.rules.find(
                (item) => item.targetId === target.id,
              );
              if (saved && mounted.current)
                local.update({
                  note: saved.note,
                  base: saved.note,
                  allowImages: saved.allowImages,
                  version: saved.version,
                  baseAllowImages: saved.allowImages,
                });
            })()
          }
        >
          保存已核对规则
        </Button>
      </div>
      {local.error ? <Notice warning>{local.error}</Notice> : null}
    </div>
  );
}

function TopicImage({
  draftId,
  imageId,
  name,
}: {
  draftId: string;
  imageId: string;
  name: string;
}) {
  const [value, setValue] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void ipc("tieba.topics.image", { id: draftId, imageId })
      .then((value) => {
        if (current) setValue(value);
      })
      .catch(() => {
        if (current) setError("图片预览读取失败，原附件仍保留");
      });
    return () => {
      current = false;
    };
  }, [draftId, imageId]);
  return value ? (
    <img src={value} alt={name} />
  ) : (
    <span className="tieba-topic-image-placeholder">
      {error || "读取预览…"}
    </span>
  );
}
