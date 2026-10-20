import { ResourceKindIcon } from "../resources/ResourceKindIcon";
import { ProviderIcon } from "../resources/ProviderIcon";
import { Select } from "../ui/Select";
import { DropdownMenu, MenuAction } from "../ui/DropdownMenu";
import { useState } from "react";
import { ArrowRight, BookOpen, Copy, ExternalLink, Pencil } from "lucide-react";
import type { Resource, ResourceCopy } from "../../shared/types";
import {
  useAppData,
  useAppSelection,
  useAppNavigation,
  useAppActions,
  useAppActivity,
} from "../state";
import { Button, Notice } from "../ui/primitives";
import { CopyStatus, RecoverShare } from "../resources/components";
import { accountLabel, providerName } from "../resources/labels";
import { formatSize } from "../lib/format";

/** A bounded inspector: scrollable facts, with the current resource's actions always in reach. */
export function ResourceDetail({
  resource,
  copy,
  copies = resource.copies,
  inDialog = false,
}: {
  resource: Resource;
  copy: ResourceCopy;
  copies?: ResourceCopy[];
  inDialog?: boolean;
}) {
  const { data } = useAppData(),
    { select } = useAppSelection(),
    { navigate, edit, openSearch, openSettings } = useAppNavigation(),
    { command } = useAppActions(),
    { busy } = useAppActivity();
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const shareCheck = data!.shareChecks.find((c) => c.copyId === copy.id);
  const inspectShare = () =>
    command(
      "copies.check",
      { copyIds: [copy.id] },
      "本人分享检查已完成，结果已记录到资源档案。",
    );
  const moreActions = (
    <DropdownMenu label="更多资源操作">
      <MenuAction
        onClick={() =>
          !data!.settings.vaultPath
            ? openSettings("notes")
            : void command(
                "notes.export",
                { copyId: copy.id },
                "笔记导出已处理，请查看同步状态。",
              )
        }
      >
        <BookOpen size={14} />
        {data!.settings.vaultPath ? "导出知识笔记" : "连接知识库"}
      </MenuAction>
      <MenuAction
        disabled={copy.noteStatus !== "synced"}
        onClick={() => void command("notes.open", { copyId: copy.id })}
      >
        打开笔记
      </MenuAction>
      <MenuAction
        disabled={copy.status !== "ready"}
        onClick={() => {
          select(resource.id, copy.id);
          navigate("split");
        }}
      >
        拆分为多个链接
      </MenuAction>
      <MenuAction onClick={() => edit(resource.id, "new")}>
        另存到其他账号
      </MenuAction>
    </DropdownMenu>
  );
  return (
    <section className="resource-detail" aria-label="当前资源档案">
      {!inDialog ? (
        <div className="resource-detail-heading">
          <h2>资源档案</h2>
          <div className="row compact">
            <CopyStatus copy={copy} />
            {moreActions}
          </div>
        </div>
      ) : null}
      <div className="resource-detail-body">
        <div className="resource-identity">
          <ResourceKindIcon files={copy.files} />
          <div>
            <h3 className="detail-title">{resource.title}</h3>
            <small className="resource-meta">
              <span className="resource-provider">
                <ProviderIcon
                  provider={resource.provider}
                  size="small"
                  decorative
                />
                {providerName(resource.provider)}网盘
              </span>
              <span className="resource-meta-separator" aria-hidden="true">
                ·
              </span>
              {resource.category}
            </small>
            {inDialog ? (
              <div className="row compact">
                <CopyStatus copy={copy} />
                {moreActions}
              </div>
            ) : null}
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
        <section className="resource-copy-section" aria-label="资源副本">
          <h3>资源副本</h3>
          {copies.length > 1 ? (
            <Select
              aria-label="档案账号副本"
              value={copy.id}
              onValueChange={(nextValue) => select(resource.id, nextValue)}
              items={[
                ...copies.map((c) => ({
                  value: c.id,
                  label: accountLabel(data!.accounts, c.accountId),
                })),
              ]}
            />
          ) : (
            <p className="resource-copy-account">
              {accountLabel(data!.accounts, copy.accountId)}
            </p>
          )}
          <div className="property">
            <span>目标文件</span>
            <span>
              {copy.files.length} 项 ·{" "}
              {formatSize(copy.files.reduce((n, f) => n + (f.size ?? 0), 0))}
            </span>
          </div>
          <div className="property">
            <span>知识笔记</span>
            <span>
              {(
                {
                  synced: "已同步",
                  pending: "待同步",
                  conflict: "外部修改冲突",
                  failed: "导出失败",
                  not_configured: "尚未配置Vault",
                } as Record<string, string>
              )[copy.noteStatus] ?? copy.noteStatus}
            </span>
          </div>
        </section>
        <section className="resource-share-section" aria-label="本人分享">
          <div className="resource-share-heading">
            <h3>本人分享链接</h3>
            <Button
              quiet
              size="compact"
              disabled={copy.status !== "ready" || busy > 0}
              onClick={() => void inspectShare()}
            >
              检查此本人分享
            </Button>
          </div>
          <div className="link-box">
            {copy.shareUrl ?? "转存与核验完成后，生成本人分享链接。"}
          </div>
          <div className="resource-share-actions">
            <Button
              quiet
              onClick={() => void command("copy.open", { id: copy.id })}
            >
              <ExternalLink size={14} />
              网盘
            </Button>
            <RecoverShare copy={copy} />
          </div>
          {copy.error ? <Notice warning>{copy.error}</Notice> : null}
          {shareCheck ? (
            <Notice warning={shareCheck.status !== "valid"}>
              {shareCheck.message}
              <br />
              <small>
                {new Date(shareCheck.checkedAt).toLocaleString("zh-CN")}
              </small>
            </Notice>
          ) : null}
          {copy.status === "ready" && !copy.shareVerifiedAt ? (
            <Notice warning>本人分享待复核，请检查分享后再分发。</Notice>
          ) : null}
        </section>
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
          <small>来源链接仅作内部记录，禁止用于对外分发。</small>
          <p>{resource.sourceUrl}</p>
          <small>保存目录</small>
          <p>{copy.directory}</p>
        </details>
      </div>
      <div className="resource-detail-footer">
        <Button
          className="resource-copy-action"
          primary={copy.status === "ready"}
          disabled={!copy.shareUrl || busy > 0}
          onClick={async () => {
            const result = await command("copy.link", { copyId: copy.id });
            if (result)
              await command(
                "system.copyText",
                { text: result.text },
                "本人分享已核验并复制。",
              );
          }}
        >
          <Copy size={14} />
          复制分享
        </Button>

        <Button
          disabled={copy.status !== "ready"}
          onClick={() => {
            select(resource.id, copy.id);
            openSearch({ copyId: copy.id });
          }}
        >
          创建搜索选题
          <ArrowRight size={14} />
        </Button>
        <Button
          primary={copy.status !== "ready"}
          onClick={() => edit(resource.id, copy.id)}
        >
          <Pencil size={14} />
          {copy.status === "draft" ? "继续录入" : "编辑资料"}
        </Button>
      </div>
    </section>
  );
}
