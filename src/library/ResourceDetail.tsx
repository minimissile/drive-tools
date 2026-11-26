import { isIndexedOwnSource } from "../../shared/owned-file-source";
import { ResourceKindIcon } from "../resources/ResourceKindIcon";
import { ProviderIcon } from "../resources/ProviderIcon";
import { Select } from "../ui/Select";
import { DropdownMenu, MenuAction } from "../ui/DropdownMenu";
import { useState } from "react";
import {
  Search,
  ShieldCheck,
  BookOpen,
  Copy,
  FolderOpen,
  FolderTree,
  Pencil,
  Trash2,
} from "lucide-react";
import type { Resource, ResourceCopy } from "../../shared/types";
import {
  useAppData,
  useAppSelection,
  useAppNavigation,
  useAppActions,
  useAppActivity,
} from "../state";
import { Button } from "../ui/primitives";
import { CreateShare } from "../resources/CreateShareDialog";
import { SharePassphrase } from "../resources/SharePassphrase";
import { ResourceLinkPanel } from "../resources/ResourceLinkPanel";
import { copyShareStatus } from "../../shared/share-status";
import { accountLabel, providerName } from "../resources/labels";
import { formatSize } from "../lib/format";

/** A bounded inspector: scrollable facts, with the current resource's actions always in reach. */
export function ResourceDetail({
  resource,
  copy,
  copies = resource.copies,
  inDialog = false,
  onView,
  onDelete,
}: {
  resource: Resource;
  copy: ResourceCopy;
  copies?: ResourceCopy[];
  inDialog?: boolean;
  onView(): void;
  onDelete(): void;
}) {
  const { data } = useAppData(),
    { select } = useAppSelection(),
    { navigate, edit, openSearch } = useAppNavigation(),
    { command } = useAppActions(),
    { busy } = useAppActivity();
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const shareCheck = data!.shareChecks.find((c) => c.copyId === copy.id);
  const account = data!.accounts.find((item) => item.id === copy.accountId);
  const provider = copy.source?.provider ?? resource.provider;
  const sourceUrl = copy.source?.url ?? resource.sourceUrl;
  const sourceKind = copy.source ? "share" : resource.sourceKind;
  const share = copyShareStatus(copy, account, shareCheck);
  const currentCheck =
    shareCheck &&
    (!copy.shareVerifiedAt ||
      Date.parse(shareCheck.checkedAt) >= Date.parse(copy.shareVerifiedAt))
      ? shareCheck
      : undefined;
  const checkedAt = currentCheck?.checkedAt ?? copy.shareVerifiedAt;
  const shareMessage =
    share.state === "valid"
      ? null
      : currentCheck?.status !== "valid"
        ? currentCheck?.message || copy.error
        : copy.error;
  const inspectShare = () => command("copies.check", { copyIds: [copy.id] });
  const moreActions = (
    <DropdownMenu label="更多资源操作">
      <MenuAction
        disabled={!share.canCheck || busy > 0}
        onClick={() => void inspectShare()}
      >
        <ShieldCheck size={14} />
        检查有效性
      </MenuAction>
      <MenuAction onClick={() => edit(resource.id, copy.id)}>
        <Pencil size={14} />
        {copy.status === "draft" ? "继续录入" : "编辑资料"}
      </MenuAction>
      <MenuAction
        disabled={!share.canCopy}
        onClick={() => {
          select(resource.id, copy.id);
          openSearch({ copyId: copy.id });
        }}
      >
        <Search size={14} />
        创建搜索选题
      </MenuAction>
      {data!.settings.vaultPath ? (
        <>
          <MenuAction
            onClick={() =>
              void command(
                "notes.export",
                { copyId: copy.id },
                "笔记导出已处理，请查看同步状态。",
              )
            }
          >
            <BookOpen size={14} />
            导出知识笔记
          </MenuAction>
          <MenuAction
            disabled={copy.noteStatus !== "synced"}
            onClick={() => void command("notes.open", { copyId: copy.id })}
          >
            打开笔记
          </MenuAction>
        </>
      ) : null}
      <MenuAction
        disabled={copy.status !== "ready"}
        onClick={() => {
          select(resource.id, copy.id);
          navigate("split");
        }}
      >
        <FolderTree size={14} />
        拆分为多个链接
      </MenuAction>
      <MenuAction disabled={busy > 0} onClick={onDelete}>
        <Trash2 size={14} />
        删除资源
      </MenuAction>
    </DropdownMenu>
  );
  return (
    <section className="resource-detail" aria-label="当前资源档案">
      {!inDialog ? (
        <div className="resource-detail-heading">
          <h2>资源档案</h2>
          <div className="row compact">{moreActions}</div>
        </div>
      ) : null}
      <div className="resource-detail-body">
        <div className="resource-identity">
          <ResourceKindIcon files={copy.files} title={resource.title} />
          <div>
            <h3 className="detail-title">{resource.title || "未命名资源"}</h3>
            <small className="resource-meta">
              <span className="resource-provider">
                <ProviderIcon
                  provider={provider}
                  size="small"
                  decorative
                />
                {providerName(provider)}网盘
              </span>
              <span className="resource-meta-separator" aria-hidden="true">
                ·
              </span>
              {resource.category || "待分类"}
            </small>
            {inDialog ? <div className="row compact">{moreActions}</div> : null}
          </div>
        </div>
        {resource.tags.length ? (
          <div className="row compact resource-detail-tags">
            {resource.tags.map((t) => (
              <span className="tag" key={t}>
                {t}
              </span>
            ))}
          </div>
        ) : null}
        <section className="resource-copy-section" aria-label="存储位置">
          <h3>存储位置</h3>
          {copies.length > 1 ? (
            <Select
              aria-label="资源存储账号"
              value={copy.id}
              onValueChange={(nextValue) => select(resource.id, nextValue)}
              items={[
                ...copies.map((c) => ({
                  value: c.id,
                    label: `${providerName(c.source?.provider ?? resource.provider)} · ${accountLabel(data!.accounts, c.accountId)}`,
                })),
              ]}
            />
          ) : (
            <p className="resource-copy-account">
              {accountLabel(data!.accounts, copy.accountId)}
            </p>
          )}
          <div className="property">
            <span>文件概况</span>
            <span>
              {copy.files.length ? (
                <>
                  {copy.files.length} 项
                  {copy.files.every(
                    (file) =>
                      !file.isDirectory && typeof file.size === "number",
                  )
                    ? ` · ${formatSize(copy.files.reduce((n, file) => n + (file.size ?? 0), 0))}`
                    : ""}
                </>
              ) : (
                "文件清单待核验"
              )}
            </span>
          </div>
          {data!.settings.vaultPath ? (
            <div className="property">
              <span>知识笔记</span>
              <span>
                {(
                  {
                    synced: "已同步",
                    pending: "待同步",
                    conflict: "外部修改冲突",
                    failed: "导出失败",
                    not_configured: "未同步",
                  } as Record<string, string>
                )[copy.noteStatus] ?? copy.noteStatus}
              </span>
            </div>
          ) : null}
        </section>
        <section className="resource-share-section" aria-label="本人分享">
          <div className="resource-share-heading">
            <h3>本人分享链接</h3>
            <CreateShare key={copy.id} copy={copy} />
          </div>
          <div className="link-box">
            {copy.shareUrl ?? "转存与核验完成后，生成本人分享链接。"}
          </div>
          {copy.shareId &&
          copy.shareUrl &&
          copy.shareOwnerUid &&
          ["baidu", "quark"].includes(provider) ? (
            <SharePassphrase
              key={`${copy.id}:${copy.shareVersion}`}
              target={{ copyId: copy.id }}
              provider={provider}
            />
          ) : null}
          <div className="resource-share-status" data-kind={share.kind}>
            <span>{share.label}</span>
            {checkedAt ? (
              <time dateTime={checkedAt}>
                {new Date(checkedAt).toLocaleString("zh-CN", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            ) : null}
          </div>
          {shareMessage ? (
            <p className="resource-share-message">{shareMessage}</p>
          ) : null}
        </section>
        <ResourceLinkPanel
          key={resource.id}
          resourceId={resource.id}
          revision={`${resource.updatedAt}:${copy.shareUrl}:${copy.shareVerifiedAt}`}
        />
        <section className="resource-copy-section" aria-label="资源说明">
          <h3>资源说明</h3>
          <div className="resource-description">
            <p
              className={`detail-summary ${descriptionOpen ? "" : "is-collapsed"}`}
            >
              {resource.summary ||
                "还没有填写资源说明。补充适合人群与具体内容，有助于后续提词。"}
            </p>
            {resource.summary.length > 120 ? (
              <Button
                quiet
                size="compact"
                aria-expanded={descriptionOpen}
                onClick={() => setDescriptionOpen((open) => !open)}
              >
                {descriptionOpen ? "收起说明" : "展开说明"}
              </Button>
            ) : null}
          </div>
        </section>
        <details className="private-source">
          <summary>内部追溯信息</summary>
          <small>
            {isIndexedOwnSource(sourceUrl)
              ? "本人网盘目录登记；对外交付前创建并核验分享。"
              : sourceKind === "owned"
                ? "已录入的自有资源链接；对外交付前核验所属账号。"
                : "来源链接仅作内部记录，禁止用于对外分发。"}
          </small>
          <p>
            {isIndexedOwnSource(sourceUrl)
              ? copy.files.map((file) => file.name).join("、")
              : sourceUrl}
          </p>
          <small>保存目录</small>
          <p>
            {sourceKind === "owned" &&
            !copy.folderId &&
            !isIndexedOwnSource(sourceUrl)
              ? "未记录原网盘目录；直接入库不创建目录。"
              : copy.directory}
          </p>
        </details>
      </div>
      <div className="resource-detail-footer">
        <Button
          primary
          title="复制已保存的分享链接和提取码"
          disabled={!share.canCopy || busy > 0}
          onClick={async () => {
            const result = await command("copy.link", { copyId: copy.id });
            if (result)
              await command(
                "system.copyText",
                { text: result.text },
                "分享链接已复制。",
              );
          }}
        >
          <Copy size={14} />
          复制分享
        </Button>
        <Button onClick={onView}>
          <FolderOpen size={14} />
          查看网盘
        </Button>
      </div>
    </section>
  );
}
