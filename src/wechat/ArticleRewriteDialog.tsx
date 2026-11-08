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
          <Button primary disabled={disabled} onClick={onRewrite}>
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
          value={styleId}
          disabled={disabled}
          items={wechatRewriteStyles.map(({ id, label }) => ({
            value: id,
            label,
          }))}
          onValueChange={(value) => onStyle(value as WechatRewriteStyleId)}
        />
      </Field>
      <p className="wechat-editor-dialog-help muted">
        {wechatRewriteStyleMeta[styleId].description}
      </p>
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
