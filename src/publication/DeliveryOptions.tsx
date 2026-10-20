import { Select } from "../ui/Select";
import type { ReadyPublicationModel } from "./usePublicationPreparation";
import { Button, Field, Loading, Notice, Panel } from "../ui/primitives";
import { Copy, Download } from "lucide-react";
import { linkPositionLabels, type LinkPosition } from "../../shared/channels";
import { canUseLinkPosition } from "../../shared/publication";
import { Cover } from "../resources/components";

export function DeliveryOptions({
  model,
}: {
  model: Pick<
    ReadyPublicationModel,
    | "copy"
    | "resource"
    | "draft"
    | "binding"
    | "includeLink"
    | "setIncludeLink"
    | "linkPosition"
    | "setLinkPosition"
    | "positions"
    | "spec"
    | "allowSelectedPosition"
    | "splitTarget"
    | "bodyHasOwnLink"
    | "packageHasOwnLink"
    | "deliveryPrepared"
    | "deliveryDisabled"
    | "copyText"
    | "exportCover"
  >;
}) {
  const {
    copy,
    resource,
    draft,
    binding,
    includeLink,
    setIncludeLink,
    linkPosition,
    setLinkPosition,
    positions,
    spec,
    allowSelectedPosition,
    splitTarget,
    bodyHasOwnLink,
    packageHasOwnLink,
    deliveryPrepared,
    deliveryDisabled,
    copyText,
    exportCover,
  } = model;
  return (
    <>
      <Panel title="资源获取方式">
        <Notice warning={!packageHasOwnLink}>
          {deliveryPrepared
            ? "已选择单独准备资源入口字段；它不会进入正文，也尚未挂载到平台。请在获准位置填写并在发布后点击验证。"
            : bodyHasOwnLink
              ? "正文已包含当前资料的本人分享链接。发布后请从文章点击，核对文件与保存入口。"
              : packageHasOwnLink
                ? "复制或导出时将附加本人分享链接。发布后请从文章点击验证。"
                : "当前内容包未包含本人网盘链接，读者尚无已确认的网盘资源入口。可在获准场景附加本人分享；使用官方组件时，须实际挂载并点击验证。作者参考链接不代表已交付你的资源。"}
        </Notice>
        {draft.splitItemId ? (
          <div className="search-target-label">
            配套拆分资料：
            {splitTarget?.path ?? <Loading label="正在读取配套资料…" />}
          </div>
        ) : null}
        <Notice warning>{spec?.rule}</Notice>
        {positions.length ? (
          <>
            <Field
              label="资源入口位置"
              hint="仅列候选位置，是否可用取决于具体账号、内容形式和核实时间"
            >
              <Select
                aria-label="资源入口位置"
                value={linkPosition}
                onValueChange={(nextValue) => {
                  setLinkPosition(nextValue as LinkPosition);
                  setIncludeLink(false);
                }}
                items={[
                  ...positions.map((position) => ({
                    value: position,
                    label: (
                      <>
                        {linkPositionLabels[position]}
                        {canUseLinkPosition(
                          draft.platform,
                          binding,
                          draft.contentFormat,
                          position,
                        )
                          ? " · 已核实"
                          : " · 待核验"}
                      </>
                    ),
                  })),
                ]}
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeLink}
                disabled={!allowSelectedPosition}
                onChange={(e) => setIncludeLink(e.target.checked)}
              />
              {linkPosition === "body"
                ? "附加已核验的本人分享链接与提取码"
                : "单独准备本人资源入口字段（不进入正文）"}
            </label>
            {!allowSelectedPosition ? (
              <small>
                请先为此账号、内容形式及位置记录核实依据；链接权限有效期30天。
              </small>
            ) : null}
            {deliveryPrepared ? (
              <Button
                disabled={deliveryDisabled}
                onClick={() => void copyText("delivery")}
              >
                <Copy size={14} />
                复制资源入口字段
              </Button>
            ) : null}
          </>
        ) : (
          <p className="muted">此平台默认不附网盘URL、提取码或变体口令。</p>
        )}
        <div className="link-box">
          {draft.splitItemId
            ? (splitTarget?.shareUrl ?? "本人配套子链接正在读取或需恢复")
            : (copy?.shareUrl ?? "本人分享尚未生成")}
        </div>
      </Panel>
      {resource?.coverId ? (
        <Panel title="资源封面">
          <div className="publish-cover">
            <Cover id={resource.coverId} title={resource.title} large />
            <div>
              <p>{draft.coverText || "没有单独生成封面文案"}</p>
              <Button onClick={() => void exportCover()}>
                <Download size={14} />
                另存封面
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}
    </>
  );
}
