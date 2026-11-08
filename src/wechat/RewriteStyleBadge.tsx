import {
  wechatRewriteStyleLabel,
  type WechatRewriteStyleId,
} from "../../shared/wechat-rewrite";

export function RewriteStyleBadge({
  styleId,
  showLabel = false,
}: {
  styleId?: WechatRewriteStyleId;
  showLabel?: boolean;
}) {
  const label = wechatRewriteStyleLabel(styleId);
  return (
    <span
      className="wechat-rewrite-style"
      title={styleId ? `最近一次成功改写：${label}` : "尚未记录改写风格"}
    >
      {showLabel ? `改写风格：${label}` : label}
    </span>
  );
}
