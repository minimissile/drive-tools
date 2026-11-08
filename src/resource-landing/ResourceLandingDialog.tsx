import { AiIcon } from "../ui/AiIcon";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import { Check, ExternalLink, Eye, FileText, Pencil } from "lucide-react";
import {
  landingDraftSchema,
  landingEditableDraftSchema,
  landingDescriptionLimit,
  type LandingContext,
  type LandingDraft,
} from "../../shared/resource-landing";
import { isLandingDocument } from "../../shared/landing-document";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppData } from "../state";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Status,
} from "../ui/primitives";
import "./landing-editor.css";
import { LandingTrafficPanel } from "./LandingTrafficPanel";

function LandingProse({ text }: { text: string }) {
  return text
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block, i) => {
      const lines = block.trim().split("\n");
      const marker = /^\s*(?:[-*•]|\d+[.、)])\s*/;
      return lines.every((line) => marker.test(line)) ? (
        <ul key={i}>
          {lines.map((line, j) => (
            <li key={j}>{line.replace(marker, "")}</li>
          ))}
        </ul>
      ) : (
        <p key={i}>{block}</p>
      );
    });
}

// Incomplete edits also survive a refresh; publication uses the strict domain schema.
const editSchema = z.object({
  notes: z.string().max(8000),
  version: z.number().int().nonnegative(),
  article: landingEditableDraftSchema.nullable(),
});

