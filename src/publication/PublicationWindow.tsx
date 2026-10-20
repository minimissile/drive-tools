import { Select } from "../ui/Select";
import type { ReadyPublicationModel } from "./usePublicationPreparation";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { ExternalLink, Settings2 } from "lucide-react";
import { bindingEditorUrl, contentFormats } from "../../shared/channels";

export function PublicationWindow({
  model,
}: {
  model: Pick<
    ReadyPublicationModel,
    | "accountAlias"
    | "openSettings"
    | "draft"
    | "binding"
    | "bindings"
    | "setBindingId"
    | "bindingFormatReady"
    | "opened"
    | "publication"
    | "ownReady"
    | "deliveryDisabled"
    | "openWindow"
  >;
}) {
  const {
    accountAlias,
    openSettings,
    draft,
    binding,
    bindings,
    setBindingId,
    bindingFormatReady,
    opened,
    publication,
    ownReady,
    deliveryDisabled,
    openWindow,
  } = model;
  return (
    <>
      <div id="publication-window" tabIndex={-1}>
        <Panel title="指纹窗口" extra={<span className="tag">比特浏览器</span>}>
          <Field label="发布账号与窗口">
            <Select
              aria-label="发布账号窗口"
              value={binding?.id ?? ""}
              onValueChange={(nextValue) => setBindingId(nextValue)}
              items={[
                { value: "", label: "选择已绑定的窗口", disabled: true },
                ...bindings.map((b) => ({
                  value: b.id,
                  label: (
                    <>
                      {b.alias} · {b.windowId}
                    </>
                  ),
                })),
              ]}
            />
          </Field>
          <div className="property">
            <span>资源保存与分享账号</span>
            <span>{accountAlias}</span>
          </div>
          <div className="property">
            <span>本人分享</span>
            <span className={ownReady ? "good-text" : "danger-text"}>
              {ownReady ? "已核验，分发时再次检查" : "尚未通过归属核验"}
            </span>
          </div>
          <Field label="发布入口">
            <input
              value={
                binding ? bindingEditorUrl(binding, draft.contentFormat) : ""
              }
              readOnly
              placeholder="先设置平台账号与窗口映射"
            />
          </Field>
          {!bindingFormatReady ? (
            <Notice warning>
              此账号尚未核实当前窗口及“
              {contentFormats[draft.contentFormat].name}
              ”发布能力，请在设置中勾选实际具备的内容形式。
            </Notice>
          ) : null}
          <Notice>
            只打开对应形式的官方入口。请核对实际登录账号与编辑器、上传素材，并由你点击发布。
          </Notice>
          <div className="row">
            <Button
              primary
              disabled={!binding || deliveryDisabled}
              onClick={() => void openWindow()}
            >
              <ExternalLink size={14} />
              打开指定比特窗口
            </Button>
            <Button quiet onClick={() => openSettings("bindings")}>
              <Settings2 size={14} />
              设置映射
            </Button>
          </div>
          {!ownReady ? (
            <Notice warning>请先完成转存、文件归属核验和本人分享。</Notice>
          ) : null}
          {publication ? (
            <Notice>
              {publication.status === "submitted"
                ? "文章已提交 · 等待平台审核。通过后请核验文章页，再确认已发布。"
                : "当前版本已有确认发布记录。"}
            </Notice>
          ) : opened ? (
            <Notice>编辑器已打开 · 尚未记录发布结果</Notice>
          ) : null}
        </Panel>
      </div>
    </>
  );
}
