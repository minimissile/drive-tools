import { Select } from "../ui/Select";
import { SectionNav } from "../ui/SectionNav";
import { Button, Empty, Header, Notice } from "../ui/primitives";
import { ResourcePicker, ResourceRequired } from "../resources/components";
import { contentFormats } from "../../shared/channels";
import { platformSpecs } from "../../shared/platforms";
import { usePublicationPreparation } from "../publication/usePublicationPreparation";
import { PublicationContent } from "../publication/PublicationContent";
import { DeliveryOptions } from "../publication/DeliveryOptions";
import { PublicationWindow } from "../publication/PublicationWindow";
import { PublicationHistory } from "../publication/PublicationHistory";
import type { Platform } from "../../shared/types";
import "../studio/studio.css";

export default function Publish({ platform }: { platform?: Platform }) {
  const model = usePublicationPreparation(platform);
  const {
    draft,
    drafts,
    setDraftId,
    setBindingId,
    setIncludeLink,
    workingStatus,
    openDraft,
    navigate,
  } = model;
  return (
    <>
      <Header
        title={
          platform === "csdn"
            ? "CSDN 发布准备"
            : "准备好内容，再打开正确的窗口。"
        }
        description="复制素材 → 打开比特指定窗口 → 人工发布 → 回填内容链接。"
      />
      <ResourceRequired>
        <ResourcePicker />
        {draft ? (
          <>
            {!workingStatus.loading && workingStatus.blocked ? (
              <Notice warning>
                {workingStatus.error
                  ? `暂存状态读取失败：${workingStatus.error}`
                  : `这份稿件还有未保存的编辑。下方展示的是已保存版本 v${draft.version}，请先保存修改或恢复该版本后再交付。`}
                <Button quiet onClick={() => openDraft(draft)}>
                  继续编辑
                </Button>
              </Notice>
            ) : null}
            <div className="toolbar">
              <Select
                aria-label="待发布草稿"
                className="grow"
                value={draft.id}
                onValueChange={(nextValue) => {
                  setDraftId(nextValue);
                  setBindingId("");
                  setIncludeLink(false);
                }}
                items={[
                  ...drafts.map((d) => ({
                    value: d.id,
                    label: (
                      <>
                        {platformSpecs.find((p) => p.id === d.platform)?.name} ·{" "}
                        {contentFormats[d.contentFormat].name} · {d.title} · v
                        {d.version}
                      </>
                    ),
                  })),
                ]}
              />
              <span className="tag">
                {draft.reviewed ? "已人工审阅" : "尚未审阅"}
              </span>
            </div>
            <Notice warning={model.deliveryDisabled || !model.binding}>
              发布准备：{draft.reviewed ? "已审阅" : "尚未审阅"} ·{" "}
              {model.ownReady ? "本人分享已核验" : "本人分享待核验"} ·{" "}
              {model.binding
                ? model.bindingFormatReady
                  ? "发布窗口能力已核实"
                  : "窗口能力待核实"
                : "尚未配置发布窗口"}
              {!draft.reviewed || model.workingStatus.blocked ? (
                <Button quiet onClick={() => openDraft(draft)}>
                  前往编辑与审阅
                </Button>
              ) : null}
              {!model.binding || !model.bindingFormatReady ? (
                <Button quiet onClick={() => model.openSettings("bindings")}>
                  配置发布连接
                </Button>
              ) : null}
            </Notice>
            <SectionNav
              label="发布准备分区"
              items={[
                ["publication-content", "内容与素材"],
                ["publication-window", "窗口与发布"],
                ["publication-history", "记录与验收"],
              ]}
            />
            <div className="form-layout">
              <div>
                <div id="publication-content" tabIndex={-1}>
                  <PublicationContent model={{ ...model, draft }} />
                </div>
                <DeliveryOptions model={{ ...model, draft }} />
              </div>
              <div>
                <PublicationWindow model={{ ...model, draft }} />
                <div id="publication-history" tabIndex={-1}>
                  <PublicationHistory model={{ ...model, draft }} />
                </div>
              </div>
            </div>
          </>
        ) : (
          <Empty
            title={
              platform === "csdn"
                ? "此资源副本还没有 CSDN 草稿"
                : "此资源副本还没有草稿"
            }
            action={
              <Button
                primary
                onClick={() =>
                  navigate(platform === "csdn" ? "csdn-studio" : "studio")
                }
              >
                {platform === "csdn" ? "去创作 CSDN 教程" : "去内容工作室"}
              </Button>
            }
          >
            先生成或手工写稿，保存并完成审阅后再准备发布。
          </Empty>
        )}
      </ResourceRequired>
    </>
  );
}
