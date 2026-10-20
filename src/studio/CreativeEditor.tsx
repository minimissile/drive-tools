import { useEffect, useState } from "react";
import { Button, Notice, Panel } from "../ui/primitives";
import { useAppActions, useAppActivity } from "../state";
import type { CreativePackage } from "../../shared/studio";
import type { Draft } from "../../shared/types";
import { useMediaSettings } from "./useMediaSettings";
import { useStudioJobs } from "./useStudioJobs";
import { CreativePlan } from "./CreativePlan";
import { MediaSettings } from "./MediaSettings";
import { StudioAsset } from "./StudioAsset";
export default function CreativeEditor({
  draft,
  value,
  onChange,
  dirty,
  onReady,
}: {
  draft: Draft;
  value: CreativePackage;
  onChange(value: CreativePackage): void;
  dirty: boolean;
  onReady(value: boolean): void;
}) {
  const { command } = useAppActions(),
    { busy } = useAppActivity();
  const settings = useMediaSettings(value);
  const { kind, model, reserve, duration, resolution, audio, reference } =
    settings;
  const [autoPoll, setAutoPoll] = useState(true),
    [allowRepeat, setAllowRepeat] = useState(false);
  const { jobs, reload } = useStudioJobs(draft, autoPoll, dirty);
  const count = kind === "video" ? 1 : value.cards.length;
  const canGenerate =
    !!model && Number.isFinite(Number(reserve)) && Number(reserve) >= 0.001;
  const latest = (slot: number) =>
    jobs.findLast((j) => j.kind === kind && j.slot === slot);
  const untouched = Array.from({ length: count }, (_, i) => i).filter(
    (i) => !latest(i),
  );
  const completedCount = Array.from({ length: count }, (_, i) => i).filter(
    (slot) =>
      jobs.some(
        (j) =>
          j.kind === kind &&
          j.slot === slot &&
          j.status === "completed" &&
          j.asset,
      ),
  ).length;
  useEffect(() => {
    onReady(
      count > 0 &&
        Array.from({ length: count }, (_, i) =>
          jobs.some(
            (j) =>
              j.kind === kind &&
              j.slot === i &&
              j.status === "completed" &&
              j.asset,
          ),
        ).every(Boolean) &&
        !jobs.some(
          (j) =>
            !j.superseded &&
            ["submitting", "pending", "in_progress", "uncertain"].includes(
              j.status,
            ),
        ),
    );
  }, [jobs, count, kind, onReady]);
  const submit = async (slot: number) => {
    const previous = latest(slot);
    const result = await command("studio.submit", {
      draftId: draft.id,
      kind,
      slot,
      model: model!.id,
      reserveMicros: Math.round(Number(reserve) * 1_000_000),
      duration,
      resolution,
      audio,
      referenceCover: reference,
      regenerate:
        !!previous && (previous.status !== "uncertain" || allowRepeat),
    });
    reload();
    return result;
  };
  if (value.format === "text") return null;
  return (
    <Panel
      title={kind === "video" ? "动态视频方案与成品" : "图文方案与图片素材"}
      extra={
        <span className="tag">
          {kind === "video" ? "真实AI视频生成" : `${value.cards.length}张图片`}
        </span>
      }
      className="creative-editor"
    >
      <CreativePlan value={value} onChange={onChange} disabled={busy > 0} />
      <MediaSettings settings={settings} hasJobs={jobs.length > 0} />
      {dirty ? (
        <Notice warning>
          请先保存当前修改；保存会创建新版本，仅画面内容发生变化的素材需要重新生成。
        </Notice>
      ) : null}
      {kind === "image" && count > 1 ? (
        <small role="status">
          图片进度：已完成 {completedCount}/{count}{" "}
          张。修改正文可复用原图；修改某页画面或页面文字，只需重新生成对应页。
        </small>
      ) : null}
      {kind === "image" && count > 1 && untouched.length > 0 ? (
        <Button
          primary
          disabled={dirty || busy > 0 || !canGenerate || !untouched.length}
          onClick={async () => {
            for (const slot of untouched) {
              const result = await submit(slot);
              if (!result || result.status !== "completed") break;
            }
          }}
        >
          依次生成剩余 {untouched.length} 张图片（每张单独计费）
        </Button>
      ) : null}
      {Array.from({ length: count }, (_, slot) => (
        <StudioAsset
          key={slot}
          jobs={jobs}
          kind={kind}
          slot={slot}
          dirty={dirty}
          canGenerate={canGenerate}
          allowRepeat={allowRepeat}
          submit={submit}
          reload={reload}
        />
      ))}
      {jobs.some((j) => j.status === "uncertain" && !j.superseded) ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={allowRepeat}
            onChange={(e) => setAllowRepeat(e.target.checked)}
          />
          我已核对服务商任务记录，允许新建一次可能再次计费的生成
        </label>
      ) : null}
      {kind === "video" ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoPoll}
            onChange={(e) => setAutoPoll(e.target.checked)}
          />
          在此页面每30秒查询视频进度；只查询已存任务，不重新生成
        </label>
      ) : null}
    </Panel>
  );
}
