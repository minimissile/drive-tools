import { AppError } from "../core/errors";
import type { WechatDraftReceipt } from "../shared/wechat";

/** The successful save response is authoritative; no editor readback is required. */
export function decodeWechatDraftReceipt(
  response: Record<string, unknown>,
  expectedId?: string,
): WechatDraftReceipt {
  const result = response.base_resp as { ret?: number } | undefined;
  const rawId =
    response.appMsgId ?? response.appmsgid ?? response.appmsg_id ?? expectedId;
  const draftId =
    typeof rawId === "string" ||
    (typeof rawId === "number" && Number.isSafeInteger(rawId))
      ? String(rawId)
      : "";
  if (
    result?.ret !== 0 ||
    !/^[1-9]\d{0,29}$/.test(draftId) ||
    (expectedId && draftId !== expectedId)
  )
    throw new AppError(
      "WECHAT_DRAFT_UNCERTAIN",
      `未取得有效的微信草稿保存成功回执（${result?.ret ?? "无回执"}），请到微信草稿箱查看结果，避免重复创建。`,
    );
  return {
    draftId,
    url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${draftId}&lang=zh_CN`,
  };
}
