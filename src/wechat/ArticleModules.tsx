import { useRef, useState, type ClipboardEvent } from "react";
import { Eye, Plus } from "lucide-react";
import { z } from "zod";
import {
  wechatArticleModuleBodyLimit,
  wechatArticleModuleNameLimit,
  type WechatArticleModule,
} from "../../shared/wechat-article-modules";
import type { WechatTemplateId } from "../../shared/wechat-templates";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Button, Empty, Field, LoadingState, Notice } from "../ui/primitives";
import { wechatPreviewHtml } from "./image-preview";
import {
  wechatModuleClipboardHtmlLimit,
  wechatModuleMarkdownFromHtml,
} from "./module-paste";
import "./article-modules.css";

const moduleDraftSchema = z.object({
  name: z.string().max(wechatArticleModuleNameLimit),
  body: z.string().max(wechatArticleModuleBodyLimit),
  revision: z.number().int().positive().nullable(),
});

function readError(error: string) {
  return import.meta.env.DEV && error === "不支持此操作。"
    ? "正文模块需要加载新版后端。请点击顶部「应用更新并重启」后再试。"
    : error;
}

function ModulePreview({
  body,
  templateId,
}: {
  body: string;
  templateId?: WechatTemplateId;
}) {
  return (
    <section
      className="wechat-module-preview"
      aria-label="模块预览"
      tabIndex={0}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a"))
          event.preventDefault();
      }}
      dangerouslySetInnerHTML={{
        __html: wechatPreviewHtml(body, undefined, templateId),
      }}
    />
  );
}

