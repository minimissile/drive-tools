import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  Copy,
  Download,
  ExternalLink,
  Eye,
  ImagePlus,
  PenLine,
  Trash2,
} from "lucide-react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import { Button, Field, Notice, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { SearchSelect } from "../ui/SearchSelect";
import { AiIcon } from "../ui/AiIcon";
import {
  contentImageSchema,
  type ContentImage,
} from "../../shared/content-sources";
import {
  jianshuDraftUrl,
  jianshuTemplateItems,
  type JianshuDetail,
  type JianshuTemplate,
} from "../../shared/jianshu";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import { articleHtml } from "../../shared/article-markup";
import { stageLabels, jianshuAccountLabel, localServiceError } from "./labels";
import { AccountStatus } from "./AccountStatus";
import "./article-editor.css";
const schema = z.object({
  title: z.string().max(200),
  body: z.string().max(100000),
  template: z.enum(["resource", "guide"]),
  accountId: z.string().nullable(),
  copyId: z.string().nullable(),
  sourceIds: z.array(z.string()),
  images: z.array(contentImageSchema),
  revision: z.number().int().positive(),
  instruction: z.string().max(4000),
  receipt: z.string().max(2000),
});
function ImagePreview({
  id,
  revision,
  image,
}: {
  id: string;
  revision: number;
  image: ContentImage;
}) {
  const query = useIpcQuery(
    "jianshu.image",
    { id, revision, file: image.file },
    { keepPrevious: true },
  );
  return (
    <>
      <div className="jianshu-image-frame">
        {query.data ? (
          <img src={query.data} alt={image.name} />
        ) : (
          <span className="muted">
            {query.error ? "图片暂不可用" : "正在读取图片…"}
          </span>
        )}
      </div>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
    </>
  );
}
export function ArticleEditor({
  initial,
  workspace,
  accounts,
  onAccountVerified,
  onChanged,
}: {
  initial: JianshuDetail;
  workspace: string;
  accounts: WebsiteAccountView[];
  onAccountVerified(account: WebsiteAccountView): void;
  onChanged(detail: JianshuDetail): void;
}) {
  const [detail, setDetail] = useState(initial),
    [pending, setPending] = useState(""),
    [failure, setFailure] = useState(""),
    [confirmImageRetry, setConfirmImageRetry] = useState(false),
    [preview, setPreview] = useState(false),
    [resourceQuery, setResourceQuery] = useState("");
  const { notify } = useAppActions();
  const [confirmNewDraft, setConfirmNewDraft] = useState(false);
  const article = detail.article;
  const form = useLocalDraft(
    `panxu:jianshu:${workspace}:${article.id}:editor`,
    {
      title: article.title,
      body: article.body,
      template: article.template,
      accountId: article.accountId,
      copyId: article.copyId,
      sourceIds: article.sourceIds,
      images: article.images,
      revision: article.revision,
      instruction: "",
      receipt: article.receiptUrl || "",
    },
    (v) => schema.parse(v),
  );
  const matches = useIpcQuery(
    "jianshu.matches",
    { keyword: resourceQuery },
    { delay: 180, keepPrevious: true, enabled: article.stage === "editing" },
  );
  const writing = useRef<HTMLElement>(null);
  const releaseReview = useRef<HTMLElement>(null);
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setDetail(initial);
  }, [initial]);
  const dirty =
    form.value.title !== article.title ||
    form.value.body !== article.body ||
    form.value.accountId !== article.accountId ||
    form.value.template !== article.template ||
    form.value.copyId !== article.copyId ||
    JSON.stringify(form.value.sourceIds) !==
      JSON.stringify(article.sourceIds) ||
    JSON.stringify(form.value.images) !== JSON.stringify(article.images);
  const editable = article.stage === "editing";
  const busy = !!pending || detail.busy;
  const draftUrl = jianshuDraftUrl(
    article.preparedFill?.editorUrl || article.editorUrl,
  );
  const filled =
    article.preparedFill?.filled === true &&
    article.preparedRevision === article.revision &&
    !dirty;
  const pendingImage =
    article.stage !== "published" && !!article.preparedFill?.pendingImageSha256;
  useEffect(() => {
    setConfirmImageRetry(false);
    setConfirmNewDraft(false);
  }, [article.id, article.preparedFill?.pendingImageSha256]);
  const canFill =
    !article.receiptUrl &&
    (editable ||
      article.stage === "prepared" ||
      (article.stage === "uncertain" && !!draftUrl));
  const fillLabel = filled
    ? "查看已填写草稿"
    : draftUrl
      ? editable
        ? "重新填写原草稿"
        : "继续填写原草稿"
      : "填写到简书";
  const apply = (next: JianshuDetail) => {
    if (!alive.current) return;
    setDetail(next);
    form.update({
      title: next.article.title,
      body: next.article.body,
      template: next.article.template,
      accountId: next.article.accountId,
      copyId: next.article.copyId,
      sourceIds: next.article.sourceIds,
      images: next.article.images,
      revision: next.article.revision,
      ...(next.article.receiptUrl ? { receipt: next.article.receiptUrl } : {}),
    });
    onChanged(next);
  };
  const saved = async () => {
    if (!dirty) return detail;
    const {
      instruction: _instruction,
      receipt: _receipt,
      ...fields
    } = form.value;
    const next = await ipc("jianshu.save", {
      id: article.id,
      ...fields,
      images: fields.images.map((image) => ({
        ...image,
        storage: image.storage ?? "content-assets",
      })),
    });
    apply(next);
    return next;
  };
  const run = async (
    label: string,
    action: () => Promise<unknown>,
    success?: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setPending(label);
    setFailure("");
    try {
      await action();
      if (success && alive.current) notify(success, "success");
    } catch (error) {
      if (alive.current)
        setFailure(
          localServiceError(
            error instanceof Error ? error.message : "操作未完成，请重试。",
          ),
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending("");
    }
  };
  const versionArgs = (next: JianshuDetail) => ({
    id: next.article.id,
    revision: next.article.revision,
  });
  const generate = () =>
    run(
      "generate",
      async () => {
        const next = await saved();
        apply(
          await ipc("jianshu.generate", {
            ...versionArgs(next),
            requestId: crypto.randomUUID(),
            instruction: form.value.instruction,
          }),
        );
      },
      "新版本已生成，原稿已保留。",
    );
  const copied = () =>
    run(
      "copy",
      async () => {
        const next = await saved();
        await ipc("jianshu.copy", versionArgs(next));
      },
      "正文已复制，包含资料入口与来源；配图可单独导出。",
    );
  const exportArticle = () =>
    run("export", async () => {
      const next = await saved();
      const path = await ipc("jianshu.export", versionArgs(next));
      if (path && alive.current) notify("文章与配图已导出。", "success");
    });
  const togglePreview = () =>
    run("preview", async () => {
      const next = await saved();
      if (!alive.current) return;
      apply(next);
      setPreview((current) => !current);
      writing.current?.focus({ preventScroll: true });
      writing.current?.scrollIntoView({ block: "start" });
    });
  const prepare = () =>
    run("prepare", async () => {
      const next = await saved();
      const result = await ipc("jianshu.prepare", versionArgs(next));
      apply(result);
      if (
        alive.current &&
        result.article.stage === "prepared" &&
        !result.article.preparedFill
      )
        setFailure(
          "当前后端仅打开了简书，尚未自动填写。请点击顶部“应用更新并重启”加载新功能后再试；稿件已保留。",
        );
    });
  const openDraft = () =>
    run("openDraft", async () => {
      if (article.accountId && draftUrl)
        await ipc("websiteAccounts.openDocument", {
          id: article.accountId,
          url: draftUrl,
        });
    });
  const restore = (revision: string) => {
    if (revision === "current") return;
    const version = article.versions.find(
      (v) => String(v.revision) === revision,
    );
    if (version)
      form.update({
        title: version.title,
        body: version.body,
        images: version.images,
        ...(version.copyId !== undefined ? { copyId: version.copyId } : {}),
        ...(version.sourceIds ? { sourceIds: version.sourceIds } : {}),
        ...(version.template ? { template: version.template } : {}),
      });
    if (version && version.copyId === undefined)
      notify(
        "此旧版本只保存了正文与配图，当前资源关联保留，请核对资料入口。",
        "warning",
      );
  };
  const selectedResource = matches.data?.find(
    (item) => item.copyId === form.value.copyId,
  );
  return (
    <div className="jianshu-editor">
      <header className="jianshu-editor-heading">
        <h2>{preview ? "交付预览" : editable ? "编辑稿件" : "稿件内容"}</h2>
        <div className="jianshu-inline">
          <Status
            kind={
              article.stage === "published"
                ? "good"
                : article.stage === "uncertain"
                  ? "warning"
                  : "normal"
            }
          >
            {stageLabels[article.stage]}
          </Status>
          <span className="muted" role="status">
            版本 {article.revision}
            {dirty ? " · 有未保存修改" : " · 已保存"}
          </span>
          {!editable ? (
            <Button
              quiet
              size="compact"
              onClick={() => releaseReview.current?.focus()}
            >
              查看发布核对
            </Button>
          ) : null}
        </div>
      </header>
      {form.error ? <Notice warning>{form.error}</Notice> : null}
      {form.value.revision !== article.revision ? (
        <Notice warning>
          当前后台版本已变化，本地输入仍保留。读取后台稿件前，会先将本地标题和正文复制到剪贴板。
          <Button
            size="compact"
            disabled={busy}
            onClick={() =>
              void run(
                "reload",
                async () => {
                  await ipc("system.copyText", {
                    text: `${form.value.title}\n\n${form.value.body}`,
                  });
                  apply(await ipc("jianshu.get", { id: article.id }));
                },
                "本地稿已复制，已读取后台版本。",
              )
            }
          >
            复制本地稿并读取后台版本
          </Button>
        </Notice>
      ) : null}
      <div className="jianshu-editor-layout">
        <div className="jianshu-editor-main">
          <section
            aria-label={preview ? "预览稿件" : "正文编辑"}
            className="jianshu-writing fields"
            ref={writing}
            tabIndex={-1}
          >
            {preview ? (
              <article className="jianshu-article-preview">
                <h2>{article.title || "未命名文章"}</h2>
                <div
                  className="jianshu-preview-body"
                  dangerouslySetInnerHTML={{
                    __html: articleHtml(detail.delivery.text, () => false),
                  }}
                  onClick={(event) => {
                    const link = (event.target as Element).closest?.("a[href]");
                    if (!link) return;
                    event.preventDefault();
                    const url = link.getAttribute("href");
                    if (url)
                      void run("link", () => ipc("system.external", { url }));
                  }}
                />
                {article.images.map((image) => (
                  <ImagePreview
                    key={image.file}
                    id={article.id}
                    revision={article.revision}
                    image={image}
                  />
                ))}
              </article>
            ) : (
              <>
                <Field label="文章标题">
                  <input
                    aria-label="简书文章标题"
                    className="jianshu-draft-title"
                    value={form.value.title}
                    maxLength={200}
                    disabled={busy}
                    readOnly={!editable}
                    onChange={(e) => {
                      if (editable) form.update({ title: e.target.value });
                    }}
                    placeholder="给文章一个具体、清楚的标题"
                  />
                </Field>
                <Field label="文章正文">
                  <textarea
                    aria-label="简书文章正文"
                    value={form.value.body}
                    maxLength={100000}
                    disabled={busy}
                    readOnly={!editable}
                    onChange={(e) => {
                      if (editable) form.update({ body: e.target.value });
                    }}
                    placeholder="可以直接写作，也可以使用关联资料或采集素材生成文章。"
                    rows={15}
                  />
                </Field>
              </>
            )}
            <div className="jianshu-images-toolbar">
              <strong>
                配图{" "}
                {form.value.images.length
                  ? `· ${form.value.images.length} 张`
                  : "（可选）"}
              </strong>
              <Button
                quiet
                size="compact"
                disabled={busy || !editable}
                onClick={() =>
                  void run("images", async () => {
                    const next = await saved();
                    const result = await ipc(
                      "jianshu.importImages",
                      versionArgs(next),
                    );
                    if (result) apply(result);
                  })
                }
              >
                <ImagePlus size={14} />
                添加本地图片
              </Button>
            </div>
            {!preview && form.value.images.length ? (
              <div className="jianshu-image-list">
                {form.value.images.map((image) => (
                  <div key={image.file}>
                    <ImagePreview
                      id={article.id}
                      revision={article.revision}
                      image={image}
                    />
                    <small>{image.name}</small>
                    <Button
                      quiet
                      size="compact"
                      aria-label={`移除图片 ${image.name}`}
                      disabled={busy || !editable}
                      onClick={() =>
                        form.update({
                          images: form.value.images.filter(
                            (i) => i.file !== image.file,
                          ),
                        })
                      }
                    >
                      <Trash2 size={13} />
                      移除
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          <div className="jianshu-review">
            {detail.issues.length ? (
              <div className="jianshu-checks">
                {detail.issues.map((issue, i) => (
                  <Notice
                    key={i}
                    {...(issue.severity === "error" ? { warning: true } : {})}
                  >
                    {issue.text}
                  </Notice>
                ))}
              </div>
            ) : null}
            {article.message ? (
              <p className="jianshu-current-message" role="status">
                {article.message}
              </p>
            ) : null}
            {pendingImage ? (
              <Notice warning>
                <div className="jianshu-inline">
                  <span>
                    上一张图片上传结果未确认，请先在官网检查。确认未上传后可允许重新上传。
                  </span>
                  {draftUrl && article.accountId ? (
                    <Button
                      size="compact"
                      disabled={busy}
                      onClick={() => void openDraft()}
                    >
                      查看官网草稿
                    </Button>
                  ) : null}
                  <Button
                    size="compact"
                    disabled={busy}
                    onClick={() => {
                      setFailure("");
                      setConfirmImageRetry(true);
                    }}
                  >
                    确认图片未上传，返回重试
                  </Button>
                </div>
              </Notice>
            ) : null}
            {!editable ? (
              <section
                aria-label="核对官网发布结果"
                className="jianshu-release"
                ref={releaseReview}
                tabIndex={-1}
              >
                <h3>核对官网发布结果</h3>
                {article.preparedFill && article.stage !== "published" ? (
                  <p className="muted" role="status">
                    {article.preparedFill.filled
                      ? "标题和正文已填写到官网草稿。"
                      : "官网草稿已保留，填写尚未完成。"}
                    {typeof article.preparedFill.uploadedImages === "number" &&
                    typeof article.preparedFill.totalImages === "number"
                      ? `配图已上传 ${article.preparedFill.uploadedImages} / ${article.preparedFill.totalImages} 张。`
                      : ""}
                    {article.receiptUrl
                      ? "请核对已填写的文章链接，确认实际发布结果。"
                      : article.preparedFill.filled
                        ? "请在简书检查排版和配图，并由你点击发布。"
                        : "请继续填写原草稿，完成后再到简书核对并发布。"}
                  </p>
                ) : null}
                {article.imageReviewRequired ? (
                  <Notice warning>
                    官网正文与资料入口已核对，配图仍需你打开官网文章逐张检查。
                    <Button
                      size="compact"
                      disabled={busy}
                      onClick={() =>
                        void run("confirmImages", async () =>
                          apply(
                            await ipc("jianshu.confirmImages", {
                              ...versionArgs(detail),
                              confirmed: true,
                            }),
                          ),
                        )
                      }
                    >
                      我已检查官网配图
                    </Button>
                  </Notice>
                ) : article.imageReviewedAt ? (
                  <p className="muted">官网配图已由你人工核对。</p>
                ) : null}
                <Field label="本人简书文章链接">
                  <input
                    aria-label="简书发布文章链接"
                    type="url"
                    placeholder="https://www.jianshu.com/p/…"
                    maxLength={2000}
                    value={form.value.receipt}
                    disabled={busy || article.stage === "published"}
                    onChange={(e) => form.update({ receipt: e.target.value })}
                  />
                </Field>
                <div className="jianshu-actions">
                  <Button
                    primary
                    disabled={
                      busy ||
                      !form.value.receipt.trim() ||
                      article.stage === "published"
                    }
                    onClick={() =>
                      void run("check", async () =>
                        apply(
                          await ipc("jianshu.checkResult", {
                            ...versionArgs(detail),
                            url: form.value.receipt,
                          }),
                        ),
                      )
                    }
                  >
                    {pending === "check" ? "正在核对…" : "核对发布结果"}
                  </Button>
                  {article.stage !== "published" ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run("resolve", async () =>
                          apply(
                            await ipc("jianshu.resolve", {
                              ...versionArgs(detail),
                              notPublished: true,
                            }),
                          ),
                        )
                      }
                    >
                      确认尚未发布，返回修改
                    </Button>
                  ) : null}
                  {draftUrl &&
                  !article.receiptUrl &&
                  article.stage !== "published" ? (
                    <Button
                      quiet
                      disabled={busy}
                      onClick={() => setConfirmNewDraft(true)}
                    >
                      改用新草稿
                    </Button>
                  ) : null}
                  {article.receiptUrl ? (
                    <Button
                      quiet
                      onClick={() =>
                        void ipc("system.external", {
                          url: article.receiptUrl!,
                        })
                      }
                    >
                      查看官网文章
                    </Button>
                  ) : null}
                </div>
                <small className="muted">
                  核对作者、正文和资料入口后才记录为已发布；读取失败或结果未知不会自动重发。
                </small>
              </section>
            ) : null}
          </div>
        </div>
        <aside className="jianshu-editor-rail" aria-label="稿件设置">
          <section className="jianshu-editor-options">
            <h3>稿件设置</h3>
            <Field label="发布账号">
              <Select
                aria-label="文章简书账号"
                disabled={busy || !editable}
                value={form.value.accountId || ""}
                onValueChange={(accountId) =>
                  form.update({ accountId: accountId || null })
                }
                items={[
                  { value: "", label: "暂不选择" },
                  ...accounts.map((a) => ({
                    value: a.id,
                    label: jianshuAccountLabel(a),
                  })),
                ]}
              />
            </Field>
            <AccountStatus
              account={accounts.find(
                (account) => account.id === form.value.accountId,
              )}
              disabled={busy}
              onVerified={onAccountVerified}
            />
            <Field label="文章模板">
              <Select
                aria-label="文章模板"
                disabled={busy || !editable}
                value={form.value.template}
                onValueChange={(template) =>
                  form.update({ template: template as JianshuTemplate })
                }
                items={jianshuTemplateItems}
              />
            </Field>
          </section>
          <section className="jianshu-editor-options">
            <h3>资料与来源</h3>
            <div className="jianshu-delivery-summary">
              {form.value.copyId !== article.copyId ? (
                <small className="muted">保存草稿后更新资料入口。</small>
              ) : detail.delivery.resourceUrl ? (
                <>
                  <strong>资料获取入口</strong>
                  <span>{detail.delivery.resourceUrl}</span>
                </>
              ) : (
                <small className="muted">纯内容稿</small>
              )}
            </div>
            {editable ? (
              <details className="jianshu-resource-details">
                <summary>
                  {form.value.copyId
                    ? "已关联本人资源 · 更换或移除"
                    : "关联本人资源（可选）"}
                </summary>
                <div className="jianshu-inline">
                  <SearchSelect
                    label="关联简书文章资源"
                    inputValue={resourceQuery}
                    onQueryChange={setResourceQuery}
                    value={{
                      value: form.value.copyId || "",
                      label:
                        selectedResource?.title ||
                        (form.value.copyId ? "已关联资料" : "不关联网盘资源"),
                    }}
                    items={(matches.data ?? []).map((r) => ({
                      value: r.copyId,
                      label: `${r.title} · ${r.accountAlias}`,
                    }))}
                    onChange={(copyId) => {
                      if (!busy && editable) form.update({ copyId });
                    }}
                    loading={matches.loading}
                    error={localServiceError(matches.error)}
                    onRetry={matches.reload}
                  />
                  {form.value.copyId ? (
                    <Button
                      quiet
                      disabled={busy || !editable}
                      onClick={() => form.update({ copyId: null })}
                    >
                      移除关联
                    </Button>
                  ) : null}
                </div>
                <small className="muted">
                  本人资源入口会自动加入最终正文。
                </small>
              </details>
            ) : null}
            {detail.sources.length ? (
              <details className="jianshu-source-notes">
                <summary>查看 {detail.sources.length} 项来源与使用说明</summary>
                {detail.sources.map((source) => (
                  <div key={source.id}>
                    <div className="jianshu-inline">
                      <strong>{source.title}</strong>
                      <Button
                        quiet
                        size="compact"
                        onClick={() =>
                          void run("source", () =>
                            ipc("system.external", { url: source.url }),
                          )
                        }
                      >
                        查看原文
                      </Button>
                    </div>
                    <small className="muted">
                      {source.sourceName}
                      {source.author ? ` · ${source.author}` : ""}
                    </small>
                    {source.warnings.map((warning, index) => (
                      <p key={index}>{warning}</p>
                    ))}
                  </div>
                ))}
              </details>
            ) : null}
          </section>
          {editable ? (
            <section className="jianshu-editor-options">
              <h3>AI 创作与校准</h3>
              <Field label="补充要求（可选）">
                <textarea
                  aria-label="简书补充要求"
                  rows={2}
                  maxLength={4000}
                  disabled={busy}
                  value={form.value.instruction}
                  onChange={(e) => form.update({ instruction: e.target.value })}
                  placeholder="例如：少一点营销表达，突出适合零基础自学的人群。"
                />
              </Field>
              <div className="jianshu-inline">
                <Button disabled={busy} onClick={() => void generate()}>
                  <AiIcon size={14} />
                  {pending === "generate"
                    ? "正在生成…"
                    : article.aiAssisted || form.value.instruction
                      ? "按要求生成新版本"
                      : "生成文章（AI）"}
                </Button>
                <small className="muted">
                  使用设置中的文案模型与预算；每次点击可能计费，旧版本保留。
                </small>
              </div>
            </section>
          ) : null}
          <section className="jianshu-editor-options">
            <h3>历史版本</h3>
            <Select
              aria-label="简书历史版本"
              disabled={busy || !editable}
              value="current"
              onValueChange={restore}
              items={[
                { value: "current", label: `当前版本 ${article.revision}` },
                ...article.versions
                  .filter((v) => v.revision !== article.revision)
                  .slice()
                  .reverse()
                  .map((v) => ({
                    value: String(v.revision),
                    label: `恢复版本 ${v.revision} · ${v.origin === "ai" ? "AI生成" : v.origin === "manual" ? "手动修改" : "初稿"}`,
                  })),
              ]}
            />
          </section>
        </aside>
      </div>
      <div className="jianshu-editor-footer">
        {failure && !confirmImageRetry && !confirmNewDraft ? (
          <Notice danger>
            <span role="alert">{failure}</span>
          </Notice>
        ) : null}
        <div
          className="jianshu-editor-actions"
          role="group"
          aria-label="稿件操作"
        >
          <div className="jianshu-inline">
            {editable ? (
              <Button
                disabled={busy || !dirty}
                onClick={() => void run("save", saved, "当前稿件已保存。")}
              >
                保存草稿
              </Button>
            ) : null}
            <Button disabled={busy} onClick={() => void togglePreview()}>
              {preview ? <PenLine size={14} /> : <Eye size={14} />}
              {preview ? "返回编辑" : "预览最终文章"}
            </Button>
          </div>
          <div className="jianshu-inline">
            <Button quiet disabled={busy} onClick={() => void copied()}>
              <Copy size={14} />
              复制正文
            </Button>
            <Button
              quiet
              disabled={busy}
              onClick={() =>
                void run(
                  "copyTitle",
                  async () => {
                    await ipc("system.copyText", { text: form.value.title });
                  },
                  "标题已复制。",
                )
              }
            >
              复制标题
            </Button>
            <Button quiet disabled={busy} onClick={() => void exportArticle()}>
              <Download size={14} />
              导出文章与配图
            </Button>
          </div>
          {canFill ? (
            <Button
              primary
              disabled={
                busy || !form.value.accountId || (!filled && pendingImage)
              }
              onClick={() => void (filled ? openDraft() : prepare())}
            >
              <ExternalLink size={14} />
              {pending === "prepare"
                ? "正在填写…"
                : pending === "openDraft"
                  ? "正在打开…"
                  : fillLabel}
            </Button>
          ) : null}
        </div>
        {canFill ? (
          <small className="muted jianshu-handoff-note">
            {!form.value.accountId
              ? "选择简书账号后即可填写官网草稿。"
              : filled
                ? "打开同一篇官网草稿，核对已填写内容；发布仍需你在简书确认。"
                : draftUrl
                  ? "继续使用同一篇官网草稿。修改后的内容将重新填写，请先确认简书中没有需要保留的编辑。"
                  : "将标题、正文和配图填写到所选账号的简书草稿，完成后请在简书核对并手动发布。"}
          </small>
        ) : null}
      </div>
      {confirmNewDraft && draftUrl && !article.receiptUrl ? (
        <Dialog
          title="改用新的官网草稿"
          busy={busy}
          onClose={() => setConfirmNewDraft(false)}
          footer={
            <>
              <Button disabled={busy} onClick={() => setConfirmNewDraft(false)}>
                取消
              </Button>
              <Button
                primary
                disabled={busy}
                onClick={() =>
                  void run("newDraft", async () => {
                    const next = await ipc("jianshu.resolve", {
                      ...versionArgs(detail),
                      notPublished: true,
                      newDraft: true,
                    });
                    apply(next);
                    if (alive.current) setConfirmNewDraft(false);
                  })
                }
              >
                {pending === "newDraft"
                  ? "正在解除关联…"
                  : "确认未发布，改用新草稿"}
              </Button>
            </>
          }
        >
          <p>
            请先确认文章尚未发布。确认后解除当前关联，原官网草稿继续保留，本地文章、配图和历史版本也会保留。
          </p>
          <p>
            下次点击“填写到简书”将新建一篇草稿。若原稿仍在上传图片或保存，请先等待官网处理结束。
          </p>
          {failure ? <Notice danger>{failure}</Notice> : null}
        </Dialog>
      ) : null}
      {confirmImageRetry && pendingImage ? (
        <Dialog
          title="确认图片未上传"
          busy={busy}
          onClose={() => setConfirmImageRetry(false)}
          footer={
            <>
              <Button
                disabled={busy}
                onClick={() => setConfirmImageRetry(false)}
              >
                取消
              </Button>
              <Button
                primary
                disabled={busy}
                onClick={() =>
                  void run("resolveImage", async () => {
                    const next = await ipc("jianshu.resolve", {
                      ...versionArgs(detail),
                      notPublished: true,
                      imageNotUploaded: true,
                    });
                    apply(next);
                    if (alive.current) setConfirmImageRetry(false);
                  })
                }
              >
                {pending === "resolveImage"
                  ? "正在确认…"
                  : "已检查，确认未上传"}
              </Button>
            </>
          }
        >
          <p>
            请确认上一张配图未出现在官网草稿中，并且文章尚未发布。确认后将返回本地草稿，你可以再次点击“重新填写原草稿”上传。
          </p>
          {failure ? <Notice danger>{failure}</Notice> : null}
        </Dialog>
      ) : null}
    </div>
  );
}
