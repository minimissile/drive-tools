import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  ExternalLink,
  FileCheck,
  RefreshCw,
  Send,
  WandSparkles,
} from "lucide-react";
import type { SmzdmDetail } from "../../shared/smzdm";
import { articleHtml } from "../../shared/article-markup";
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
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Dialog } from "../ui/Dialog";
import { ArticleResources } from "./ArticleResources";
const editorDraft = z.object({
  title: z.string().max(200),
  body: z.string().max(200000),
  revision: z.number().int().positive(),
});
const resultDraft = z.object({
  url: z.string().max(2000),
  result: z.enum(["submitted", "published", "not_submitted"]),
});
export function ArticleEditor({
  initial,
  onChanged,
}: {
  initial: SmzdmDetail;
  onChanged(): void;
}) {
  const { data } = useAppData(),
    { notify } = useAppActions(),
    { navigate } = useAppNavigation();
  const [detail, setDetail] = useState(initial),
    [pending, setPending] = useState(""),
    [error, setError] = useState(""),
    [preview, setPreview] = useState(false),
    [publishDialog, setPublishDialog] = useState(false),
    [consent, setConsent] = useState(false),
    [reviewed, setReviewed] = useState(false);
  const [resourceBusy, setResourceBusy] = useState(false);
  const busy = !!pending || resourceBusy;
  const article = detail.article;
  const draft = useLocalDraft(
    `panxu:smzdm:${data!.dataPath}:${article.id}:editor`,
    { title: article.title, body: article.body, revision: article.revision },
    (v) => editorDraft.parse(v),
  );
  const resolution = useLocalDraft(
    `panxu:smzdm:${data!.dataPath}:${article.id}:resolution`,
    {
      url: article.receiptUrl ?? "",
      result: (article.stage === "published" ? "published" : "submitted") as
        "submitted" | "published" | "not_submitted",
    },
    (v) => resultDraft.parse(v),
  );
  const accounts = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
  });
  const account = accounts.data?.find((a) => a.provider === "smzdm");
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const dirty =
    draft.value.title !== article.title || draft.value.body !== article.body;
  useEffect(() => {
    if (!dirty && draft.value.revision !== article.revision)
      draft.update({ revision: article.revision });
  }, [dirty, article.revision, draft.value.revision, draft.update]);
  const editable = article.stage === "editing";
  const apply = (next: SmzdmDetail) => {
    if (!alive.current) return;
    setDetail(next);
    draft.update({
      title: next.article.title,
      body: next.article.body,
      revision: next.article.revision,
    });
    setReviewed(false);
    setConsent(false);
    if (
      next.article.stage === "submitted" ||
      next.article.stage === "published"
    )
      resolution.update({
        result: next.article.stage,
        url: next.article.receiptUrl ?? "",
      });
    onChanged();
  };
  const saved = async () => {
    if (!dirty) return detail;
    const next = await ipc("smzdm.save", {
      id: article.id,
      revision: draft.value.revision,
      title: draft.value.title,
      body: draft.value.body,
    });
    apply(next);
    return next;
  };
  const run = async (
    label: string,
    action: () => Promise<SmzdmDetail>,
    message?: string,
  ) => {
    if (lock.current || resourceBusy) return;
    lock.current = true;
    setPending(label);
    setError("");
    try {
      const next = await action();
      apply(next);
      if (message && alive.current) notify(message, "success");
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending("");
    }
  };
  const mutate = async (
    method:
      "smzdm.syncLinks" | "smzdm.format" | "smzdm.polish" | "smzdm.prepare",
  ) => {
    await saved();
    return ipc(method, { id: article.id });
  };
  const update = (patch: Partial<typeof draft.value>) => {
    draft.update(patch);
    setReviewed(false);
    setConsent(false);
  };
  return (
    <div className="smzdm-article">
      <div className="smzdm-source-meta">
        <div>
          <Status
            kind={
              editable
                ? "normal"
                : article.stage === "uncertain"
                  ? "warning"
                  : "good"
            }
          >
            {editable
              ? "文章编辑"
              : article.stage === "uncertain"
                ? "结果待核对"
                : article.stage === "publishing"
                  ? "提交中"
                  : article.stage === "submitted"
                    ? "平台待审核"
                    : "已发布"}
          </Status>
          <strong>{article.source.author || "公众号文章"}</strong>
          <span>{article.source.publishedAt}</span>
        </div>
        <Button
          quiet
          size="compact"
          onClick={() =>
            void ipc("system.external", { url: article.source.url })
          }
        >
          <ExternalLink size={13} />
          查看原文
        </Button>
      </div>
      {!error ? <p className="muted">{article.message}</p> : null}
      {error ? <Notice danger>{error}</Notice> : null}
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      {draft.value.revision !== article.revision && dirty ? (
        <Notice warning>
          本机暂存对应旧版本。内容已保留，请先复制待保留文字；保存时不会覆盖较新的版本。
          <Button
            quiet
            disabled={busy}
            onClick={() =>
              draft.update({
                title: article.title,
                body: article.body,
                revision: article.revision,
              })
            }
          >
            以任务版本替换本机暂存
          </Button>
        </Notice>
      ) : null}
      <ArticleResources
        detail={detail}
        busy={busy}
        onBusy={setResourceBusy}
        beforeAction={saved}
        onChanged={apply}
      />
      <Panel
        title="文章编辑与排版"
        extra={
          <Button quiet size="compact" onClick={() => setPreview(!preview)}>
            {preview ? "继续编辑" : "排版预览"}
          </Button>
        }
      >
        <div className="smzdm-editor-toolbar">
          <Button
            disabled={busy || !editable}
            onClick={() =>
              void run("排版", () => mutate("smzdm.format"), "排版已整理。")
            }
          >
            <WandSparkles size={14} />
            整理排版
          </Button>
          <Button
            disabled={busy || !editable}
            onClick={() => void run("润色", () => mutate("smzdm.polish"))}
          >
            AI 润色
          </Button>
          <small>润色使用当前文案模型并计费，保留事实、图片与链接。</small>
        </div>
        <Field label="文章标题">
          <input
            value={draft.value.title}
            disabled={!editable || busy}
            maxLength={30}
            onChange={(e) => update({ title: e.target.value })}
          />
        </Field>
        {preview ? (
          <article
            className="smzdm-preview"
            dangerouslySetInnerHTML={{ __html: articleHtml(draft.value.body) }}
          />
        ) : (
          <Field label="文章正文" hint="支持 Markdown 标题、图片与链接">
            <textarea
              className="smzdm-body"
              value={draft.value.body}
              disabled={!editable || busy}
              maxLength={200000}
              onChange={(e) => update({ body: e.target.value })}
            />
          </Field>
        )}
        <div className="row spread">
          <small>
            {dirty
              ? draft.error
                ? "尚未保存，请先保存到任务"
                : "本机已暂存，尚未保存到任务"
              : `已保存版本 ${article.revision}`}
          </small>
          <Button
            primary
            disabled={busy || !editable || !dirty}
            onClick={() => void run("保存", saved, "文章已保存。")}
          >
            保存文章
          </Button>
        </div>
        <details className="smzdm-original">
          <summary>对照原文：{article.source.title}</summary>
          <pre>{article.source.body}</pre>
        </details>
      </Panel>
      <Panel title="内容检查与发布">
        <div className="smzdm-check-heading">
          <div>
            <strong>
              {account
                ? account.nickname || account.alias
                : "尚未连接什么值得买账号"}
            </strong>
            <small>
              {account?.uid
                ? ` UID ${account.uid}`
                : "在账号管理中登录并检查身份"}
            </small>
          </div>
          <Button
            quiet
            size="compact"
            onClick={() => navigate("smzdm-accounts")}
          >
            管理账号
            <ExternalLink size={13} />
          </Button>
        </div>
        <QueryError
          error={accounts.error}
          loading={accounts.loading}
          onRetry={accounts.reload}
        />
        {!accounts.data && !accounts.error ? (
          <LoadingState label="正在读取账号…" compact />
        ) : null}
        {dirty ? (
          <Notice>检查结果对应已保存的版本。保存后重新检查与审阅。</Notice>
        ) : detail.issues.length ? (
          <ul className="smzdm-issues">
            {detail.issues.map((issue, i) => (
              <li key={i} data-severity={issue.severity}>
                {issue.text}
              </li>
            ))}
          </ul>
        ) : (
          <Notice>
            当前稿件的链接、基础格式和占位内容检查已通过。请继续核对原文事实、使用授权与图片。
          </Notice>
        )}
        <div className="smzdm-review">
          <label className="check smzdm-consent">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={busy || !editable}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            我已核对正文事实、原文引用和配套资源
          </label>
          <Button
            disabled={!reviewed || busy || !editable}
            onClick={() =>
              void run(
                "审阅",
                async () => {
                  const current = await saved();
                  return ipc("smzdm.review", {
                    id: article.id,
                    revision: current.article.revision,
                    confirmed: true,
                  });
                },
                "当前版本已审阅。",
              )
            }
          >
            <FileCheck size={14} />
            完成审阅
          </Button>
        </div>
        <div className="smzdm-publish-actions">
          <Status
            kind={
              !dirty && article.reviewedRevision === article.revision
                ? "good"
                : "warning"
            }
          >
            {!dirty && article.reviewedRevision === article.revision
              ? "当前版本已审阅"
              : "当前版本待审阅"}
          </Status>
          <Button
            disabled={
              busy ||
              dirty ||
              !editable ||
              article.reviewedRevision !== article.revision ||
              account?.status !== "connected"
            }
            onClick={() => void run("预览", () => mutate("smzdm.prepare"))}
          >
            打开官方发布预览
          </Button>
          <Button
            primary
            disabled={
              busy ||
              dirty ||
              !editable ||
              article.reviewedRevision !== article.revision ||
              account?.status !== "connected"
            }
            onClick={() => {
              setConsent(false);
              setPublishDialog(true);
            }}
          >
            <Send size={14} />
            一键发布
          </Button>
          <Button
            quiet
            disabled={busy || dirty}
            onClick={() =>
              void run("刷新", () => ipc("smzdm.get", { id: article.id }))
            }
          >
            <RefreshCw size={14} />
            刷新任务
          </Button>
        </div>
        {pending ? (
          <p role="status" className="muted">
            正在{pending}，请等待当前操作完成…
          </p>
        ) : null}
        {article.receiptUrl ? (
          <p>
            文章回执：
            <Button
              quiet
              onClick={() =>
                void ipc("system.external", { url: article.receiptUrl! })
              }
            >
              {article.receiptUrl}
              <ExternalLink size={13} />
            </Button>
          </p>
        ) : null}
        {["uncertain", "submitted", "published"].includes(article.stage) ? (
          <div className="smzdm-resolution">
            <Button
              disabled={busy}
              onClick={() =>
                void run("核对官方结果", () =>
                  ipc("smzdm.checkResult", { id: article.id }),
                )
              }
            >
              <RefreshCw size={14} />
              核对官方投稿结果
            </Button>
            {article.stage !== "published" ? (
              <>
                <Field label="手动核对结果">
                  <Select
                    value={resolution.value.result}
                    onValueChange={(v) => {
                      resolution.update({
                        result: v as typeof resolution.value.result,
                      });
                      setConsent(false);
                    }}
                    items={[
                      { value: "submitted", label: "已提交，等待审核" },
                      { value: "published", label: "已公开发布" },
                      ...(article.stage === "uncertain"
                        ? [{ value: "not_submitted", label: "已确认没有提交" }]
                        : []),
                    ]}
                  />
                </Field>
                {resolution.value.result !== "not_submitted" ? (
                  <Field
                    label={
                      resolution.value.result === "submitted"
                        ? "文章地址（待审核时可稍后补填）"
                        : "文章地址"
                    }
                  >
                    <input
                      value={resolution.value.url}
                      onChange={(e) =>
                        resolution.update({ url: e.target.value })
                      }
                      placeholder="https://post.smzdm.com/p/…"
                    />
                  </Field>
                ) : null}
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      "核对",
                      () =>
                        ipc("smzdm.resolve", {
                          id: article.id,
                          result: resolution.value.result,
                          url: resolution.value.url,
                          confirmed: true,
                        }),
                      "发布结果已保存。",
                    )
                  }
                >
                  保存已核对结果
                </Button>
                {resolution.error ? (
                  <Notice warning>{resolution.error}</Notice>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </Panel>
      {publishDialog ? (
        <Dialog
          title="发布到什么值得买"
          busy={busy}
          onClose={() => {
            setPublishDialog(false);
            setConsent(false);
          }}
        >
          <p>
            将“{article.title}”发布到 {account?.nickname || account?.alias}
            。提交后仍可能进入平台审核。
          </p>
          <label className="check smzdm-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            我有权使用本篇文章及配图，已核对本人资源链接，确认提交当前版本
          </label>
          <div className="dialog-actions">
            <Button disabled={busy} onClick={() => setPublishDialog(false)}>
              取消
            </Button>
            <Button
              primary
              disabled={!consent || busy}
              onClick={() =>
                void run("发布", async () => {
                  const next = await ipc("smzdm.publish", {
                    id: article.id,
                    revision: article.revision,
                    confirmed: true,
                  });
                  if (alive.current) setPublishDialog(false);
                  return next;
                })
              }
            >
              确认发布
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
