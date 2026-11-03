import { useState } from "react";
import type {
  OperationsSnapshot,
  OperationsTask,
} from "../../shared/intelligent-operations";
import { ipc } from "../api/client";
import type { Page } from "../state";
import { Dialog } from "../ui/Dialog";
import { CheckboxField } from "../ui/CheckboxField";
import { Button, Field, Notice } from "../ui/primitives";
import { channelNames } from "./labels";
import type { OperationAction } from "./useOperationAction";
import { useOperationDialog } from "./useOperationDialog";

function localDate(value: string | null) {
  const d = value ? new Date(value) : new Date();
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 16);
}
export function TaskDialog({
  task: t,
  kind,
  snapshot: s,
  busy,
  run,
  close,
  changed,
  navigate,
}: {
  task: OperationsTask;
  kind: "schedule" | "review" | "handoff";
  snapshot: OperationsSnapshot;
  busy: boolean;
  run: OperationAction;
  close(): void;
  changed(): void;
  navigate(page: Page): void;
}) {
  const [time, setTime] = useState(localDate(t.scheduledAt));
  const [confirmed, setConfirmed] = useState(false);
  const [url, setUrl] = useState("");
  const { error, submitting, submit } = useOperationDialog(run, close);
  const material = s.materials.find((m) => m.id === t.materialId);
  const title =
    kind === "schedule"
      ? "调整任务时间"
      : kind === "review"
        ? "审核本次微博内容"
        : "登记公众号交接";
  const apply = () => {
    const action =
      kind === "schedule"
        ? () =>
            ipc("intelligentOps.task.schedule", {
              id: t.id,
              scheduledAt: new Date(`${time}+08:00`).toISOString(),
            })
        : kind === "review"
          ? () =>
              ipc("intelligentOps.task.review", {
                id: t.id,
                fingerprint: t.fingerprint!,
                confirmed: true,
              })
          : () =>
              ipc("intelligentOps.task.handoff", {
                id: t.id,
                ...(url.trim() ? { url: url.trim() } : {}),
                confirmed: true,
              });
    void submit(
      action,
      kind === "schedule"
        ? "任务时间已调整，执行前仍会检查规则"
        : kind === "review"
          ? "本次内容版本已审核，改动后需重新审核"
          : "人工交接结果已登记",
      changed,
    );
  };
  return (
    <Dialog
      title={title}
      onClose={close}
      busy={submitting}
      footer={
        <>
          <Button size="compact" disabled={submitting} onClick={close}>
            返回
          </Button>
          <Button
            primary
            size="compact"
            disabled={
              busy ||
              (kind === "schedule"
                ? !time || !Number.isFinite(new Date(time).getTime())
                : !confirmed ||
                  (kind === "handoff" &&
                    (!material || material.fingerprint !== t.fingerprint)) ||
                  (kind === "review" &&
                    (!material || material.fingerprint !== t.fingerprint)))
            }
            onClick={apply}
          >
            {kind === "schedule"
              ? "保存时间"
              : kind === "review"
                ? "审核当前版本"
                : "登记已完成交接"}
          </Button>
        </>
      }
    >
      <div className="operations-dialog-form">
        {error ? (
          <div role="alert">
            <Notice danger>{error}</Notice>
          </div>
        ) : null}
        <p>
          <strong>{t.title}</strong>
          <br />
          <span className="operations-quiet">
            {t.accountLabel} · {channelNames[t.channel]}
          </span>
        </p>
        {kind === "schedule" ? (
          <>
            <Field label="预计执行时间（北京时间）">
              <input
                type="datetime-local"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </Field>
            <Notice>
              调整不会绕过执行时段、日额度或错峰间隔；已提交任务不能重新排期。
            </Notice>
          </>
        ) : kind === "review" ? (
          <>
            {material ? (
              <>
                <p>
                  可见范围：
                  {material.visibility === "self"
                    ? "仅自己可见"
                    : material.visibility === "public"
                      ? "公开"
                      : "未提供"}{" "}
                  · 图片 {material.imageCount ?? "待核对"} 张
                </p>
                <div className="operations-review-copy">{material.preview}</div>
                {material.images?.length ? (
                  <details open>
                    <summary>全部图片及指纹</summary>
                    <ul className="operations-image-fingerprints">
                      {material.images.map((image, index) => (
                        <li key={`${index}:${image.sha256}`}>
                          <strong>
                            {index + 1}. {image.name}
                          </strong>
                          <small>SHA-256 {image.sha256}</small>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <p className="operations-quiet">
                  本次内容指纹：{t.fingerprint}
                </p>
                {material.fingerprint !== t.fingerprint ? (
                  <Notice warning>
                    素材版本已经变化，请刷新计划并核对新版本后再审核。
                  </Notice>
                ) : null}
                {(material.imageCount ?? 0) > 0 ? (
                  <Button
                    quiet
                    size="compact"
                    onClick={() => {
                      close();
                      navigate("website-accounts");
                    }}
                  >
                    到账号管理检查原稿图片
                  </Button>
                ) : null}
              </>
            ) : (
              <Notice warning>
                当前素材已不在可读库存中，请刷新后重新安排。
              </Notice>
            )}
            <CheckboxField
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              label="我已核对本次账号、完整文案、图片和可见范围，允许按此版本安排发布"
            />
          </>
        ) : (
          <>
            <Notice>
              此步骤只登记你已经完成的公众号人工交接，不会自动登录或发布。
            </Notice>
            {material ? (
              <>
                <div className="operations-review-copy">{material.preview}</div>
                <p className="operations-quiet">
                  请核对完整原稿及当前内容版本后完成交接。
                </p>
                <p className="operations-quiet">内容版本：{t.fingerprint}</p>
                {material.fingerprint !== t.fingerprint ? (
                  <Notice warning>
                    原稿版本已经变化，请重新规划并核对新版本。
                  </Notice>
                ) : null}
              </>
            ) : (
              <Notice warning>当前原稿已不可读，请先到发布准备检查。</Notice>
            )}
            <Button
              size="compact"
              onClick={() => {
                close();
                navigate("publish");
              }}
            >
              到发布准备查看原稿
            </Button>
            <Field label="官方文章链接（选填）">
              <input
                value={url}
                maxLength={2000}
                placeholder="https://mp.weixin.qq.com/s/…"
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <CheckboxField
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              label="我已完成本项内容的人工交接"
            />
          </>
        )}
      </div>
    </Dialog>
  );
}