function ModuleEditor({
  workspace,
  module,
  latest,
  onBack,
  onSaved,
}: {
  workspace: string;
  module: WechatArticleModule | null;
  latest: WechatArticleModule | undefined;
  onBack(): void;
  onSaved(modules: WechatArticleModule[]): void;
}) {
  const draft = useLocalDraft(
    `panxu:wechat:${workspace}:module:${module?.id ?? "new"}`,
    {
      name: module?.name ?? "",
      body: module?.body ?? "",
      revision: module?.revision ?? null,
    },
    moduleDraftSchema.parse,
  );
  const { notify } = useAppActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const lock = useRef(false);
  const { name, body, revision } = draft.value;
  const conflict = module && latest && latest.revision !== revision;
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const html = event.clipboardData.getData("text/html");
    if (!html) return;
    event.preventDefault();
    if (html.length > wechatModuleClipboardHtmlLimit) {
      notify("这段富文本内容较大，请分段粘贴。", "warning");
      return;
    }
    const converted = wechatModuleMarkdownFromHtml(html);
    const pasted = converted.body || event.clipboardData.getData("text/plain");
    if (!pasted.trim()) {
      notify("剪贴板里没有可用于模块的文字或图片。", "warning");
      return;
    }
    const input = event.currentTarget;
    const before = body.slice(0, input.selectionStart);
    const after = body.slice(input.selectionEnd);
    const block =
      converted.body &&
      (/\n\n/.test(pasted) ||
        /^(?:#{1,6} |>|[-+] |\d+[.)] |```|---)/.test(pasted));
    const prefix =
      block && before.trim()
        ? "\n".repeat(Math.max(0, 2 - (before.match(/\n*$/)?.[0].length ?? 0)))
        : "";
    const suffix =
      block && after.trim()
        ? "\n".repeat(Math.max(0, 2 - (after.match(/^\n*/)?.[0].length ?? 0)))
        : "";
    const next = before + prefix + pasted + suffix + after;
    if (next.length > wechatArticleModuleBodyLimit) {
      notify("粘贴后模块正文会超过 20,000 字，请分段选取。", "warning");
      return;
    }
    draft.update({ body: next });
    const caret = before.length + prefix.length + pasted.length;
    requestAnimationFrame(() => {
      if (document.activeElement === input)
        input.setSelectionRange(caret, caret);
    });
    if (converted.skippedImages)
      notify(
        `有 ${converted.skippedImages} 张图片无法从富文本读取。`,
        "warning",
      );
  };
  const save = async () => {
    if (lock.current || conflict || !name.trim() || !body.trim()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await ipc("wechat.saveModule", {
        id: module?.id,
        revision: revision ?? undefined,
        name,
        body,
      });
      draft.clear();
      onSaved(next);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "模块保存失败，请重试。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={module ? "编辑正文模块" : "新建正文模块"}
      className="wechat-module-dialog"
      busy={busy}
      onClose={onBack}
      footer={
        <>
          <Button
            quiet
            className="wechat-module-preview-toggle"
            disabled={busy || !body.trim()}
            onClick={() => setPreview(!preview)}
          >
            <Eye size={14} aria-hidden="true" />
            {preview ? "继续编辑" : "排版预览"}
          </Button>
          <Button disabled={busy} onClick={onBack}>
            返回模块列表
          </Button>
          <Button
            primary
            disabled={busy || !!conflict || !name.trim() || !body.trim()}
            onClick={() => void save()}
          >
            {busy ? "正在保存…" : "保存模块"}
          </Button>
        </>
      }
    >
      {conflict ? (
        <Notice warning>
          模块已有更新。本窗口的编辑仍在，请先复制需要保留的内容。
          <Button
            quiet
            size="compact"
            onClick={() => {
              draft.update({
                name: latest.name,
                body: latest.body,
                revision: latest.revision,
              });
              setError("");
            }}
          >
            载入最新版本
          </Button>
        </Notice>
      ) : error ? (
        <Notice danger>
          <span role="alert">{error}</span>
        </Notice>
      ) : null}
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      <Field label="模块名称" required>
        <input
          value={name}
          disabled={busy}
          maxLength={wechatArticleModuleNameLimit}
          onChange={(event) => draft.update({ name: event.target.value })}
        />
      </Field>
      {preview ? (
        <ModulePreview body={body} />
      ) : (
        <Field
          label="模块正文"
          hint="可直接粘贴富文本，也可编辑 Markdown"
          required
        >
          <textarea
            className="wechat-module-body"
            value={body}
            disabled={busy}
            maxLength={wechatArticleModuleBodyLimit}
            onChange={(event) => draft.update({ body: event.target.value })}
            onPaste={paste}
          />
        </Field>
      )}
    </Dialog>
  );
}

export function ArticleModuleManager({
  workspace,
  onClose,
}: {
  workspace: string;
  onClose(): void;
}) {
  const library = useIpcQuery("wechat.listModules", undefined, {
    keepPrevious: true,
  });
  const { notify } = useAppActions();
  const [editing, setEditing] = useState<WechatArticleModule | "new" | null>(
    null,
  );
  const [deleting, setDeleting] = useState<WechatArticleModule | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const remove = async () => {
    if (!deleting || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await ipc("wechat.deleteModule", {
        id: deleting.id,
        revision: deleting.revision,
      });
      library.setData(next);
      setDeleting(null);
      notify("模块已删除。", "success");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "模块删除失败，请重试。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (editing) {
    const module = editing === "new" ? null : editing;
    return (
      <ModuleEditor
        key={module?.id ?? "new"}
        workspace={workspace}
        module={module}
        latest={library.data?.find(({ id }) => id === module?.id)}
        onBack={() => setEditing(null)}
        onSaved={(next) => {
          library.setData(next);
          setEditing(null);
          notify("模块已保存。", "success");
        }}
      />
    );
  }
  if (deleting) {
    return (
      <Dialog
        title="删除正文模块"
        busy={busy}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button disabled={busy} onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void remove()}>
              {busy ? "正在删除…" : "删除模块"}
            </Button>
          </>
        }
      >
        <p>删除「{deleting.name}」？已插入的文章正文会保留。</p>
        {error ? (
          <Notice danger>
            <span role="alert">{error}</span>
          </Notice>
        ) : null}
      </Dialog>
    );
  }
  return (
    <Dialog
      title="模块管理"
      className="wechat-module-dialog"
      onClose={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <QueryError
        error={readError(library.error)}
        loading={library.loading}
        onRetry={library.reload}
      />
      {!library.data && !library.error ? (
        <LoadingState label="正在读取模块…" compact />
      ) : null}
      {library.data ? (
        <>
          <div className="wechat-module-library-bar">
            <Button primary size="compact" onClick={() => setEditing("new")}>
              <Plus size={15} aria-hidden="true" /> 新建模块
            </Button>
          </div>
          {library.data.length ? (
            <ul className="wechat-module-library">
              {library.data.map((module) => (
                <li key={module.id} className="wechat-module-row">
                  <div>
                    <strong>{module.name}</strong>
                    <p>{module.body.trim()}</p>
                  </div>
                  <div className="wechat-module-row-actions">
                    <Button
                      size="compact"
                      aria-label={`编辑模块：${module.name}`}
                      onClick={() => setEditing(module)}
                    >
                      编辑
                    </Button>
                    <Button
                      quiet
                      size="compact"
                      aria-label={`删除模块：${module.name}`}
                      onClick={() => {
                        setError("");
                        setDeleting(module);
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="还没有正文模块" compact />
          )}
        </>
      ) : null}
    </Dialog>
  );
}

export function InsertArticleModule({
  templateId,
  onInsert,
  onClose,
}: {
  templateId?: WechatTemplateId;
  onInsert(body: string): string | undefined;
  onClose(): void;
}) {
  const library = useIpcQuery("wechat.listModules", undefined, {
    keepPrevious: true,
  });
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const module = library.data?.find(({ id }) => id === selected);
  return (
    <Dialog
      title="添加正文模块"
      className="wechat-module-dialog"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            primary
            disabled={!module}
            onClick={() => {
              if (!module) return;
              const problem = onInsert(module.body);
              if (problem) setError(problem);
              else onClose();
            }}
          >
            添加到正文
          </Button>
        </>
      }
    >
      <QueryError
        error={readError(library.error)}
        loading={library.loading}
        onRetry={library.reload}
      />
      {!library.data && !library.error ? (
        <LoadingState label="正在读取模块…" compact />
      ) : null}
      {library.data?.length ? (
        <Field label="正文模块">
          <Select
            value={module?.id ?? ""}
            items={[
              { value: "", label: "选择要添加的模块", disabled: true },
              ...library.data.map(({ id, name }) => ({
                value: id,
                label: name,
              })),
            ]}
            onValueChange={(value) => {
              setSelected(value);
              setError("");
            }}
          />
        </Field>
      ) : library.data ? (
        <Empty title="暂无可添加的模块" compact>
          可在草稿箱顶部的「模块管理」中创建。
        </Empty>
      ) : null}
      {module ? (
        <ModulePreview body={module.body} templateId={templateId} />
      ) : null}
      {error ? (
        <Notice danger>
          <span role="alert">{error}</span>
        </Notice>
      ) : null}
    </Dialog>
  );
}
