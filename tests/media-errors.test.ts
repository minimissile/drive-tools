import test from "node:test";
import assert from "node:assert/strict";
import { AppError, ServiceHttpError } from "../core/errors";
import { describeMediaError, mediaRejectionReason } from "../core/media-errors";

const context = {
  key: "private-api-key",
  model: "qwen/image",
  apiCallId: "call-one",
  kind: "image" as const,
  reference: true,
};
test("400/403/422真人面孔拒绝统一分类，保留原始原因与模型诊断", () => {
  for (const status of [400, 403, 422]) {
    const failure = describeMediaError(
      new ServiceHttpError(
        status,
        "The input content is suspected to include real human faces.",
        "MEDIA_REJECTED",
      ),
      context,
    );
    assert.equal(failure.code, "MEDIA_FACE_REJECTED");
    assert.match(failure.message, /疑似包含真人面孔/);
    assert.equal(failure.details?.model, "qwen/image");
    assert.equal(failure.details?.httpStatus, status);
    assert.equal(failure.details?.rejectionReason, "human-face");
  }
  const error = new ServiceHttpError(400, "Input rejected", "MEDIA_REJECTED");
  error.details = { remoteCode: "FaceDetectionSuspect" };
  assert.equal(mediaRejectionReason(error), "human-face");
});
test("审核拒绝与权限、限流、普通参数错误分别保留，不按HTTP400一概认定内容拒绝", () => {
  assert.equal(
    describeMediaError(
      new ServiceHttpError(400, "DataInspectionFailed", "MEDIA_REJECTED"),
      context,
    ).code,
    "MEDIA_POLICY_REJECTED",
  );
  assert.equal(
    describeMediaError(
      new ServiceHttpError(403, "Permission denied", "MEDIA_REJECTED"),
      context,
    ).code,
    "MEDIA_ACCESS_DENIED",
  );
  for (const [status, message] of [
    [400, "Missing aspect_ratio"],
    [429, "Rate limit"],
    [401, "Invalid key"],
  ] as const) {
    const e = new ServiceHttpError(status, message, "MEDIA_REJECTED");
    assert.equal(mediaRejectionReason(e), null);
    assert.equal(describeMediaError(e, context).code, "MEDIA_REJECTED");
  }
  assert.equal(mediaRejectionReason(new Error("real human faces")), null);
  assert.equal(
    describeMediaError(
      new AppError("MEDIA_OUTPUT_INVALID", "图片无法解码"),
      context,
    ).code,
    "MEDIA_OUTPUT_INVALID",
  );
});
test("媒体异常诊断不泄露凭据或参考图Base64", () => {
  const failure = describeMediaError(
    new ServiceHttpError(
      400,
      "private-api-key Bearer other-secret data:image/png;base64,aGVsbG8= FaceDetectionSuspect",
      "MEDIA_REJECTED",
    ),
    context,
  );
  assert(
    !/private-api-key|other-secret|aGVsbG8/.test(
      JSON.stringify(failure.details),
    ),
  );
  assert.equal(failure.details?.apiCallId, "call-one");
});
