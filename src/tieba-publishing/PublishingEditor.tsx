import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { FileText, RefreshCw, Save, Send, Undo2 } from "lucide-react";
import type { Command } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { writeDraft } from "../storage/local-draft";
import { windowStorage } from "../storage/window-storage";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  SearchField,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { TextSuggestions } from "../ui/TextSuggestions";
import { updateSelection } from "../lib/selection";
import { formatTime } from "../lib/format";
import type {
  TiebaPublishingDraft,
  TiebaPublishingResource,
  TiebaPublishingSnapshot,
} from "../../shared/tieba-publishing";
import { providerSchema } from "../../shared/schemas";
import { publishingStatus } from "./view";
import { ObserveForums } from "../tieba/ObserveForums";
import "../tieba/tieba.css";

const resourceSchema = z.object({
  resourceId: z.string(),
  copyId: z.string(),
  title: z.string(),
  summary: z.string(),
  provider: providerSchema,
  accountAlias: z.string(),
  url: z.string(),
  code: z.string(),
  resourceRevision: z.number(),
  shareVersion: z.number(),
  matchedTerms: z.array(z.string()),
});
const formSchema = z.object({
  baseVersion: z.number(),
  accountId: z.string(),
  targetId: z.string(),
  keyword: z.string(),
  keywordSourceId: z.string(),
  wordSource: z.enum(["all", "history", "pool"]).default("all"),
  copyIds: z.array(z.string()),
  resourceCache: z.array(resourceSchema).default([]),
  resourceQuery: z.string(),
  title: z.string(),
  body: z.string(),
  ruleNote: z.string(),
});
function initial(
  draft: TiebaPublishingDraft | undefined,
  snapshot: TiebaPublishingSnapshot,
): z.infer<typeof formSchema> {
  const first = snapshot.targets.find(
    (target) =>
      !target.paused &&
      snapshot.accounts.some(
        (account) =>
          account.id === target.accountId &&
          account.uid === target.uid &&
          account.status === "connected",
      ),
  );
  return {
    baseVersion: draft?.version ?? 0,
    accountId:
      draft?.accountId ?? first?.accountId ?? snapshot.accounts[0]?.id ?? "",
    targetId: draft?.targetId ?? first?.id ?? "",
    keyword: draft?.keyword ?? "",
    keywordSourceId: draft?.keywordSourceId ?? "manual",
    wordSource: "all",
    copyIds: draft?.resources.map((resource) => resource.copyId) ?? [],
    resourceCache: draft?.resources ?? [],
    resourceQuery: "",
    title: draft?.title ?? "",
    body: draft?.body ?? "",
    ruleNote: draft?.ruleNote ?? "",
  };
}
export function PublishingEditor({
  draft,
  snapshot,
  command,
  onSaved,
  formKey,
  onDirectoryChange,
  onNewDraft,
}: {
  formKey: string;
  onDirectoryChange(): void;
  onNewDraft?(): void;
  draft?: TiebaPublishingDraft;
  snapshot: TiebaPublishingSnapshot;
  command: Command;
  onSaved(value: TiebaPublishingSnapshot): void;
}) {
  const { data } = useAppData();
  const { notify } = useAppActions();
  const { navigate } = useAppNavigation();
  const storageKey = (key: string) =>
    `panxu-tieba-publishing-form-v1:${data!.dataPath}:${key}`;
  const form = useLocalDraft(
    storageKey(formKey),
    initial(draft, snapshot),
    (value) => formSchema.parse(value),
  );
  const { value, update: updateForm } = form;
  const latestValue = useRef(value);
  latestValue.current = value;
  const update = (patch: Partial<typeof value>) => {
    latestValue.current = { ...latestValue.current, ...patch };
    updateForm(patch);
  };
  const [workingAction, setWorkingAction] = useState<
    "save" | "submit" | "reconcile" | null
  >(null);
  const working = workingAction !== null;
  const operationActive = useRef(false);
  const [preview, setPreview] = useState(false);
  const [templateUndo, setTemplateUndo] = useState<{
    before: { title: string; body: string };
    filled: { title: string; body: string };
  } | null>(null);
  const wordSource = value.wordSource;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setTemplateUndo(null);
    if (
      draft &&
      (latestValue.current.accountId !== draft.accountId ||
        latestValue.current.targetId !== draft.targetId)
    )
      update({ accountId: draft.accountId, targetId: draft.targetId });
  }, [draft?.id, draft?.version, formKey]);
  useEffect(() => {
    if (
      templateUndo &&
      (value.title !== templateUndo.filled.title ||
        value.body !== templateUndo.filled.body)
    )
      setTemplateUndo(null);
  }, [templateUndo, value.title, value.body]);
  const busy = working || snapshot.busy;
  const submitted =
    !!draft &&
    ["submitting", "verified", "pending_review", "uncertain"].includes(
      draft.status,
    );
  const words = useIpcQuery(
    "tieba.publishing.words",
    { query: value.keyword, source: value.wordSource },
    { delay: 180 },
  );
  const directory = useIpcQuery("tieba.autocare.snapshot", undefined, {
    keepPrevious: true,
  });
  const resources = useIpcQuery(
    "tieba.publishing.resources",
    { query: value.resourceQuery || value.keyword },
    { delay: 180, keepPrevious: true },
  );
  const resourceMap = new Map(
    [
      ...value.resourceCache,
      ...(draft?.resources ?? []),
      ...(resources.data ?? []),
    ].map((resource) => [resource.copyId, resource]),
  );
  const selectedResources = value.copyIds.flatMap((id) =>
    resourceMap.get(id) ? [resourceMap.get(id)!] : [],
  );
  const targets = snapshot.targets.filter(
    (target) =>
      target.accountId === value.accountId &&
      !target.paused &&
      snapshot.accounts.some(
        (account) =>
          account.id === target.accountId && account.uid === target.uid,
      ),
  );
  const stale = !!draft && value.baseVersion !== draft.version;
  const changed =
    !draft ||
    value.targetId !== draft.targetId ||
    value.keyword !== draft.keyword ||
    value.keywordSourceId !== draft.keywordSourceId ||
    value.title !== draft.title ||
    value.body !== draft.body ||
    value.ruleNote !== draft.ruleNote ||
    value.copyIds.join("\n") !==
      draft.resources.map((resource) => resource.copyId).join("\n");
  const chooseWord = (keyword: string, id?: string) => {
    update({
      keyword,
      keywordSourceId:
        id ?? words.data?.find((word) => word.word === keyword)?.id ?? "manual",
    });
  };
  const run = async (
    action: () => Promise<TiebaPublishingSnapshot | undefined>,
    operation: "save" | "submit" | "reconcile" = "save",
  ) => {
    if (operationActive.current) return;
    operationActive.current = true;
    const requested = latestValue.current;
    setWorkingAction(operation);
    try {
      const result = await action();
      if (result && alive.current) {
        const saved = result.drafts.find(
          (item) => item.id === (result.savedDraftId ?? draft?.id),
        );
        if (saved) {
          const latest = latestValue.current;
          const patch: Partial<typeof value> = { baseVersion: saved.version };
          if (operation !== "reconcile") {
            for (const field of [
              "accountId",
              "targetId",
              "keyword",
              "keywordSourceId",
              "title",
              "body",
              "ruleNote",
            ] as const)
              if (latest[field] === requested[field])
                patch[field] = saved[field];
            if (latest.copyIds.join("\n") === requested.copyIds.join("\n")) {
              patch.copyIds = saved.resources.map(
                (resource) => resource.copyId,
              );
              patch.resourceCache = saved.resources;
            }
          }
          const nextValue = { ...latest, ...patch };
          update(patch);
          // A first save changes the editor key; retain local filters and newer input.
          if (
            saved.id !== formKey &&
            !writeDraft(windowStorage, storageKey(saved.id), nextValue)
          )
            notify(
              "稿件已保存，但本机暂存不可用；搜索条件和未保存修改可能无法恢复。",
              "warning",
            );
        }
        onSaved(result);
        notify(
          saved?.message ||
            (operation === "save"
              ? "稿件已保存，请查看检查结果。"
              : "官网原结果尚待核对。"),
          saved?.status === "verified" ||
            (operation === "save" && saved?.status === "ready")
            ? "success"
            : saved?.status === "pending_review"
              ? "info"
              : "warning",
        );
      }
    } finally {
      operationActive.current = false;
      if (alive.current) setWorkingAction(null);
    }
  };
  const saveCurrent = () => {
    const current = latestValue.current;
    return command("tieba.publishing.save", {
      ...(draft ? { id: draft.id, version: current.baseVersion } : {}),
      targetId: current.targetId,
      keyword: current.keyword,
      keywordSourceId: current.keywordSourceId,
      copyIds: current.copyIds,
      title: current.title,
      body: current.body,
      ruleNote: current.ruleNote,
    });
  };
  const publishCurrent = async () => {
    const requested = latestValue.current;
    let prepared = draft;
    let savedSnapshot: TiebaPublishingSnapshot | undefined;
    if (!prepared || changed || prepared.status !== "ready") {
      savedSnapshot = await saveCurrent();
      if (!savedSnapshot || !alive.current) return;
      prepared = savedSnapshot.drafts.find(
        (item) => item.id === savedSnapshot!.savedDraftId,
      );
      if (!prepared || prepared.status !== "ready") return savedSnapshot;
      const latest = latestValue.current;
      const sameContent =
        (
          [
            "targetId",
            "keyword",
            "keywordSourceId",
            "title",
            "body",
            "ruleNote",
          ] as const
        ).every((field) => latest[field] === requested[field]) &&
        latest.copyIds.join("\n") === requested.copyIds.join("\n");
      if (!sameContent) {
        notify("稿件已保存；当前内容有新修改，尚未发布。", "warning");
        return savedSnapshot;
      }
    }
    if (!alive.current) return;
    const result = await command("tieba.publishing.submit", {
      id: prepared.id,
      version: prepared.version,
      confirmed: true,
    });
    return result ? { ...result, savedDraftId: prepared.id } : savedSnapshot;
  };
  const hasSelection =
    !!value.targetId && !!value.keyword.trim() && value.copyIds.length > 0;
  const canPublish =
    hasSelection &&
    value.title.trim().length >= 3 &&
    value.body.trim().length >= 80;
  const targetName =
    targets.find((target) => target.id === value.targetId)?.name ??
    draft?.forumName ??
    "所选贴吧";
  const fillTemplate = () => {
    const title =
      `${value.keyword || selectedResources[0]?.title || "资料"}资料整理`.slice(
        0,
        30,
      );
    const body = [
      `围绕“${value.keyword || "学习资料"}”整理了以下资源，供有需要的吧友查阅。`,
      ...selectedResources.map(
        (resource, index) =>
          `${index + 1}. ${resource.title}\n${resource.summary ? `资料说明：${resource.summary.slice(0, 500)}\n` : ""}网盘链接：${resource.url}${resource.code ? `\n提取码：${resource.code}` : ""}`,
      ),
      "资料内容请以链接中的实际文件为准；如有整理建议，欢迎在本帖补充。",
    ].join("\n\n");
    setTemplateUndo((previous) => ({
      before:
        previous &&
        value.title === previous.filled.title &&
        value.body === previous.filled.body
          ? previous.before
          : { title: value.title, body: value.body },
      filled: { title, body },
    }));
    update({ title, body });
  };
  const undoTemplate = () => {
    if (
      !templateUndo ||
      value.title !== templateUndo.filled.title ||
      value.body !== templateUndo.filled.body
    )
      return;
    update(templateUndo.before);
    setTemplateUndo(null);
  };
  const sourceWords = (words.data ?? []).filter(
    (word) =>
      wordSource === "all" ||
      (wordSource === "pool"
        ? word.id.startsWith("pool:")
        : !word.id.startsWith("pool:")),
  );
  return (
    <>
      <Panel
        title={draft ? "编辑资源帖子" : "准备一篇资源帖子"}
        extra={
          <div className="row">
            {directory.data ? (
              <ObserveForums
                snapshot={directory.data}
                workspace={`${data!.dataPath}:publishing-targets`}
                busy={busy}
                initialAccountId={value.accountId}
                purpose="publishing"
                receive={(result) => {
                  directory.setData(result);
                  onDirectoryChange();
                }}
                reload={() => {
                  directory.reload();
                  onDirectoryChange();
                }}
              />
            ) : null}
            {draft ? (
              <Status kind={publishingStatus(draft.status).kind}>
                {publishingStatus(draft.status).label}
              </Status>
            ) : (
              <small>编辑完成后直接发布</small>
            )}
          </div>
        }
      >
        <QueryError
          error={directory.error}
          loading={directory.loading}
          onRetry={directory.reload}
        />
        <div className="tieba-publishing-fields">
          <Field label="贴吧账号" as="div" required>
            <Select
              aria-label="资源发帖账号"
              value={value.accountId}
              disabled={busy || submitted || !!draft}
              items={snapshot.accounts.map((account) => ({
                value: account.id,
                label: `${account.alias} · ${account.status === "connected" ? "已连接" : "待核验"}`,
              }))}
              onValueChange={(accountId) => {
                update({ accountId, targetId: "" });
              }}
            />
          </Field>
          <Field label="发布贴吧" as="div" required>
            <Select
              aria-label="资源发帖目标贴吧"
              value={value.targetId}
              disabled={busy || submitted || !!draft}
              items={[
                { value: "", label: "选择目标贴吧", disabled: true },
                ...targets.map((target) => ({
                  value: target.id,
                  label: target.name,
                })),
              ]}
              onValueChange={(targetId) => {
                update({ targetId });
              }}
            />
          </Field>
        </div>
        {draft ? (
          <div className="tieba-publishing-target-note">
            <small>更换账号或贴吧，请新建稿件。</small>
            {onNewDraft ? (
              <Button quiet size="compact" disabled={busy} onClick={onNewDraft}>
                新建稿件
              </Button>
            ) : null}
          </div>
        ) : null}
        {!targets.length ? (
          <Notice warning>
            该账号还没有可用目标贴吧。
            <Button
              quiet
              size="compact"
              onClick={() => navigate("tieba-autocare")}
            >
              去添加目标
            </Button>
          </Notice>
        ) : null}
        <div className="tieba-publishing-word-heading">
          <Field label="目标流量词" required>
            <TextSuggestions
              aria-label="资源发帖流量词"
              value={value.keyword}
              maxLength={100}
              disabled={busy || submitted}
              items={sourceWords.map((word) => ({
                value: word.word,
                label: word.word,
              }))}
              onValueChange={(keyword) => chooseWord(keyword)}
              placeholder="输入选题，或从本地词记录选择"
            />
          </Field>
          <Field label="词来源" as="div">
            <Select
              aria-label="流量词来源"
              value={wordSource}
              items={[
                ["all", "全部来源"],
                ["history", "历史流量词"],
                ["pool", "本地词池"],
              ].map(([value, label]) => ({ value, label }))}
              onValueChange={(source) =>
                update({ wordSource: source as "all" | "history" | "pool" })
              }
            />
          </Field>
        </div>
        <QueryError
          error={words.error}
          loading={words.loading}
          onRetry={words.reload}
        />
        {!words.data && !words.error ? (
          <LoadingState compact label="正在读取本地流量词…" />
        ) : sourceWords.length ? (
          <div className="tieba-publishing-words" aria-label="资源发帖词候选">
            {sourceWords.slice(0, 3).map((word) => (
              <button
                type="button"
                key={word.id}
                title={`${word.word}\n${word.source}`}
                disabled={busy || submitted}
                aria-pressed={value.keywordSourceId === word.id}
                onClick={() => chooseWord(word.word, word.id)}
              >
                <strong>{word.word}</strong>
                <small>
                  {word.id.startsWith("pool:") ? "本地词池" : "历史流量词"} ·{" "}
                  {word.source}
                </small>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">没有匹配的本地词，可直接使用已确定的选题。</p>
        )}
        <p className="muted tieba-publishing-source-note">
          本地词池用于选题，网盘资料从资源库选择。流量指标保留原始来源，不代表贴吧站内搜索量。
        </p>
      </Panel>
      <Panel
        title="选择网盘资源"
        extra={<small>已选 {value.copyIds.length} / 10 份</small>}
      >
        <SearchField
          label="搜索发帖资源"
          value={value.resourceQuery}
          onChange={(resourceQuery) => update({ resourceQuery })}
          placeholder="按资源标题、标签或文件名搜索；留空按流量词匹配"
        />
        <QueryError
          error={resources.error}
          loading={resources.loading}
          onRetry={resources.reload}
        />
        {!resources.data && !resources.error ? (
          <LoadingState compact label="正在匹配资源库…" />
        ) : resources.data?.length ? (
          <div
            className="tieba-publishing-resources"
            aria-label="可发布网盘资源"
          >
            {resources.data.map((resource) => (
              <label
                className="tieba-publishing-resource"
                key={resource.copyId}
              >
                <input
                  type="checkbox"
                  aria-label={`选择资源 ${resource.title}`}
                  checked={value.copyIds.includes(resource.copyId)}
                  disabled={
                    busy ||
                    submitted ||
                    (!value.copyIds.includes(resource.copyId) &&
                      value.copyIds.length >= 10)
                  }
                  onChange={(event) => {
                    {
                      const copyIds = updateSelection(
                        value.copyIds,
                        [resource.copyId],
                        event.target.checked,
                        10,
                      );
                      update({
                        copyIds,
                        resourceCache: copyIds.flatMap((id) =>
                          resourceMap.get(id) ? [resourceMap.get(id)!] : [],
                        ),
                      });
                    }
                  }}
                />
                <span>
                  <strong>{resource.title}</strong>
                  <small>
                    {resource.accountAlias} · {resource.url}
                  </small>
                  {resource.summary ? <p>{resource.summary}</p> : null}
                </span>
              </label>
            ))}
          </div>
        ) : resources.data ? (
          <Empty compact title="没有匹配的已核验本人资源">
            可调整搜索词，或先在资源库准备已有分享链接的本人资源。
          </Empty>
        ) : null}
        {value.copyIds.length ? (
          <div className="tieba-publishing-selected" aria-label="已选发帖资源">
            {value.copyIds.map((id) => (
              <span key={id}>
                {resourceMap.get(id)?.title ?? "已选资源（当前搜索未返回）"}
                <Button
                  quiet
                  size="compact"
                  disabled={busy || submitted}
                  aria-label={`移除资源 ${resourceMap.get(id)?.title ?? id}`}
                  onClick={() => {
                    update({
                      copyIds: value.copyIds.filter((item) => item !== id),
                      resourceCache: value.resourceCache.filter(
                        (item) => item.copyId !== id,
                      ),
                    });
                  }}
                >
                  移除
                </Button>
              </span>
            ))}
          </div>
        ) : null}
        <p className="muted">
          使用资源库已有的本人网盘分享链接和提取码。选择资料不会转存、建链或调用付费服务。
        </p>
      </Panel>
      <Panel
        title="正文与发布预览"
        extra={
          <div className="row">
            <Button
              size="compact"
              disabled={
                busy ||
                submitted ||
                !selectedResources.length ||
                selectedResources.length !== value.copyIds.length
              }
              onClick={fillTemplate}
            >
              <FileText size={14} />
              用所选资源填充正文
            </Button>
            <Button
              size="compact"
              aria-pressed={preview}
              onClick={() => setPreview((value) => !value)}
            >
              {preview ? "返回编辑" : "查看预览"}
            </Button>
          </div>
        }
      >
        {templateUndo ? (
          <div className="tieba-publishing-fill-feedback" role="status">
            <small>已填充标题和正文，尚未保存。</small>
            <Button
              quiet
              size="compact"
              disabled={busy || submitted}
              onClick={undoTemplate}
            >
              <Undo2 size={14} />
              撤销填充
            </Button>
          </div>
        ) : null}
        {preview ? (
          <article className="tieba-publishing-preview">
            <h3>{value.title || "尚未填写标题"}</h3>
            <div>{value.body || "尚未填写正文"}</div>
          </article>
        ) : (
          <>
            <Field label="帖子标题" required hint="3–30字">
              <input
                aria-label="资源帖子标题"
                maxLength={30}
                value={value.title}
                disabled={busy || submitted}
                onChange={(event) => {
                  setTemplateUndo(null);
                  update({ title: event.target.value });
                }}
              />
            </Field>
            <Field
              label="帖子正文"
              required
              hint="80–10000字，只保留本次所选资源的分享链接"
            >
              <textarea
                aria-label="资源帖子正文"
                className="tieba-publishing-body"
                maxLength={10000}
                value={value.body}
                disabled={busy || submitted}
                onChange={(event) => {
                  setTemplateUndo(null);
                  update({ body: event.target.value });
                }}
              />
            </Field>
            <Field label="本吧发布备注" hint="可记录吧规、内容说明和已核对事项">
              <textarea
                aria-label="资源帖子发布备注"
                maxLength={2000}
                value={value.ruleNote}
                disabled={busy || submitted}
                onChange={(event) => {
                  update({ ruleNote: event.target.value });
                }}
              />
            </Field>
          </>
        )}
        {form.error ? <Notice warning>{form.error}</Notice> : null}
        {stale ? (
          <Notice warning>
            稿件已在其他窗口更新，当前未保存内容仍保留。
            <Button
              quiet
              size="compact"
              disabled={busy}
              onClick={() => {
                setTemplateUndo(null);
                update(initial(draft, snapshot));
              }}
            >
              载入已保存版本
            </Button>
          </Notice>
        ) : null}
        {draft?.message ? (
          <Notice
            warning={
              draft.status === "uncertain" || draft.status === "pending_review"
            }
          >
            {draft.message}
          </Notice>
        ) : null}
        {draft?.checks.length ? (
          <ul className="tieba-publishing-checks">
            {draft.checks.map((check, index) => (
              <li key={index}>{check}</li>
            ))}
          </ul>
        ) : null}
        {!submitted ? (
          <div className="tieba-publishing-actions">
            <small className="tieba-publishing-action-status">
              {draft ? (
                <>
                  已保存 · {formatTime(draft.updatedAt)}
                  {changed ? " · 有未保存修改" : ""}
                </>
              ) : (
                "发布时自动保存并检查当前内容。"
              )}
            </small>
            <div className="tieba-publishing-action-buttons">
              <Button
                disabled={busy || stale || !hasSelection}
                onClick={() => void run(saveCurrent)}
              >
                <Save size={14} />
                {workingAction === "save" ? "正在保存…" : "保存草稿"}
              </Button>
              <Button
                primary
                disabled={busy || stale || !canPublish}
                onClick={() => void run(publishCurrent, "submit")}
              >
                <Send size={14} />
                {workingAction === "submit"
                  ? "正在发布…"
                  : `发布到${targetName}`}
              </Button>
            </div>
          </div>
        ) : (
          <div className="tieba-publishing-actions">
            {draft && ["uncertain", "pending_review"].includes(draft.status) ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      command("tieba.publishing.reconcile", { id: draft.id }),
                    "reconcile",
                  )
                }
              >
                <RefreshCw size={14} />
                核对原发布结果
              </Button>
            ) : null}
            {draft?.receipt?.url ? (
              <Button
                onClick={() =>
                  void command("system.external", { url: draft.receipt!.url! })
                }
              >
                在官网查看帖子
              </Button>
            ) : null}
          </div>
        )}
      </Panel>
    </>
  );
}
