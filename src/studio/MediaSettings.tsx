import { Select } from "../ui/Select";
import { Button, Field } from "../ui/primitives";
import { RefreshCw } from "lucide-react";

import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import type { MediaSettingsModel } from "./useMediaSettings";
export function MediaSettings({
  settings,
  hasJobs,
}: {
  settings: MediaSettingsModel;
  hasJobs: boolean;
}) {
  const { data } = useAppData(),
    { resource } = useAppSelection(),
    { navigate } = useAppNavigation(),
    { command } = useAppActions(),
    { busy } = useAppActivity();
  const {
    models,
    setModels,
    imageModel,
    setImageModel,
    videoModel,
    setVideoModel,
    reserve,
    setReserve,
    duration,
    setDuration,
    resolution,
    setResolution,
    audio,
    setAudio,
    reference,
    setReference,
    kind,
    model,
  } = settings;
  return (
    <div className="creative-media-settings">
      <div className="row">
        <Field label={kind === "video" ? "视频模型" : "图片模型"}>
          <Select
            aria-label="素材生成模型"
            value={kind === "video" ? videoModel : imageModel}
            disabled={busy > 0}
            onValueChange={(nextValue) => {
              if (kind === "video") {
                setVideoModel(nextValue);
                const m = models.find(
                  (v) => v.id === nextValue && v.kind === "video",
                );
                setDuration(m?.durations[0] ?? 8);
                setResolution(
                  m?.resolutions.includes("1080p")
                    ? "1080p"
                    : (m?.resolutions[0] ?? "720p"),
                );
                setAudio(false);
              } else setImageModel(nextValue);
              setReference(false);
            }}
            items={[
              { value: "", label: "请刷新并选择模型" },
              ...((kind === "video" ? videoModel : imageModel) && !model
                ? [
                    {
                      value: kind === "video" ? videoModel : imageModel,
                      label: "所选模型未在目录中，请刷新或更换",
                    },
                  ]
                : []),
              ...models
                .filter((m) => m.kind === kind)
                .map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        </Field>
        <Button
          disabled={busy > 0}
          onClick={async () => {
            const list = await command("studio.models");
            if (list) {
              setModels(list);
            }
          }}
        >
          <RefreshCw size={13} />
          刷新素材模型
        </Button>
      </div>
      <small>
        默认使用连接与设置中的{kind === "video" ? "动态视频" : "图片生成"}
        模型；此处更换只影响本次任务。刷新目录保留当前选择。
        <Button quiet onClick={() => navigate("settings")}>
          管理默认模型
        </Button>
      </small>
      {hasJobs ? (
        <small>
          以上模型及下方参数用于下一次生成，已有素材的实际规格见对应任务记录。
        </small>
      ) : null}
      {model ? (
        <small>
          支持比例：{model.ratios.join("、") || "按模型默认能力"}。报价信息：
          {model.pricing}
          <Button
            quiet
            onClick={() =>
              void command("system.external", {
                url: `https://openrouter.ai/${model.id.split("/").map(encodeURIComponent).join("/")}`,
              })
            }
          >
            查看模型报价
          </Button>
        </small>
      ) : null}
      {kind === "video" ? (
        <div className="row">
          <Field label="视频时长（秒）">
            {model?.durations.length ? (
              <Select
                aria-label="视频生成时长"
                value={duration}
                onValueChange={(nextValue) => setDuration(Number(nextValue))}
                items={[
                  ...model.durations.map((n) => ({
                    value: n,
                    label: <>{n}秒</>,
                  })),
                ]}
              />
            ) : (
              <input
                aria-label="视频生成时长"
                type="number"
                min={1}
                max={60}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            )}
          </Field>
          <Field label="分辨率">
            <Select
              aria-label="视频生成分辨率"
              value={resolution}
              onValueChange={(nextValue) => setResolution(nextValue)}
              items={[
                ...(model?.resolutions.length
                  ? model.resolutions
                  : ["720p"]
                ).map((r) => ({ value: r, label: r })),
              ]}
            />
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              aria-label="生成原生视频音频"
              disabled={!model?.audio}
              checked={audio}
              onChange={(e) => setAudio(e.target.checked)}
            />
            模型原生音频
          </label>
        </div>
      ) : null}
      <div className="row">
        <details open={data!.settings.dailyAiBudgetMicros != null}>
          <summary>
            费用预留
            {data!.settings.dailyAiBudgetMicros == null ? "（可选）" : ""}
          </summary>
          <Field
            label={
              kind === "video" ? "本次美元费用预留" : "每张图片美元费用预留"
            }
          >
            <input
              aria-label="素材费用预留"
              type="number"
              min="0.001"
              step="0.01"
              value={reserve}
              onChange={(e) => setReserve(e.target.value)}
            />
          </Field>
        </details>
        <label className="checkbox">
          <input
            type="checkbox"
            disabled={!model?.reference || !resource?.coverId}
            checked={reference}
            onChange={(e) => setReference(e.target.checked)}
          />
          {kind === "video" ? "以资源封面为首帧" : "使用资源封面作为参考"}
        </label>
      </div>
      <small>
        {data!.settings.dailyAiBudgetMicros == null
          ? "未设置每日金额上限，可直接生成；预留仅用于实际费用未返回时的本地估算。"
          : "预留金额计入每日AI美元预算，它是本地估算，服务商实际费用可能更高。"}
        完成后记录实际返回的费用。参考封面仅在勾选时发送。
      </small>
    </div>
  );
}
