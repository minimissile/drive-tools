import { useIpcQuery } from "../api/useIpcQuery";
import { useDraftDeliveryStatus } from "./useDraftDeliveryStatus";
import { useEffect, useState } from "react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import {
  hasVerifiedFormat,
  channelProfiles,
  type LinkPosition,
} from "../../shared/channels";
import { platformSpecs } from "../../shared/platforms";
import { csdnHandoff } from "../../shared/csdn";
import {
  canUseLinkPosition,
  includesOwnShareLink,
} from "../../shared/publication";
import type { Draft } from "../../shared/types";

export function usePublicationPreparation() {
  const { data } = useAppData(),
    { copy, resource } = useAppSelection(),
    { navigate, openSettings, openSearch, openDraft } = useAppNavigation(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const [draftId, setDraftId] = useState(
      () => localStorage.getItem("panxu-publish-draft") ?? "",
    ),
    [bindingId, setBindingId] = useState(""),
    [includeLink, setIncludeLink] = useState(false),
    [publishedUrl, setPublishedUrl] = useState("");
  const [linkPosition, setLinkPosition] = useState<LinkPosition>("body");
  const drafts = data!.drafts.filter((d) => d.copyId === copy?.id),
    draft = drafts.find((d) => d.id === draftId) ?? drafts[0],
    spec = platformSpecs.find((p) => p.id === draft?.platform);
  const bindings = data!.bindings.filter((b) => b.platform === draft?.platform),
    binding = bindings.find((b) => b.id === bindingId) ?? bindings[0];
  useEffect(() => {
    if (draft) {
      try {
        localStorage.setItem("panxu-publish-draft", draft.id);
      } catch {}
    }
  }, [draft?.id]);
  const positions = draft ? channelProfiles[draft.platform].positions : [];
  const bindingFormatReady =
    !binding || (!!draft && hasVerifiedFormat(binding, draft.contentFormat));
  const allowSelectedPosition =
    !!draft &&
    canUseLinkPosition(
      draft.platform,
      binding,
      draft.contentFormat,
      linkPosition,
    );
  useEffect(() => {
    setIncludeLink(false);
    setLinkPosition(positions[0] ?? "body");
  }, [draft?.id, binding?.id]);
  const opened = data!.publications.some(
    (p) =>
      p.draftId === draft?.id &&
      p.draftVersion === draft?.version &&
      p.bindingId === binding?.id &&
      p.status === "opened",
  );
  const publication = data!.publications.find(
    (p) =>
      p.draftId === draft?.id &&
      p.draftVersion === draft?.version &&
      p.bindingId === binding?.id &&
      p.status !== "opened",
  );
  const recorded = data!.publications.find(
    (p) =>
      p.draftId === draft?.id &&
      p.draftVersion === draft?.version &&
      p.bindingId === binding?.id &&
      p.url === publishedUrl.trim() &&
      p.status !== "opened",
  );
  useEffect(() => {
    setPublishedUrl(publication?.url ?? "");
  }, [draft?.id, draft?.version, binding?.id, publication?.url]);
  const workingStatus = useDraftDeliveryStatus(draft);
  const workingBlocked = workingStatus.blocked;
  const { data: splitTarget } = useIpcQuery(
    "split.item",
    { id: draft?.splitItemId ?? "" },
    {
      enabled: !!draft?.splitItemId,
      revision: data?.jobs,
      invalidate: data?.resources,
      onError: (error) => notify(error.message, "error"),
    },
  );
  const ownReady =
    copy?.status === "ready" &&
    (draft?.splitItemId
      ? splitTarget?.id === draft.splitItemId &&
        splitTarget.status === "ready" &&
        !!splitTarget.verifiedAt
      : !!copy.shareUrl && !!copy.shareVerifiedAt);
  const ownShareUrl = draft?.splitItemId
    ? splitTarget?.shareUrl
    : copy?.shareUrl;
  const bodyHasOwnLink = includesOwnShareLink(draft?.body ?? "", ownShareUrl);
  const packageHasOwnLink =
    bodyHasOwnLink ||
    (includeLink && linkPosition === "body" && allowSelectedPosition);
  const deliveryPrepared =
    includeLink && linkPosition !== "body" && allowSelectedPosition;
  const copyText = async (
    part: "text" | "body" | "title" | "summary" | "delivery" = "text",
  ) => {
    if (!draft) return;
    const result = await command("publication.package", {
      draftId: draft.id,
      bindingId: binding?.id ?? null,
      includeLink,
      linkPosition,
    });
    if (result)
      await command(
        "system.copyText",
        {
          text:
            part === "delivery"
              ? result.delivery
                ? `${result.delivery.label}：${result.delivery.url}${result.delivery.code ? `\n提取码：${result.delivery.code}` : ""}\n${result.delivery.instruction}`
                : ""
              : part === "summary"
                ? csdnHandoff({ ...result, tags: draft.tags }).summary
                : result[part],
        },
        part === "body"
          ? "已核验并复制Markdown正文；标题与标签请分别填写。"
          : part === "title"
            ? "标题已核验并复制。"
            : part === "summary"
              ? "摘要建议已复制，请在发布后台核对。"
              : part === "delivery"
                ? "资源入口字段已复制；尚未挂载，请勿粘贴到正文。"
                : "当前内容包已核验并复制。",
      );
  };

  const deliveryDisabled =
    !draft?.reviewed ||
    !ownReady ||
    !bindingFormatReady ||
    busy > 0 ||
    workingBlocked;
  const exportPackage = async () => {
    if (!draft) return;
    const result = await command("publication.export", {
      draftId: draft.id,
      bindingId: binding?.id ?? null,
      includeLink,
      linkPosition,
    });
    if (result)
      notify(
        `内容包已导出：${result.folder}。发布状态仍由你人工确认。`,
        "success",
      );
  };
  const exportCover = () =>
    resource?.coverId &&
    command("cover.export", { id: resource.coverId }, "封面保存操作已完成。");
  const openWindow = () =>
    draft &&
    binding &&
    command(
      "publication.open",
      { draftId: draft.id, bindingId: binding.id },
      "指定窗口与页面已打开，当前仍未记为已发布。",
    );
  const markPublication = (status: "submitted" | "published") =>
    draft &&
    binding &&
    command(
      "publication.mark",
      {
        draftId: draft.id,
        bindingId: binding.id,
        url: publishedUrl.trim(),
        status,
      },
      status === "submitted"
        ? "已保存文章链接，状态为已提交、待审核。"
        : "已保存人工发布记录。",
    );
  const accountAlias =
    data!.accounts.find((account) => account.id === copy?.accountId)?.alias ??
    "历史账号";
  const ownerUid =
    data!.accounts.find((account) => account.id === copy?.accountId)?.uid ??
    null;
  const history = data!.publications.filter(
    (publication) => publication.draftId === draft?.id,
  );
  return {
    accountAlias,
    ownerUid,
    history,
    copy,
    resource,
    navigate,
    openSettings,
    openSearch,
    openDraft,
    busy,
    draft,
    drafts,
    setDraftId,
    binding,
    bindings,
    setBindingId,
    includeLink,
    setIncludeLink,
    publishedUrl,
    setPublishedUrl,
    linkPosition,
    setLinkPosition,
    positions,
    spec,
    bindingFormatReady,
    allowSelectedPosition,
    opened,
    publication,
    recorded,
    splitTarget,
    workingStatus,
    ownReady,
    ownShareUrl,
    bodyHasOwnLink,
    packageHasOwnLink,
    deliveryPrepared,
    deliveryDisabled,
    copyText,
    exportPackage,
    exportCover,
    openWindow,
    markPublication,
  };
}
export type PublicationModel = ReturnType<typeof usePublicationPreparation>;
export type ReadyPublicationModel = Omit<PublicationModel, "draft"> & {
  draft: Draft;
};
