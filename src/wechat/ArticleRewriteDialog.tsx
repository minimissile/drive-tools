import { useId } from "react";
import {
  wechatRewriteStyleMeta,
  wechatRewriteStyles,
  type WechatRewriteStyleId,
} from "../../shared/wechat-rewrite";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { Button, Field, Notice } from "../ui/primitives";
import "./article-rewrite.css";
import type { WechatTrafficWordPlan } from "../../shared/wechat-traffic-words";
import { TrafficWordPriority } from "./TrafficWordPriority";

export function ArticleRewriteDialog({
  styleId,
  supportedStyles,
  instruction,
  wordCount,
  wordPlan,
  busy,
  disabled,
  error,
  onStyle,
  onInstruction,
  onRewrite,
  onClose,
}: {
  styleId: WechatRewriteStyleId;
  supportedStyles: readonly WechatRewriteStyleId[];
  instruction: string;
  wordCount: number;
  wordPlan: WechatTrafficWordPlan;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onStyle(value: WechatRewriteStyleId): void;
  onInstruction(value: string): void;
  onRewrite(): void;
  onClose(): void;
}) {
  const descriptionId = useId();
  const updateNoticeId = useId();
  const requiresUpdate = wechatRewriteStyles.some(
    ({ id }) => !supportedStyles.includes(id),
  );
  const unsupported = !supportedStyles.includes(styleId);
  return (
    <Dialog
      title="AI 改写文章"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            primary
            disabled={disabled || unsupported}
            onClick={onRewrite}
          >
            {busy ? "正在改写…" : "开始改写"}
          </Button>
        </>
      }
    >
      <p className="wechat-editor-dialog-copy">
        同时优化标题、正文和摘要，自动整理 Markdown
        排版，保留现有图片与网盘链接。
      </p>
      {error ? (
        <Notice danger>
          <span role="alert">{error}</span>
        </Notice>
      ) : null}
      <Field label="改写风格" hint="默认推荐自然润色">
        <Select
          aria-label="改写风格"
          aria-describedby={
            requiresUpdate
              ? `${descriptionId} ${updateNoticeId}`
              : descriptionId
          }
          value={styleId}
          disabled={disabled}
          items={wechatRewriteStyles.map(({ id, label }) => ({
            value: id,
            label,
            disabled: !supportedStyles.includes(id),
          }))}
          onValueChange={(value) => onStyle(value as WechatRewriteStyleId)}
        />
      </Field>
      <p id={descriptionId} className="wechat-editor-dialog-help muted">
        {wechatRewriteStyleMeta[styleId].description}
      </p>
      {requiresUpdate ? (
        <p id={updateNoticeId} className="wechat-editor-dialog-help muted">
          {import.meta.env.DEV
            ? "新增风格需点击顶部「应用更新并重启」后使用。"
            : "新增风格需要更新客户端后使用。"}
        </p>
      ) : null}
      <Field label="补充要求" hint="可选">
        <input
          disabled={disabled}
          maxLength={1000}
          value={instruction}
          onChange={(event) => onInstruction(event.target.value)}
          placeholder="例如缩短开头，保留操作步骤"
        />
      </Field>
      {wordCount ? (
        <TrafficWordPriority plan={wordPlan} wordCount={wordCount} />
      ) : (
        <p className="wechat-editor-dialog-help muted">
          尚未填写流量词，本次按原文正常改写。
        </p>
      )}
      <p className="wechat-editor-dialog-help muted">
        使用已配置的模型与预算。
      </p>
    </Dialog>
  );
}