export function ResourceLandingDialog({
  resourceId,
  onClose,
}: {
  resourceId: string;
  onClose(): void;
}) {
  const query = useIpcQuery(
    "resourceLanding.get",
    { resourceId },
    { keepPrevious: true, refreshInterval: 3000 },
  );
  const [result, setResult] = useState<LandingContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    // Publishing changes state without necessarily changing the draft version.
    if (query.data && !busy) setResult(query.data);
  }, [query.data]);
  const context = result ?? query.data;
  return (
    <Dialog
      title="资源落地页"
      className="landing-editor-dialog"
      busy={busy}
      onClose={onClose}
      focus="container"
      footer={<div className="landing-editor-footer" ref={setFooterHost} />}
    >
      <QueryError
        title="落地页资料读取失败"
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!context && query.loading ? (
        <LoadingState label="正在读取落地页资料…" />
      ) : null}
      {context ? (
        <LandingEditor
          key={resourceId}
          context={context}
          footerHost={footerHost}
          setBusy={setBusy}
          onResult={(value) => {
            setResult(value);
            query.reload();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function LandingEditor({
  context,
  setBusy,
  onResult,
  footerHost,
}: {
  context: LandingContext;
  setBusy(value: boolean): void;
  onResult(value: LandingContext): void;
  footerHost: HTMLDivElement | null;
}) {
  const { data } = useAppData(),
    { notify } = useAppActions();
  const local = useLocalDraft(
    `panxu-landing-v1:${data!.dataPath}:${context.resourceId}`,
    {
      notes: context.notes,
      version: context.draftVersion,
      article: context.draft,
    },
    (value) => editSchema.parse(value),
  );
  const { article, notes, version } = local.value;
  const [mode, setMode] = useState<"edit" | "preview">("edit"),
    [action, setAction] = useState(""),
    [error, setError] = useState("");
  const lock = useRef(false);
  const busy = !!action || context.generating;
  const dirty = JSON.stringify(article) !== JSON.stringify(context.draft);
  const conflict = version !== context.draftVersion && dirty;
  const notesChanged = notes.trim() !== context.notes.trim();
  const needsOptimization =
    !!article &&
    (!context.quality?.eligible || dirty || context.stale || notesChanged);
  const published = !!context.published?.document;
  const hasUnpublishedChanges =
    published &&
    JSON.stringify(article) !==
      JSON.stringify(context.published?.document?.article);
  const adopt = (next: LandingContext) => {
    local.update({
      article: next.draft,
      version: next.draftVersion,
      notes: next.notes,
    });
    onResult(next);
  };
  const run = async (
    name: string,
    request: () => Promise<LandingContext>,
    message: string,
    replace = false,
  ) => {
    if (lock.current || busy) return;
    lock.current = true;
    setAction(name);
    setBusy(true);
    setError("");
    try {
      const next = await request();
      if (replace) adopt(next);
      else onResult(next);
      if (
        name === "read" &&
        JSON.stringify(next.source.documents) ===
          JSON.stringify(context.source.documents)
      ) {
        notify("正文依据未更改。", "info");
        return;
      }
      const needsWork =
        (name === "generate" || name === "optimize") && !next.quality?.eligible;
      notify(
        needsWork
          ? name === "optimize"
            ? "优化已完成，仍有待完善内容，请查看检查结果。"
            : "草稿已生成，内容尚需完善。"
          : next.pending || next.error
            ? "操作结果需要核对，请查看当前状态。"
            : message,
        next.pending || next.error || needsWork ? "warning" : "success",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "操作未完成，请重新读取状态。",
      );
      // Local read only: never replay an AI request or publication on failure.
      try {
        onResult(
          await ipc("resourceLanding.get", { resourceId: context.resourceId }),
        );
      } catch {
        /* Preserve edits. */
      }
    } finally {
      lock.current = false;
      setAction("");
      setBusy(false);
    }
  };
  const save = async (publish: boolean) => {
    const parsed = landingDraftSchema.safeParse(article);
    if (!parsed.success) {
      if (article && article.description.length > landingDescriptionLimit) {
        setError(
          `搜索摘要共${article.description.length}字，请精简到${landingDescriptionLimit}字以内后保存。`,
        );
        return;
      }
      setError(
        `内容尚未完整：${parsed.error.issues[0]?.path.join(" · ")}。请检查标题、摘要与正文；要点和问答可留空。`,
      );
      return;
    }
    if (notes.trim() !== context.notes.trim()) {
      setError("编辑补充已变化，请重新生成，让正文与依据保持一致。");
      return;
    }
    await run(
      publish ? "publish" : "save",
      async () => {
        const saved = dirty
          ? await ipc("resourceLanding.saveDraft", {
              resourceId: context.resourceId,
              expectedDraftVersion: version,
              draft: parsed.data,
            })
          : context;
        adopt(saved);
        return publish
          ? ipc("resourceLanding.publish", {
              resourceId: context.resourceId,
              expectedDraftVersion: saved.draftVersion,
            })
          : saved;
      },
      publish
        ? "落地页已发布，资源目录与站点地图已更新。"
        : "落地页草稿已保存。",
      true,
    );
  };
  const change = (patch: Partial<LandingDraft>) => {
    if (article) local.update({ article: { ...article, ...patch } });
  };
  const section = (
    index: number,
    patch: Partial<LandingDraft["sections"][number]>,
  ) =>
    change({
      sections: article!.sections.map((s, i) =>
        i === index ? { ...s, ...patch } : s,
      ),
    });
  const faq = (index: number, patch: Partial<LandingDraft["faq"][number]>) =>
    change({
      faq: article!.faq.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    });
  const issue = error || context.error || local.error;
  const optimize = () => {
    if (!article || conflict) return;
    void run(
      "optimize",
      () =>
        ipc("resourceLanding.optimize", {
          resourceId: context.resourceId,
          requestId: crypto.randomUUID(),
          expectedDraftVersion: version,
          notes,
          draft: article,
        }),
      "草稿已优化并通过内容检查，尚未发布。",
      true,
    );
  };
  return (
    <>
      <div className="landing-editor-top">
        <div>
          <strong>{context.source.resourceTitle}</strong>
          <p>依据实际正文介绍资源，通过内容审核后发布。</p>
        </div>
        <Status
          kind={
            hasUnpublishedChanges ? "warning" : published ? "good" : "normal"
          }
        >
          {hasUnpublishedChanges
            ? "有未发布修改"
            : published
              ? "已发布"
              : article
                ? "内容草稿"
                : "尚未生成"}
        </Status>
      </div>
      {issue || needsOptimization || action === "optimize" ? (
        <Notice warning>
          <div className="landing-optimization">
            <div role="status">
              <strong>
                {action === "optimize"
                  ? "正在优化并重新审核…"
                  : issue ||
                    (context.stale || notesChanged
                      ? "资料已更新，可根据最新依据优化草稿。"
                      : dirty
                        ? "当前编辑可检查并优化。"
                        : "内容尚未达到发布要求。")}
              </strong>
              {needsOptimization ? (
                <p>
                  {action === "optimize"
                    ? "完成后更新草稿；若依据不足，会保留待完善项。"
                    : "根据当前草稿和检查问题修订，完成后重新审核，不自动发布。"}
                </p>
              ) : null}
            </div>
            {needsOptimization ? (
              <Button
                size="compact"
                disabled={
                  busy ||
                  context.pending ||
                  conflict ||
                  !context.source.documents?.length
                }
                onClick={optimize}
              >
                <AiIcon size={14} />
                {action === "optimize" ? "正在优化…" : "自动优化"}
              </Button>
            ) : null}
          </div>
        </Notice>
      ) : null}
      {context.pending ? (
        <Notice warning>
          上次发布结果待核对。请重试原操作或读取云端状态，无需重新生成内容。
        </Notice>
      ) : null}
      {conflict ? (
        <Notice warning>
          其他窗口已有新草稿，当前编辑已保留。
          <Button quiet size="compact" onClick={() => adopt(context)}>
            采用最新草稿
          </Button>
        </Notice>
      ) : null}
      <div className="landing-editor-grid">
        <aside className="landing-editor-aside">
          <section>
            <h3>生成依据</h3>
            <p className="landing-editor-help">
              先读取一份核心文件，再生成介绍。支持20MB以内的 PDF、DOCX、TXT 和
              Markdown。
            </p>
            <details open={context.source.files.length <= 3}>
              <summary>
                {context.source.files.length} 项文件记录 ·{" "}
                {context.source.category}
              </summary>
              <ul className="landing-document-list">
                {context.source.files.map((f) => (
                  <li key={f.evidenceId}>
                    <span>{f.name}</span>
                    {!f.directory && isLandingDocument(f.name) ? (
                      <div className="landing-reading-actions">
                        <Button
                          size="compact"
                          disabled={busy || context.pending}
                          onClick={() =>
                            void run(
                              "read",
                              () =>
                                ipc("resourceLanding.readDocument", {
                                  resourceId: context.resourceId,
                                  fileEvidenceId: f.evidenceId,
                                }),
                              "正文已读取，重新生成可使用最新依据。",
                            )
                          }
                        >
                          读取正文
                        </Button>
                        <Button
                          size="compact"
                          quiet
                          disabled={busy || context.pending}
                          onClick={() =>
                            void run(
                              "read",
                              () =>
                                ipc("resourceLanding.readDocument", {
                                  resourceId: context.resourceId,
                                  fileEvidenceId: f.evidenceId,
                                  local: true,
                                }),
                              "本地正文读取完成。",
                            )
                          }
                        >
                          导入原文件
                        </Button>
                      </div>
                    ) : (
                      <p className="landing-editor-help">
                        {f.directory
                          ? "文件夹不能直接读取正文，请绑定其中的具体文档。"
                          : /\.doc$/i.test(f.name)
                            ? "旧版DOC暂不支持，请另存为DOCX或PDF。"
                            : "此格式暂不支持正文读取，请使用PDF、DOCX或文本原文件。"}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
            {action === "read" ? (
              <p className="landing-editor-help" role="status">
                正在读取文件并提取正文…
              </p>
            ) : null}
            {context.source.documents?.length ? (
              context.source.documents.map((d) => (
                <p className="landing-editor-help" key={d.sha256}>
                  已读取《{d.name}》
                  {/\.pdf$/i.test(d.name)
                    ? `${d.pages.length}/${d.pageCount}页${d.sampled ? "（抽样文字）" : "文字"}，正文与页码可追溯。`
                    : `${d.sampled ? "部分" : "全文"}文字，引用按文本片段定位。`}
                </p>
              ))
            ) : (
              <p className="landing-editor-help">
                {context.source.files.some(
                  (f) => !f.directory && isLandingDocument(f.name),
                )
                  ? "读取上方文件正文后，即可生成草稿。"
                  : "当前文件尚不能读取正文，请绑定支持的文档后再生成。"}
              </p>
            )}
            <Field label="编辑补充" hint="仅填写可公开、已核实的信息">
              <textarea
                rows={6}
                maxLength={8000}
                aria-label="落地页编辑补充"
                placeholder="例如适用场景、文件的实际内容、使用限制。请勿填写账号或联系方式。"
                value={notes}
                disabled={busy}
                onChange={(e) => local.update({ notes: e.target.value })}
              />
            </Field>
            <Button
              primary={!article}
              disabled={
                busy || context.pending || !context.source.documents?.length
              }
              onClick={() =>
                void run(
                  "generate",
                  () =>
                    ipc("resourceLanding.generate", {
                      resourceId: context.resourceId,
                      requestId: crypto.randomUUID(),
                      notes,
                    }),
                  "草稿已生成并完成内容检查。",
                  true,
                )
              }
            >
              <AiIcon size={14} />
              {action === "generate" || context.generating
                ? "正在撰写并检查…"
                : article
                  ? "重新生成草稿"
                  : "生成落地页草稿"}
            </Button>
            <p className="landing-editor-help">
              只按材料的信息量撰写，不强凑字数或问答。独立审核未通过时修订一次，生成不自动发布。
            </p>
          </section>
          <section>
            <h3>发布检查</h3>
            {context.quality ? (
              <>
                <p className="landing-editor-quality">
                  <Status
                    kind={
                      context.quality.eligible && !dirty && !context.stale
                        ? "good"
                        : "warning"
                    }
                  >
                    {context.stale
                      ? "资料已更新，需重新生成"
                      : dirty
                        ? "已编辑，发布时重新检查"
                        : context.quality.eligible
                          ? "内容检查通过"
                          : "需要完善"}
                  </Status>
                </p>
                <p className="landing-editor-help">
                  内部内容审核：{(context.quality.score / 10).toFixed(1)} /
                  10，发布门槛8.2。此分数不代表搜索平台评分或收录结果。
                </p>
                <dl className="landing-quality-dimensions">
                  {context.quality.dimensions.map((d) => (
                    <div key={d.label}>
                      <dt>{d.label}</dt>
                      <dd>
                        {d.score}/{d.max}
                      </dd>
                    </div>
                  ))}
                </dl>
                <ul className="landing-checks">
                  {context.quality.checks.map((c) => (
                    <li key={c.label} className={c.ok ? "passed" : ""}>
                      <Check size={13} aria-hidden="true" />
                      {c.label}
                    </li>
                  ))}
                </ul>
                {context.quality.issues.length ? (
                  <details className="landing-editor-warning">
                    <summary>查看待修改内容</summary>
                    <ul>
                      {context.quality.issues.map((text) => (
                        <li key={text}>{text}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="landing-editor-help">
                生成内容后检查文件依据、事实引用、内容完整性与重复内容。
              </p>
            )}
            {context.targetIssue ? (
              <p className="landing-editor-warning">{context.targetIssue}</p>
            ) : null}
            <p className="landing-editor-help">
              通过检查并发布后才进入公开目录与站点地图。收录与引用由搜索服务决定。
            </p>
          </section>
          <LandingTrafficPanel
            resourceId={context.resourceId}
            pageUrl={context.pageUrl}
            published={published}
          />
        </aside>
        <section className="landing-editor-main" aria-label="落地页内容">
          <div
            className="landing-editor-tabs"
            role="group"
            aria-label="内容视图"
          >
            <Button
              size="compact"
              quiet={mode !== "edit"}
              aria-pressed={mode === "edit"}
              onClick={() => setMode("edit")}
            >
              <Pencil size={13} />
              编辑内容
            </Button>
            <Button
              size="compact"
              quiet={mode !== "preview"}
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
            >
              <Eye size={14} />
              阅读预览
            </Button>
            {dirty ? <span>有未保存修改</span> : null}
          </div>
          {!article ? (
            <Empty
              icon={FileText}
              title={
                action === "read"
                  ? "正在读取资源正文"
                  : action === "generate"
                    ? "正在生成可公开的资源说明"
                    : context.source.documents?.length
                      ? "正文已就绪，可以生成草稿"
                      : "先读取一份资源正文"
              }
            >
              {action === "read"
                ? "正在提取文件中的文字，完成后即可生成介绍。"
                : action === "generate"
                  ? "正在撰写并独立检查事实依据，通常需要一到三分钟，修订可能更久。完成后可以编辑和预览。"
                  : context.source.documents?.length
                    ? "点击左侧“生成落地页草稿”，完成后可编辑、审核并发布。"
                    : "在左侧读取网盘文档，或导入同名原文件，再按需补充已核实的信息。"}
            </Empty>
          ) : mode === "preview" ? (
            <article className="landing-reading-preview">
              <h1>{article.title}</h1>
              <p className="landing-preview-summary">{article.summary}</p>
              {article.highlights.length ? (
                <ul>
                  {article.highlights.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              ) : null}
              {article.sections.map((s, i) => (
                <section key={i}>
                  <h2>{s.heading}</h2>
                  {s.kind === "guide" ? <small>使用建议</small> : null}
                  <LandingProse text={s.body} />
                </section>
              ))}
              {article.faq.length ? (
                <section>
                  <h2>常见问题</h2>
                  {article.faq.map((f, i) => (
                    <div key={i}>
                      <h3>{f.question}</h3>
                      <p>{f.answer}</p>
                    </div>
                  ))}
                </section>
              ) : null}
            </article>
          ) : (
            <fieldset disabled={busy} className="landing-editor-fields">
              <Field label="页面标题" hint={`${article.title.length} / 90`}>
                <input
                  aria-label="落地页标题"
                  maxLength={90}
                  value={article.title}
                  onChange={(e) => change({ title: e.target.value })}
                />
              </Field>
              <Field
                label="搜索摘要"
                hint={`完整句子，最多${landingDescriptionLimit}字`}
              >
                <textarea
                  aria-label="落地页搜索摘要"
                  rows={3}
                  maxLength={landingDescriptionLimit}
                  value={article.description}
                  onChange={(e) => change({ description: e.target.value })}
                />
              </Field>
              <Field label="资源概述">
                <textarea
                  aria-label="落地页资源概述"
                  rows={4}
                  maxLength={600}
                  value={article.summary}
                  onChange={(e) => change({ summary: e.target.value })}
                />
              </Field>
              <Field label="资源要点" hint="可留空，每行一项，最多6项">
                <textarea
                  aria-label="落地页资源要点"
                  rows={4}
                  value={article.highlights.join("\n")}
                  onChange={(e) =>
                    change({
                      highlights: e.target.value
                        ? e.target.value.split("\n").slice(0, 6)
                        : [],
                    })
                  }
                />
              </Field>
              {article.sections.map((s, i) => (
                <section className="landing-edit-block" key={i}>
                  <div className="landing-edit-block-label">
                    <h3>正文 {i + 1}</h3>
                    <span>{s.kind === "facts" ? "事实说明" : "使用建议"}</span>
                  </div>
                  <Field label="小标题">
                    <input
                      aria-label={`正文 ${i + 1} 标题`}
                      maxLength={70}
                      value={s.heading}
                      onChange={(e) => section(i, { heading: e.target.value })}
                    />
                  </Field>
                  <Field label="段落内容">
                    <textarea
                      aria-label={`正文 ${i + 1} 内容`}
                      rows={7}
                      maxLength={4000}
                      value={s.body}
                      onChange={(e) => section(i, { body: e.target.value })}
                    />
                  </Field>
                </section>
              ))}
              <section className="landing-edit-block">
                <h3>常见问题</h3>
                {article.faq.map((f, i) => (
                  <div className="landing-edit-faq" key={i}>
                    <Field label={`问题 ${i + 1}`}>
                      <input
                        aria-label={`问题 ${i + 1}`}
                        maxLength={100}
                        value={f.question}
                        onChange={(e) => faq(i, { question: e.target.value })}
                      />
                    </Field>
                    <Field label="回答">
                      <textarea
                        aria-label={`回答 ${i + 1}`}
                        rows={4}
                        maxLength={900}
                        value={f.answer}
                        onChange={(e) => faq(i, { answer: e.target.value })}
                      />
                    </Field>
                  </div>
                ))}
              </section>
            </fieldset>
          )}
        </section>
      </div>
      {footerHost
        ? createPortal(
            <>
              <div className="landing-editor-cloud">
                <Button
                  quiet
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      "refresh",
                      () =>
                        ipc("resourceLanding.refresh", {
                          resourceId: context.resourceId,
                        }),
                      "已读取云端状态。",
                    )
                  }
                >
                  读取云端状态
                </Button>
                {published ? (
                  <Button
                    quiet
                    size="compact"
                    disabled={busy || context.pending}
                    onClick={() =>
                      void run(
                        "unpublish",
                        () =>
                          ipc("resourceLanding.unpublish", {
                            resourceId: context.resourceId,
                          }),
                        "已撤下公开内容，固定领取入口保留。",
                      )
                    }
                  >
                    撤下公开内容
                  </Button>
                ) : null}
              </div>
              {context.pageUrl ? (
                <Button
                  quiet
                  size="compact"
                  disabled={busy || !published}
                  onClick={() =>
                    void ipc("system.external", { url: context.pageUrl! })
                  }
                >
                  <ExternalLink size={13} />
                  查看公开页
                </Button>
              ) : null}
              {context.pending ? (
                <Button
                  primary
                  disabled={busy}
                  onClick={() =>
                    void run(
                      "retry",
                      () =>
                        ipc("resourceLanding.retry", {
                          resourceId: context.resourceId,
                        }),
                      "发布状态已核对。",
                    )
                  }
                >
                  重试原发布
                </Button>
              ) : (
                <>
                  <Button
                    disabled={busy || !article || conflict || !dirty}
                    onClick={() => void save(false)}
                  >
                    {action === "save" ? "正在保存…" : "保存草稿"}
                  </Button>
                  <Button
                    primary
                    disabled={
                      busy ||
                      !article ||
                      conflict ||
                      context.stale ||
                      !context.canPublish
                    }
                    onClick={() => void save(true)}
                  >
                    {action === "publish"
                      ? "正在检查并发布…"
                      : dirty
                        ? "保存并发布"
                        : published
                          ? "更新发布"
                          : "发布落地页"}
                  </Button>
                </>
              )}
            </>,
            footerHost,
          )
        : null}
    </>
  );
}
