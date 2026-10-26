import { useState } from "react";
import { ArrowRight, Eye, Save } from "lucide-react";
import { useAppActions, useAppActivity, useAppNavigation } from "../state";
import { ActionBar } from "../ui/ActionBar";
import { Button, Field, LoadingState, Notice } from "../ui/primitives";
import type { Draft } from "../../shared/types";
import CreativeEditor from "./CreativeEditor";
import { useWorkingCopy } from "./useWorkingCopy";

export default function DraftEditor({
  draft,
  onSaved,
  onContinue,
  continueLabel = "继续自动发布",
}: {
  draft: Draft;
  onSaved(id: string): void;
  onContinue?: () => void;
  continueLabel?: string;
}) {
  const { openDraft } = useAppNavigation(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const working = useWorkingCopy(draft);
  const {
    value: { title, body, tags, coverText, creative },
    dirty,
  } = working;
  const [preview, setPreview] = useState(false);
  const [mediaReady, setMediaReady] = useState(
    !draft.creative || draft.creative.format === "text",
  );
  if (working.loading) return <LoadingState label="正在恢复编辑内容…" />;
  return (
    <>
      <div className="studio-working-status" role="status" aria-live="polite">
        <span>
          {working.error
            ? working.error
            : dirty
              ? `${working.restored ? "已恢复上次编辑 · " : ""}${working.saving ? "正在暂存…" : "编辑已暂存到本地"} · 尚未保存为新版本`
              : `当前为已保存版本 v${draft.version}`}
        </span>
        <Button quiet onClick={() => setPreview((v) => !v)}>
          <Eye size={14} />
          {preview ? "编辑" : "预览"}
        </Button>
      </div>
      {preview ? (
        <article className="content-preview">
          <h2>{title}</h2>
          <div>{body}</div>
          <p>{tags}</p>
          {coverText ? <footer>封面文案：{coverText}</footer> : null}
        </article>
      ) : (
        <div className="fields">
          <Field label="标题">
            <input
              aria-label="内容标题"
              value={title}
              maxLength={200}
              disabled={busy > 0}
              onChange={(e) => working.update({ title: e.target.value })}
            />
          </Field>
          <Field label="正文 / 脚本">
            <textarea
              aria-label="内容正文"
              className="content-textarea"
              value={body}
              maxLength={30000}
              disabled={busy > 0}
              onChange={(e) => working.update({ body: e.target.value })}
            />
          </Field>
          <div className="field-pair">
            <Field label="话题" hint="空格分隔">
              <input
                aria-label="内容话题"
                value={tags}
                maxLength={3000}
                disabled={busy > 0}
                onChange={(e) => working.update({ tags: e.target.value })}
              />
            </Field>
            <Field label="封面文案">
              <input
                aria-label="内容封面文案"
                value={coverText}
                maxLength={300}
                disabled={busy > 0}
                onChange={(e) => working.update({ coverText: e.target.value })}
              />
            </Field>
          </div>
        </div>
      )}
      {creative && creative.format !== "text" ? (
        <CreativeEditor
          key={draft.id}
          draft={draft}
          value={creative}
          onChange={(creative) => working.update({ creative })}
          dirty={dirty}
          onReady={setMediaReady}
        />
      ) : null}
      {dirty ? (
        <Notice warning>
          {working.error
            ? "暂存遇到问题，请先保存当前修改。"
            : "当前修改已独立暂存。"}
          点击“保存修改”会生成新版本，并要求重新审阅。
        </Notice>
      ) : null}
      <div className="row editor-review">
        <label className="checkbox">
          <input
            aria-label="已人工审阅"
            type="checkbox"
            checked={draft.reviewed && !dirty}
            disabled={dirty || busy > 0 || !mediaReady}
            onChange={(e) =>
              void command("draft.review", {
                id: draft.id,
                reviewed: e.target.checked,
              })
            }
          />
          已核对资源事实、表达和渠道获取方式
        </label>
      </div>
      <small>
        不会把来源链接发给模型。图片与动态视频必须先生成实际文件；请核对素材与文案，平台要求的AI标识在发布后台填写。
      </small>
      <ActionBar
        label="稿件保存与发布"
        status={
          dirty
            ? "修改已暂存，保存为新版本后需要重新审阅。"
            : `已保存 v${draft.version} · ${draft.reviewed ? "已人工审阅" : "尚未审阅"}`
        }
      >
        <Button
          disabled={!dirty || busy > 0}
          onClick={async () => {
            const result = await command(
              "draft.save",
              {
                id: draft.id,
                title,
                body,
                tags: tags.split(/\s+/).filter(Boolean),
                coverText,
                ...(creative ? { creative } : {}),
              },
              "草稿版本已保存，请重新审阅。",
            );
            if (result) {
              try {
                await working.clear();
              } catch (e) {
                notify(
                  `版本已保存，但旧暂存清理失败：${(e as Error).message}`,
                  "warning",
                );
              }
              onSaved(result.id);
            }
          }}
        >
          <Save size={14} />
          保存修改
        </Button>
        {dirty ? (
          <Button
            quiet
            disabled={busy > 0 || working.saving}
            onClick={() => {
              if (
                window.confirm(
                  "放弃这份草稿尚未保存的修改，恢复当前已保存版本？",
                )
              )
                void working.reset().catch((e) => notify(e.message, "error"));
            }}
          >
            恢复已保存版本
          </Button>
        ) : null}
        <Button
          primary
          disabled={dirty || !draft.reviewed || busy > 0}
          onClick={() =>
            onContinue ? onContinue() : openDraft(draft, "publish")
          }
        >
          {onContinue ? continueLabel : "准备发布"} <ArrowRight size={15} />
        </Button>
      </ActionBar>
    </>
  );
}
