import { AppError, safeMessage, ServiceHttpError } from "./errors";
import { cleanKnowledge } from "./knowledge-response";

/** Provider content refusals can arrive as HTTP 400, 403 or 422. */
export function mediaRejectionReason(error: unknown) {
  if (!(error instanceof AppError)) return null;
  const status = error instanceof ServiceHttpError ? error.status : undefined;
  if (status !== undefined && ![400, 403, 422].includes(status)) return null;
  if (
    status === undefined &&
    ![
      "MEDIA_REMOTE_ERROR",
      "MEDIA_REJECTED",
      "MEDIA_POLICY_REJECTED",
      "MEDIA_FACE_REJECTED",
    ].includes(error.code)
  )
    return null;
  const reason = `${error.message} ${String(error.details?.remoteCode ?? "")}`;
  if (
    /FaceDetectionSuspect|suspected\s+to\s+include\s+real\s+human\s+faces|real\s+human\s+faces/i.test(
      reason,
    )
  )
    return "human-face" as const;
  if (
    /terms\s+of\s+service|content[ _-]?policy|moderation|DataInspectionFailed|content[ _-]?filter/i.test(
      reason,
    )
  )
    return "content-policy" as const;
  return null;
}

export function describeMediaError(
  error: unknown,
  context: {
    key: string;
    model: string;
    apiCallId: string;
    kind: "image" | "video";
    reference: boolean;
  },
) {
  const reason = mediaRejectionReason(error);
  const providerReason = String(
    cleanKnowledge(safeMessage(error), context.key),
  ).replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[参考图已省略]");
  const label = context.kind === "image" ? "图片" : "视频";
  const code =
    reason === "human-face"
      ? "MEDIA_FACE_REJECTED"
      : reason === "content-policy"
        ? "MEDIA_POLICY_REJECTED"
        : error instanceof ServiceHttpError && error.status === 403
          ? "MEDIA_ACCESS_DENIED"
          : error instanceof AppError
            ? error.code
            : "MEDIA_UNCERTAIN";
  const message =
    reason === "human-face"
      ? `${label}服务检测到输入中疑似包含真人面孔，拒绝了本次生成。请更换其他素材；也可单独创作不含人物的主题插画。`
      : reason === "content-policy"
        ? `${label}服务商拒绝了本次${context.reference ? "参考图" : "主题生成"}请求。请检查素材与描述，或上传自己的图片。`
        : code === "MEDIA_ACCESS_DENIED"
          ? `当前连接无法使用此${label}模型。请在连接与设置中检查模型权限。`
          : providerReason;
  return new AppError(
    code,
    message,
    error instanceof AppError && error.uncertain,
    {
      apiCallId: context.apiCallId,
      model: context.model,
      kind: context.kind,
      mode: context.reference ? "reference" : "theme",
      providerReason,
      ...(error instanceof ServiceHttpError
        ? { httpStatus: error.status }
        : {}),
      ...(reason ? { rejectionReason: reason } : {}),
    },
  );
}
