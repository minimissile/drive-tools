import { AiIcon } from "../ui/AiIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  CopyPlus,
  ExternalLink,
  Eye,
  History,
  Maximize2,
  Save,
  Send,
  Tags,
} from "lucide-react";
import type { WechatDetail, WechatText } from "../../shared/wechat";
import { wechatPreviewHtml } from "./image-preview";
import {
  defaultWechatRewriteStyle,
  wechatRewriteStyleSchema,
} from "../../shared/wechat-rewrite";
import {
  planWechatTrafficWords,
  wechatTrafficWordUsage,
  type WechatTrafficWords,
} from "../../shared/wechat-traffic-words";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import {
  Button,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import {
  ArticleResources,
  type ArticleResourceActions,
} from "../articles/ArticleResources";
import { ArticleImages } from "./ArticleImages";
import { ArticleComparison } from "./ArticleComparison";
import { ArticleRewriteDialog } from "./ArticleRewriteDialog";
import { TrafficWordsDialog } from "./TrafficWordsDialog";
import { RewriteStyleBadge } from "./RewriteStyleBadge";
import { stageLabel } from "./labels";
import { linkifyWechatMarkdown } from "../../shared/wechat-markup";
import { ArticleEditionsDialog } from "./ArticleEditionsDialog";
const actions: ArticleResourceActions<WechatDetail> = {
  sync: (id) => ipc("wechat.syncLinks", { id }),
  bind: (id, linkId, copyId) =>
    ipc("wechat.bindResource", { id, linkId, copyId }),
  create: (id, linkId, accountId) =>
    ipc("wechat.resource", { id, linkId, accountId }),
};
const text = (article: WechatText) => ({
  title: article.title,
  body: article.body,
  author: article.author,
  digest: article.digest,
  coverUrl: article.coverUrl,
});
const editorSchema = z.object({
  title: z.string().max(200),
  body: z.string().max(200000),
  author: z.string().max(200),
  digest: z.string().max(500),
  coverUrl: z.string().max(4000),
  coverAddress: z.string().max(4000).nullable().default(null),
  imageAddress: z.string().max(4000).nullable().default(null),
  revision: z.number().int().positive(),
  textEdited: z.boolean().optional(),
  tab: z.enum(["body", "resources", "images"]),
  instruction: z.string().max(1000),
  styleId: wechatRewriteStyleSchema.default(defaultWechatRewriteStyle),
  accountId: z.string().max(100),
});
type EditorTab = z.infer<typeof editorSchema>["tab"];
type ActionError = {
  target: "editor" | "delivery" | "rewrite";
  message: string;
};
const emptyTrafficWords: WechatTrafficWords = { words: [], revision: 0 };

export function ArticleEditor({
  initial,
  onChanged,
  onBusy,
  onSelect,
}: {
  initial: WechatDetail;
  onChanged(): void;
  onBusy(value: boolean): void;
  onSelect(id: string): void;
}) {
  const { data } = useAppData(),
    { notify } = useAppActions(),
    { navigate } = useAppNavigation();
  const [detail, setDetail] = useState(initial),
    [pending, setPending] = useState(""),
    [error, setError] = useState<ActionError | null>(null),
    [resourceBusy, setResourceBusy] = useState(false),
    [preview, setPreview] = useState(false),
    [comparisonOpen, setComparisonOpen] = useState(false),
    [rewriteOpen, setRewriteOpen] = useState(false),
    [trafficWordsOpen, setTrafficWordsOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [deliveryOpen, setDeliveryOpen] = useState(false);
  const article = detail.article;
  const trafficWords = article.trafficWords ?? emptyTrafficWords;
  const trafficWordPlan =
    detail.trafficWordPlan ?? planWechatTrafficWords(trafficWords.words);
  const draft = useLocalDraft(
    `panxu:wechat:${data!.dataPath}:${article.id}:editor`,
    {
      ...text(article),
      coverAddress: null as string | null,
      imageAddress: null as string | null,
      revision: article.revision,
      textEdited: false as boolean | undefined,
      tab: "body" as EditorTab,
      instruction: "",
      styleId: article.rewriteStyleId ?? defaultWechatRewriteStyle,
      accountId: article.remote?.accountId || "",
    },
    (v) => editorSchema.parse(v),
  );
  const accounts = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
  });
  const available = accounts.data?.filter((a) => a.provider === "wechat") ?? [];
  const accountId =
    article.remote?.accountId ||
    article.pendingAccount?.id ||
    available.find((a) => a.id === draft.value.accountId)?.id ||
    available.find((a) => a.status === "connected")?.id ||
    available[0]?.id ||
    "";
  const account = available.find((a) => a.id === accountId);
  const dirty =
    draft.value.textEdited !== false &&
    JSON.stringify(text(draft.value)) !== JSON.stringify(text(article));
  const wordUsage = useMemo(
    () =>
      wechatTrafficWordUsage(
        trafficWords.words,
        draft.value.title,
        draft.value.body,
      ),
    [trafficWords.words, draft.value.title, draft.value.body],
  );
  const busy = !!pending || resourceBusy,
    editable = !["sending", "uncertain"].includes(article.stage);
  const conflict = draft.value.revision !== article.revision && dirty;
  const synced = !dirty && article.remote?.revision === article.revision;
  const uncertain = article.stage === "uncertain";
  const missingCover = !draft.value.coverUrl.trim();
  const missingLinks =
    draft.value.body === article.body &&
    article.links.some((link) => !link.copyId || !link.ownUrl);
  const sendBlocked =
    missingCover ||
    missingLinks ||
    (!dirty && detail.issues.some((issue) => issue.severity === "error"));
  const lock = useRef(false),
    editionRequest = useRef<string | null>(null),
    alive = useRef(true),
    received = useRef(initial),
    rewriteButton = useRef<HTMLButtonElement>(null),
    editorTabs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    if (
      busy ||
      !editable ||
      draft.value.textEdited !== false ||
      draft.value.revision !== article.revision
    )
      return;
    const body = linkifyWechatMarkdown(draft.value.body);
    if (body !== draft.value.body) draft.update({ body, textEdited: true });
  }, [
    busy,
    editable,
    article.revision,
    draft.value.body,
    draft.value.textEdited,
    draft.value.revision,
    draft.update,
  ]);
  useEffect(() => {
    let latest = article;
    if (!busy && received.current !== initial) {
      received.current = initial;
      const next = initial.article;
      if (
        next.revision >= article.revision &&
        (next.trafficWords?.revision ?? 0) >=
          (article.trafficWords?.revision ?? 0) &&
        next.updatedAt >= article.updatedAt
      ) {
        latest = next;
        setDetail(initial);
      }
    }
    if (
      !dirty &&
      (draft.value.revision !== latest.revision ||
        draft.value.textEdited === true)
    )
      draft.update({
        ...text(latest),
        revision: latest.revision,
        textEdited: false,
      });
  }, [
    initial,
    busy,
    article,
    dirty,
    draft.value.revision,
    draft.value.textEdited,
    draft.update,
  ]);
  const update = (patch: Partial<WechatText>) => {
    draft.update({ ...patch, textEdited: true });
  };
  const apply = (next: WechatDetail) => {
    if (!alive.current) return;
    setDetail(next);
    draft.update({
      ...text(next.article),
      revision: next.article.revision,
      textEdited: false,
    });
    onChanged();
  };
  const saved = async () => {
    if (!dirty) return detail;
    const next = await ipc("wechat.save", {
      id: article.id,
      revision: draft.value.revision,
      ...text(draft.value),
      body: linkifyWechatMarkdown(draft.value.body),
    });
    apply(next);
    return next;
  };
  const run = async (
    label: string,
    action: () => Promise<WechatDetail>,
    success?: string,
    target: ActionError["target"] = "editor",
  ) => {
    if (lock.current || resourceBusy) return;
    lock.current = true;
    setPending(label);
    setError(null);
    try {
      const next = await action();
      apply(next);
      if (alive.current && next.article.stage === "uncertain")
        setDeliveryOpen(true);
      else if (success && alive.current) notify(success, "success");
    } catch (cause) {
      if (alive.current)
        setError({
          target,
          message:
            cause instanceof Error ? cause.message : "操作未完成，请重试。",
        });
    } finally {
      lock.current = false;
      if (alive.current) setPending("");
    }
  };
  const send = () =>
    void run(
      "发送到微信草稿箱",
      async () => {
        const current = await saved();
        const next = await ipc("wechat.send", {
          id: article.id,
          revision: current.article.revision,
          accountId,
          confirmed: true,
        });
        if (alive.current && next.article.stage === "synced")
          setDeliveryOpen(false);
        return next;
      },
      "已保存到微信草稿箱，请到微信后台预览后发文。",
      deliveryOpen ? "delivery" : "editor",
    );
  const createEdition = async () => {
    if (lock.current || resourceBusy) return;
    lock.current = true;
    setPending("创建新稿");
    setError(null);
    try {
      editionRequest.current ??= crypto.randomUUID();
      const next = await ipc("wechat.newEdition", {
        id: article.id,
        revision: draft.value.revision,
        requestId: editionRequest.current,
        text: {
          ...text(draft.value),
          body: linkifyWechatMarkdown(draft.value.body),
        },
      });
      if (alive.current) {
        editionRequest.current = null;
        onChanged();
        onSelect(next.article.id);
        notify(
          `已创建第 ${next.article.edition?.number ?? 2} 稿，可继续改写、换图或保存为新微信草稿。`,
          "success",
        );
      }
    } catch (cause) {
      if (alive.current)
        setError({
          target: "editor",
          message:
            cause instanceof Error ? cause.message : "新稿创建失败，请重试。",
        });
    } finally {
      lock.current = false;
      if (alive.current) setPending("");
    }
  };
  const openTab = (tab: EditorTab) => {
    setDeliveryOpen(false);
    draft.update({ tab });
    requestAnimationFrame(() => {
      const selectedTab = editorTabs.current?.querySelector<HTMLButtonElement>(
        '[role="tab"][aria-selected="true"]',
      );
      selectedTab?.scrollIntoView({ block: "nearest" });
      selectedTab?.focus({ preventScroll: true });
    });
  };
  return (
    <div className="wechat-editor">
      <div className="wechat-editor-bar">
        <div className="wechat-editor-status" role="status">
          <span>第 {article.edition?.number ?? 1} 稿</span>
          <RewriteStyleBadge styleId={article.rewriteStyleId} showLabel />
          <Status
            kind={
              article.stage === "uncertain"
                ? "warning"
                : article.stage === "synced"
                  ? "good"
                  : "normal"
            }
          >
            {stageLabel[article.stage]}
          </Status>
          <span>
            {pending
              ? `正在${pending}…`
              : dirty
                ? draft.error
                  ? "编辑尚未保存"
                  : "编辑已在本窗口暂存"
                : "本地已保存"}
          </span>
          {trafficWords.words.length ? (
            <span>
              已用 {wordUsage.used.length}/{trafficWords.words.length} 个流量词
            </span>
          ) : null}
          {account ? (
            <span>目标公众号：{account.nickname || account.alias}</span>
          ) : null}
        </div>
        <div className="wechat-editor-actions">
          {available.length > 1 &&
          !article.remote &&
          !article.pendingAccount ? (
            <Select
              className="wechat-account-select"
              aria-label="目标公众号"
              value={accountId}
              disabled={busy}
              items={available.map((a) => ({
                value: a.id,
                label: `${a.nickname || a.alias}${a.status !== "connected" ? " · 需登录" : ""}`,
              }))}
              onValueChange={(accountId) => draft.update({ accountId })}
            />
          ) : null}
          <Button
            quiet
            disabled={busy || !editable}
            aria-haspopup="dialog"
            onClick={() => setTrafficWordsOpen(true)}
          >
            <Tags size={14} /> 流量词
            {trafficWords.words.length
              ? `（${trafficWords.words.length}）`
              : ""}
          </Button>
          <Button
            ref={rewriteButton}
            disabled={busy || !editable || conflict}
            aria-haspopup="dialog"
            onClick={() => {
              setError(null);
              setRewriteOpen(true);
            }}
          >
            <AiIcon size={14} /> AI 改写
          </Button>
          <Button
            disabled={busy || !editable || !dirty || conflict}
            onClick={() => void run("保存本地草稿", saved, "本地草稿已保存。")}
          >
            <Save size={14} />
            保存本地草稿
          </Button>
          <Button
            disabled={busy || !editable || conflict}
            onClick={() => void createEdition()}
          >
            <CopyPlus size={14} />
            {pending === "创建新稿" ? "正在创建…" : "再发一篇"}
          </Button>
          <Button
            primary
            disabled={busy}
            onClick={() => {
              if (uncertain || synced || sendBlocked || conflict || !accountId)
                setDeliveryOpen(true);
              else send();
            }}
          >
            <Send size={14} />
            {pending === "发送到微信草稿箱"
              ? "正在保存到微信…"
              : uncertain
                ? "核对保存结果"
                : synced
                  ? "查看微信草稿"
                  : article.remote
                    ? "更新本次微信草稿"
                    : "保存为新微信草稿"}
          </Button>
        </div>
      </div>
      <div className="wechat-edition-bar">
        <span className="muted">
          {article.remote
            ? "本稿再次保存会更新原微信草稿；再发一篇会创建独立新稿。"
            : article.edition
              ? "独立新稿，发送时创建新的微信草稿。资源、配图、词表与风格已继承。"
              : "同一素材可创建多篇独立稿件。"}
        </span>
        <Button
          quiet
          size="compact"
          disabled={busy}
          onClick={() => setHistoryOpen(true)}
        >
          <History size={14} /> 版本与送稿记录（{detail.editions?.length ?? 1}）
        </Button>
      </div>
      {error?.target === "editor" ? (
        <Notice danger>
          <span role="alert">{error.message}</span>
        </Notice>
      ) : null}
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      {conflict ? (
        <Notice warning>
          此草稿已有更新，本机未保存文字已保留。请先复制需要保留的文字，再载入最新版本。
          <Button
            quiet
            disabled={busy}
            onClick={() => {
              draft.update({
                ...text(article),
                revision: article.revision,
                textEdited: false,
              });
            }}
          >
            载入最新版本
          </Button>
        </Notice>
      ) : null}
      <Panel className="wechat-content-panel">
        <Field label="文章标题" hint={`${draft.value.title.length}/64`}>
          <input
            value={draft.value.title}
            maxLength={64}
            disabled={busy || !editable}
            onChange={(e) => update({ title: e.target.value })}
          />
        </Field>
        <Tabs
          className="wechat-editor-tabs"
          value={draft.value.tab}
          onChange={(tab) => draft.update({ tab })}
        >
          <div className="wechat-tab-heading" ref={editorTabs}>
            <TabList
              label="草稿编辑区"
              items={[
                ["body", "正文"],
                ["resources", `网盘链接 · ${article.links.length}`],
                ["images", "插图与封面"],
              ]}
            />
            <Button
              quiet
              size="compact"
              aria-haspopup="dialog"
              onClick={() => setComparisonOpen(true)}
            >
              <Maximize2 size={14} /> 全屏预览
            </Button>
          </div>
          <TabPanel value="body">
            <div className="wechat-body-toolbar">
              <div className="wechat-body-heading">
                <strong id="wechat-body-label">
                  {preview ? "正文预览" : "文章正文"}
                </strong>
                {!preview ? <small>支持 Markdown</small> : null}
              </div>
              <div className="wechat-editor-actions">
                <Button
                  quiet
                  size="compact"
                  onClick={() => setPreview(!preview)}
                >
                  <Eye size={14} />
                  {preview ? "继续编辑" : "排版预览"}
                </Button>
                <Button
                  quiet
                  size="compact"
                  disabled={busy || !editable || conflict}
                  onClick={() =>
                    void run("整理排版", async () => {
                      await saved();
                      return ipc("wechat.format", { id: article.id });
                    })
                  }
                >
                  整理排版
                </Button>
              </div>
            </div>
            {preview ? (
              <article
                className="wechat-preview"
                dangerouslySetInnerHTML={{
                  __html: wechatPreviewHtml(draft.value.body),
                }}
              />
            ) : (
              <textarea
                className="wechat-body"
                aria-labelledby="wechat-body-label"
                value={draft.value.body}
                maxLength={200000}
                disabled={busy || !editable}
                onChange={(e) => update({ body: e.target.value })}
              />
            )}
            <div className="wechat-body-options">
              <details className="wechat-options">
                <summary>作者与摘要（可选）</summary>
                <div className="wechat-metadata">
                  <Field label="作者" hint="留空使用公众号默认署名">
                    <input
                      disabled={busy || !editable}
                      value={draft.value.author}
                      maxLength={16}
                      onChange={(e) => update({ author: e.target.value })}
                    />
                  </Field>
                  <Field label="摘要" hint="留空由微信截取正文">
                    <textarea
                      disabled={busy || !editable}
                      value={draft.value.digest}
                      maxLength={120}
                      rows={2}
                      onChange={(e) => update({ digest: e.target.value })}
                    />
                  </Field>
                </div>
              </details>
            </div>
          </TabPanel>
          <TabPanel value="resources" keepMounted>
            <ArticleResources
              detail={detail}
              actions={actions}
              partialSync
              busy={busy || conflict || !editable}
              onBusy={setResourceBusy}
              beforeAction={saved}
              onChanged={apply}
            />
          </TabPanel>
          <TabPanel value="images" keepMounted>
            <ArticleImages
              id={article.id}
              body={draft.value.body}
              coverUrl={draft.value.coverUrl}
              coverAddress={draft.value.coverAddress}
              imageAddress={draft.value.imageAddress}
              disabled={busy || !editable || conflict}
              onRegenerate={async ({ targets, mode, style, description }) => {
                const current = await saved();
                const input = {
                  id: article.id,
                  revision: current.article.revision,
                  targets,
                  confirmed: true as const,
                };
                const result =
                  mode === "theme"
                    ? await ipc("wechat.generateThemeImages", {
                        ...input,
                        description,
                      })
                    : await ipc("wechat.regenerateImages", { ...input, style });
                apply(result.detail);
                if (alive.current && result.replaced && !result.failed.length)
                  notify(`已替换 ${result.replaced} 处配图。`, "success");
                return result;
              }}
              onBody={(body) => update({ body })}
              onCover={(coverUrl) => update({ coverUrl })}
              onCoverAddress={(coverAddress) => draft.update({ coverAddress })}
              onImageAddress={(imageAddress) => draft.update({ imageAddress })}
              onBusy={setResourceBusy}
            />
          </TabPanel>
        </Tabs>
      </Panel>
      {trafficWordsOpen ? (
        <TrafficWordsDialog
          storageKey={`panxu:wechat:${data!.dataPath}:${article.id}:traffic-words`}
          saved={trafficWords}
          plan={trafficWordPlan}
          title={draft.value.title}
          body={draft.value.body}
          onClose={() => setTrafficWordsOpen(false)}
          onSave={async (words, wordsRevision) => {
            if (lock.current || resourceBusy)
              throw new Error("草稿正在处理，请稍后保存流量词。");
            lock.current = true;
            setPending("保存流量词");
            try {
              const next = await ipc("wechat.saveTrafficWords", {
                id: article.id,
                wordsRevision,
                words,
              });
              if (alive.current) {
                setDetail(next);
                onChanged();
              }
            } finally {
              lock.current = false;
              if (alive.current) setPending("");
            }
          }}
        />
      ) : null}
      {rewriteOpen ? (
        <ArticleRewriteDialog
          styleId={draft.value.styleId}
          instruction={draft.value.instruction}
          wordCount={trafficWords.words.length}
          wordPlan={trafficWordPlan}
          busy={pending === "AI 改写"}
          disabled={busy || !editable || conflict}
          error={
            error?.target === "rewrite"
              ? error.message
              : conflict
                ? "草稿已在其他窗口更新，请关闭弹窗并载入最新版本后再改写。"
                : undefined
          }
          onStyle={(styleId) => draft.update({ styleId })}
          onInstruction={(instruction) => draft.update({ instruction })}
          onClose={() => {
            setRewriteOpen(false);
            setError(null);
          }}
          onRewrite={() =>
            void run(
              "AI 改写",
              async () => {
                await saved();
                const result = await ipc("wechat.rewrite", {
                  id: article.id,
                  styleId: draft.value.styleId,
                  instruction: draft.value.instruction || undefined,
                });
                if (alive.current) {
                  setRewriteOpen(false);
                  setPreview(true);
                  draft.update({ tab: "body" });
                  requestAnimationFrame(() =>
                    rewriteButton.current?.focus({ preventScroll: true }),
                  );
                }
                return result;
              },
              "标题、正文和摘要已改写，请对照原文审阅。",
              "rewrite",
            )
          }
        />
      ) : null}
      {comparisonOpen ? (
        <ArticleComparison
          source={article.source}
          current={draft.value}
          onClose={() => setComparisonOpen(false)}
        />
      ) : null}
      {historyOpen ? (
        <ArticleEditionsDialog
          currentId={article.id}
          editions={
            detail.editions ?? [
              {
                id: article.id,
                number: article.edition?.number ?? 1,
                title: article.title,
                stage: article.stage,
                rewriteStyleId: article.rewriteStyleId,
                deliveries: [],
              },
            ]
          }
          onSelect={(id) => {
            setHistoryOpen(false);
            onSelect(id);
          }}
          onClose={() => setHistoryOpen(false)}
          onRecorded={(next) => {
            setDetail((current) => ({
              ...current,
              editions: next.editions,
              article:
                current.article.id === next.article.id
                  ? next.article
                  : current.article,
            }));
            onChanged();
          }}
        />
      ) : null}
      {deliveryOpen ? (
        <Dialog
          className="wechat-delivery"
          focus="container"
          busy={!!pending}
          title={
            uncertain
              ? "核对微信保存结果"
              : synced
                ? "微信草稿已保存"
                : "送到微信草稿箱"
          }
          onClose={() => {
            setDeliveryOpen(false);
          }}
          footer={
            <>
              <Button
                disabled={busy}
                onClick={() => {
                  setDeliveryOpen(false);
                }}
              >
                {synced || uncertain ? "关闭" : "继续编辑"}
              </Button>
              {editable && !synced ? (
                <Button
                  primary
                  disabled={busy || conflict || !accountId || sendBlocked}
                  onClick={send}
                >
                  <Send size={14} />
                  {pending === "发送到微信草稿箱"
                    ? "正在保存到微信…"
                    : article.remote
                      ? "更新本次微信草稿"
                      : "保存为新微信草稿"}
                </Button>
              ) : null}
              {accountId && (article.remote || uncertain) ? (
                <Button
                  primary={synced || uncertain}
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    void ipc("wechat.open", {
                      accountId,
                      id: article.id,
                    }).catch((cause) =>
                      setError({
                        target: "delivery",
                        message:
                          cause instanceof Error
                            ? cause.message
                            : "微信后台打开失败，请重试。",
                      }),
                    );
                  }}
                >
                  <ExternalLink size={14} />
                  打开微信草稿箱
                </Button>
              ) : null}
            </>
          }
        >
          <p className="wechat-delivery-caption muted">
            保存后，可在微信后台预览和发文。
          </p>
          <QueryError
            error={accounts.error}
            loading={accounts.loading}
            onRetry={accounts.reload}
          />
          {!accounts.data && !accounts.error ? (
            <LoadingState label="正在读取公众号账号…" compact />
          ) : accounts.data ? (
            <div className="wechat-delivery-account">
              <span className="muted">目标公众号</span>
              <strong>
                {account ? account.nickname || account.alias : "尚未连接账号"}
              </strong>
              {account ? (
                <Status
                  kind={account.status === "connected" ? "good" : "warning"}
                >
                  {account.status === "connected" ? "已登录" : "需登录"}
                </Status>
              ) : null}
            </div>
          ) : null}
          {accounts.data && account?.status !== "connected" ? (
            <div className="wechat-delivery-repair">
              <span>
                {account ? "请重新登录目标公众号。" : "请添加并登录公众号。"}
              </span>
              <Button
                size="compact"
                disabled={busy}
                onClick={() => navigate("wechat-accounts")}
              >
                管理账号
              </Button>
            </div>
          ) : null}
          {error?.target === "delivery" ? (
            <Notice danger>
              <span role="alert">{error.message}</span>
            </Notice>
          ) : null}
          {article.message && !synced && !uncertain && !error ? (
            <details className="wechat-options">
              <summary>上次操作记录</summary>
              <p className="wechat-delivery-caption muted">{article.message}</p>
            </details>
          ) : null}
          {article.remote ? (
            <p className="wechat-delivery-caption muted">
              后续发送会更新同一篇微信草稿。
            </p>
          ) : null}
          {editable && dirty ? (
            <p className="wechat-delivery-caption muted">
              保存到微信前会先保存本地修改并检查文章。
            </p>
          ) : editable && !synced && detail.issues.length ? (
            <ul className="wechat-issues">
              {detail.issues.map((issue, i) => (
                <li key={i} data-severity={issue.severity}>
                  {issue.text}
                </li>
              ))}
            </ul>
          ) : null}
          {editable && !synced ? (
            <>
              {missingCover || missingLinks ? (
                <div className="wechat-delivery-repair">
                  {missingCover ? (
                    <Button
                      size="compact"
                      disabled={busy}
                      onClick={() => openTab("images")}
                    >
                      添加封面
                    </Button>
                  ) : null}
                  {missingLinks ? (
                    <Button
                      size="compact"
                      disabled={busy}
                      onClick={() => openTab("resources")}
                    >
                      处理网盘链接
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {uncertain ? (
            <UncertainDraft
              busy={busy}
              message={article.message}
              onResolve={(result, url) =>
                void run(
                  "记录核对结果",
                  () =>
                    ipc("wechat.resolve", {
                      id: article.id,
                      result,
                      url: url || undefined,
                      confirmed: true,
                    }),
                  undefined,
                  "delivery",
                )
              }
            />
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}
function UncertainDraft({
  busy,
  message,
  onResolve,
}: {
  busy: boolean;
  message: string;
  onResolve(result: "saved" | "not_saved", url?: string): void;
}) {
  const [url, setUrl] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  return (
    <div className="wechat-resolution">
      <Notice warning>
        {message ||
          "上次保存结果不明确。请打开微信草稿箱核对后记录结果，暂不重复发送。"}
      </Notice>
      <Field label="已保存的微信草稿编辑地址">
        <input
          value={url}
          disabled={busy}
          onChange={(e) => {
            setUrl(e.target.value);
            setConfirmed(false);
          }}
          placeholder="从微信后台复制草稿编辑链接"
          maxLength={4000}
        />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        我已在当前公众号后台核对本次草稿
      </label>
      <div className="wechat-toolbar">
        <Button
          disabled={busy || !confirmed || !url.trim()}
          onClick={() => onResolve("saved", url.trim())}
        >
          确认已保存
        </Button>
        <Button
          disabled={busy || !confirmed}
          onClick={() => onResolve("not_saved")}
        >
          确认没有保存，恢复编辑
        </Button>
      </div>
    </div>
  );
}
