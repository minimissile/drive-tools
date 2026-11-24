import { useEffect, useId, useRef, useState } from "react";
import type { SmzdmDetail, SmzdmResourceLink } from "../../shared/smzdm";
import {
  DriveResourceDialog,
  type DriveResourceTarget,
} from "../drive-files/DriveResourceDialog";
import { providers } from "../../shared/platforms";
import { ipc } from "../api/client";
import {
  useAppActions,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import { Button, Empty, Field, Notice, Panel, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import { Dialog } from "../ui/Dialog";
import "./article-resources.css";
interface ResourceDetail {
  article: {
    id: string;
    revision: number;
    stage: string;
    links: SmzdmResourceLink[];
  };
  resources: SmzdmDetail["resources"];
}
export interface ArticleResourceActions<T> {
  sync(id: string): Promise<T>;
  replace?(
    id: string,
    revision: number,
    linkId: string,
    shareText: string,
    code?: string,
  ): Promise<T>;
  bind(id: string, linkId: string, copyId: string): Promise<T>;
  create(
    id: string,
    linkId: string,
    accountId: string,
  ): Promise<{ resourceId: string; copyId: string }>;
}
export function ArticleResources<T extends ResourceDetail>({
  detail,
  busy,
  beforeAction,
  onChanged,
  onBusy,
  actions,
  partialSync = false,
}: {
  detail: T;
  actions: ArticleResourceActions<T>;
  partialSync?: boolean;
  busy: boolean;
  onBusy(value: boolean): void;
  beforeAction(): Promise<T>;
  onChanged(next: T): void;
}) {
  const { data } = useAppData(),
    { edit, navigate } = useAppNavigation(),
    { activeAccounts } = useAppSelection(),
    { refresh, notify } = useAppActions();
  const [accounts, setAccounts] = useState<Record<string, string>>({}),
    [selected, setSelected] = useState<Record<string, string>>({}),
    [pending, setPending] = useState(""),
    [error, setError] = useState("");
  const lock = useRef(false),
    alive = useRef(true);
  const [viewing, setViewing] = useState<DriveResourceTarget | null>(null);
  const [viewLoading, setViewLoading] = useState("");
  const replacementForm = useId();
  const [replacement, setReplacement] = useState<{
    link: SmzdmResourceLink;
    number: number;
    shareText: string;
    code: string;
  } | null>(null);
  const viewLink = async (link: SmzdmResourceLink, accountId: string) => {
    if (viewLoading) return;
    setViewLoading(link.id);
    setError("");
    try {
      if (link.resourceId) {
        const resource =
          data?.resources.find((item) => item.id === link.resourceId) ??
          (await ipc("resource.get", { id: link.resourceId }));
        if (alive.current)
          setViewing({
            kind: "resource",
            resource,
            copy: resource.copies.find((copy) => copy.id === link.copyId),
          });
      } else if (alive.current) {
        setViewing({
          kind: "share",
          accountId,
          sourceText: link.sourceText,
          code: link.code,
          title: "文章配套资源",
          ownership: "unknown",
        });
      }
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "资源读取失败，请重试。",
        );
    } finally {
      if (alive.current) setViewLoading("");
    }
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const editable = ["editing", "synced"].includes(detail.article.stage);
  const links = detail.article.links;
  const readyCount = detail.resources.filter(
    (row) => row.status === "ready" && row.copyId,
  ).length;
  const allReady = links.length > 0 && readyCount === links.length;
  const replacedCount = links.filter(
    (link) => link.manual || link.ownUrl,
  ).length;
  const allReplaced = replacedCount === links.length;
  const canSync = partialSync ? readyCount > 0 : allReady;
  const compact = !!actions.replace;
  const run = async (id: string, action: (current: T) => Promise<void>) => {
    if (lock.current || busy) return;
    lock.current = true;
    onBusy(true);
    setPending(id);
    setError("");
    try {
      const current = await beforeAction();
      await action(current);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "资源操作未完成，请重试。",
        );
    } finally {
      lock.current = false;
      onBusy(false);
      if (alive.current) setPending("");
    }
  };
  return (
    <Panel
      title="正文网盘链接"
      className={compact ? "article-resources-compact" : undefined}
      extra={
        canSync ? (
          <Button
            primary={!allReplaced}
            disabled={busy || !!pending || !editable}
            onClick={() =>
              void run("sync", async () => {
                const next = await actions.sync(detail.article.id);
                if (alive.current) onChanged(next);
              })
            }
          >
            {pending === "sync"
              ? "正在替换…"
              : allReplaced
                ? "重新同步链接"
                : partialSync && !allReady
                  ? "替换已就绪链接"
                  : "替换正文链接"}
          </Button>
        ) : undefined
      }
    >
      {error && !replacement ? (
        <Notice danger>
          <span role="alert">{error}</span>
        </Notice>
      ) : null}
      {links.length ? (
        <>
          <p className="article-resource-progress muted">
            {compact
              ? `已替换 ${replacedCount} / ${links.length} 条${readyCount && !allReplaced ? " · 可同步已就绪的本人链接" : ""}`
              : allReplaced && allReady
                ? "正文已使用你的网盘链接。"
                : partialSync && !allReady
                  ? `已替换 ${replacedCount} / ${links.length} 条。可先替换已就绪的链接。`
                  : allReady
                    ? "副本已就绪，可以替换正文链接。"
                    : `已备好 ${readyCount} / ${links.length} 个副本。全部就绪后即可替换正文链接。`}
          </p>
          <div className="article-resource-list">
            {links.map((link, i) => {
              const row = detail.resources.find((r) => r.linkId === link.id)!;
              const matching = (data?.accounts ?? []).filter(
                (a) => a.provider === link.provider && a.enabled,
              );
              const target =
                matching.find((a) => a.id === accounts[link.id]) ??
                matching.find((a) => a.id === activeAccounts[link.provider]) ??
                matching.find((a) => a.isDefault) ??
                matching[0];
              const accountId = target?.id ?? "";
              const linked = !!link.copyId && row.status !== "missing";
              const ready = linked && row.status === "ready";
              const replaced = !!link.manual || (ready && !!link.ownUrl);
              const linkedAccount = linked
                ? row.candidates.find(({ copyId }) => copyId === link.copyId)
                    ?.account
                : undefined;
              const candidate =
                row.candidates.find((c) => c.copyId === selected[link.id]) ??
                row.candidates[0];
              const canReuse = !linked && !!candidate;
              const newResource = (
                <div className="article-resource-new">
                  {matching.length > 1 ? (
                    <Field
                      label={
                        compact ? "目标账号" : `资源 ${i + 1} 目标网盘账号`
                      }
                    >
                      <Select
                        aria-label={
                          compact ? `资源 ${i + 1} 目标网盘账号` : undefined
                        }
                        value={accountId}
                        disabled={busy || !!pending || !editable}
                        onValueChange={(v) =>
                          setAccounts((current) => ({
                            ...current,
                            [link.id]: v,
                          }))
                        }
                        items={matching.map((a) => ({
                          value: a.id,
                          label: a.alias,
                        }))}
                      />
                    </Field>
                  ) : (
                    <small className="article-resource-target">
                      {target
                        ? `存到 ${target.alias}`
                        : `请先在账号管理中添加${providers[link.provider]}账号`}
                    </small>
                  )}
                  {accountId ? (
                    <Button
                      primary={!compact && !canReuse}
                      disabled={busy || !!pending || !editable || !accountId}
                      onClick={() =>
                        void run(link.id, async () => {
                          const result = await actions.create(
                            detail.article.id,
                            link.id,
                            accountId,
                          );
                          try {
                            await refresh();
                          } catch {
                            if (alive.current)
                              notify(
                                "资源已入库，工作空间列表刷新失败；请刷新后查看，勿重复入库。",
                                "warning",
                              );
                          }
                          if (alive.current)
                            edit(result.resourceId, result.copyId);
                        })
                      }
                    >
                      {canReuse ? "入库新副本" : "入库并继续转存"}
                    </Button>
                  ) : (
                    <Button
                      size="compact"
                      disabled={busy}
                      onClick={() => navigate("accounts")}
                    >
                      添加网盘账号
                    </Button>
                  )}
                </div>
              );
              const info = (
                <div className="article-resource-info">
                  <div className="article-resource-title">
                    <strong>
                      资源 {i + 1} · {providers[link.provider]}
                    </strong>
                    <Status
                      kind={
                        replaced
                          ? "good"
                          : ready || linked
                            ? "normal"
                            : "warning"
                      }
                    >
                      {link.manual
                        ? "已手动替换"
                        : replaced
                          ? "已替换"
                          : ready
                            ? "待替换"
                            : linked
                              ? "待归档"
                              : canReuse
                                ? "有现成副本"
                                : "待入库"}
                    </Status>
                  </div>
                  {linked ? (
                    compact ? (
                      <small className="article-resource-meta">
                        {row.title}
                        {linkedAccount ? ` · ${linkedAccount}` : ""}
                      </small>
                    ) : (
                      <small>
                        {row.title}
                        {!ready ? ` · ${row.message}` : ""}
                      </small>
                    )
                  ) : null}
                  {replaced && !compact ? (
                    <small className="article-own-url">{link.ownUrl}</small>
                  ) : null}
                  {linked && !compact ? (
                    <details className="article-resource-source">
                      <summary>原网盘链接</summary>
                      <code>{link.sourceText}</code>
                    </details>
                  ) : (
                    <small className="article-resource-link">
                      {link.ownUrl ?? link.url}
                      {link.code && (link.manual || (compact && !link.ownUrl))
                        ? ` · 提取码 ${link.code}`
                        : ""}
                    </small>
                  )}
                </div>
              );
              const viewButton = (
                <Button
                  size={compact ? "compact" : "default"}
                  quiet={compact}
                  disabled={
                    busy ||
                    !!pending ||
                    !!viewLoading ||
                    (!linked && !accountId)
                  }
                  onClick={() => void viewLink(link, accountId)}
                >
                  {viewLoading === link.id
                    ? "正在读取…"
                    : compact
                      ? "查看资源"
                      : "查看网盘资源"}
                </Button>
              );
              const alternative = canReuse ? (
                <details className="article-resource-alternative">
                  <summary>改用新副本</summary>
                  {newResource}
                </details>
              ) : null;
              const intakeAction = canReuse
                ? compact
                  ? null
                  : alternative
                : newResource;
              const controls = (
                <div className="article-resource-controls">
                  {!compact ? viewButton : null}
                  {canReuse ? (
                    <>
                      {row.candidates.length > 1 ? (
                        <Field
                          label={
                            compact ? "已有副本" : `资源 ${i + 1} 已有副本`
                          }
                        >
                          <Select
                            aria-label={
                              compact ? `资源 ${i + 1} 已有副本` : undefined
                            }
                            title={
                              compact
                                ? `${candidate.account} · ${candidate.title}`
                                : undefined
                            }
                            value={candidate.copyId}
                            disabled={busy || !!pending || !editable}
                            onValueChange={(v) =>
                              setSelected((current) => ({
                                ...current,
                                [link.id]: v,
                              }))
                            }
                            items={row.candidates.map((c) => ({
                              value: c.copyId,
                              label: compact
                                ? `${c.account} · ${c.title}`
                                : `${c.title} · ${c.account}`,
                            }))}
                          />
                        </Field>
                      ) : (
                        <small className="article-resource-target">
                          {candidate.title} · {candidate.account}
                        </small>
                      )}
                      <Button
                        primary={!compact}
                        disabled={busy || !!pending || !editable}
                        onClick={() =>
                          void run(link.id, async () => {
                            const next = await actions.bind(
                              detail.article.id,
                              link.id,
                              candidate.copyId,
                            );
                            if (alive.current) onChanged(next);
                          })
                        }
                      >
                        关联已有副本
                      </Button>
                    </>
                  ) : null}
                  {!linked ? (
                    intakeAction
                  ) : !ready ? (
                    <Button
                      disabled={busy || !!pending || !editable}
                      onClick={() =>
                        void run(link.id, async () => {
                          if (alive.current)
                            edit(link.resourceId!, link.copyId!);
                        })
                      }
                    >
                      继续资源归档
                    </Button>
                  ) : null}
                </div>
              );
              return (
                <article className="article-resource-row" key={link.id}>
                  {compact ? (
                    <div className="article-resource-line">
                      <div className="article-resource-description">
                        {info}
                        {linked && !ready ? (
                          <small className="muted">{row.message}</small>
                        ) : null}
                        {!link.manual &&
                        link.ownUrl &&
                        link.ownUrl !== link.url ? (
                          <details className="article-resource-source">
                            <summary>原网盘链接</summary>
                            <code>{link.sourceText}</code>
                          </details>
                        ) : null}
                      </div>
                      <div className="article-resource-operations">
                        {!link.manual && !ready ? controls : null}
                        <div className="article-resource-actions">
                          {viewButton}
                          <Button
                            size="compact"
                            quiet
                            disabled={busy || !!pending || !editable}
                            onClick={() => {
                              setError("");
                              setReplacement({
                                link,
                                number: i + 1,
                                shareText: link.manual ? link.url : "",
                                code: link.manual ? link.code : "",
                              });
                            }}
                          >
                            手动替换
                          </Button>
                          {!link.manual ? alternative : null}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      {info}
                      {controls}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <Empty compact title="暂无可替换的网盘链接">
          正文中识别到的网盘分享会出现在这里。
        </Empty>
      )}
      {viewing ? (
        <DriveResourceDialog
          target={viewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
      {replacement && actions.replace ? (
        <Dialog
          title={`手动替换资源 ${replacement.number}`}
          busy={!!pending}
          onClose={() => {
            setReplacement(null);
            setError("");
          }}
          footer={
            <>
              <Button
                disabled={!!pending}
                onClick={() => {
                  setReplacement(null);
                  setError("");
                }}
              >
                取消
              </Button>
              <Button
                primary
                type="submit"
                form={replacementForm}
                disabled={
                  busy ||
                  !!pending ||
                  !editable ||
                  !replacement.shareText.trim()
                }
              >
                {pending ? "正在替换…" : "替换正文链接"}
              </Button>
            </>
          }
        >
          <p className="article-resource-link">
            当前链接：{replacement.link.ownUrl ?? replacement.link.url}
          </p>
          <form
            id={replacementForm}
            className="article-resource-replace"
            onSubmit={(event) => {
              event.preventDefault();
              if (!replacement.shareText.trim() || !editable) return;
              void run(replacement.link.id, async (current) => {
                const link = current.article.links.find(
                  ({ id }) => id === replacement.link.id,
                );
                if (
                  !link ||
                  link.url !== replacement.link.url ||
                  link.ownUrl !== replacement.link.ownUrl ||
                  link.code !== replacement.link.code
                )
                  throw new Error("这条正文链接已变化，请关闭后重新选择。");
                const next = await actions.replace!(
                  current.article.id,
                  current.article.revision,
                  link.id,
                  replacement.shareText,
                  replacement.code,
                );
                if (alive.current) {
                  onChanged(next);
                  setReplacement(null);
                  notify("正文网盘链接已替换。", "success");
                }
              });
            }}
          >
            <Field label="新分享链接">
              <input
                value={replacement.shareText}
                maxLength={4000}
                disabled={!!pending}
                placeholder="粘贴网盘链接或分享文本"
                onChange={(event) =>
                  setReplacement({
                    ...replacement,
                    shareText: event.target.value,
                  })
                }
              />
            </Field>
            <Field label="提取码" hint="可选，留空从分享文本读取">
              <input
                value={replacement.code}
                maxLength={8}
                disabled={!!pending}
                onChange={(event) =>
                  setReplacement({ ...replacement, code: event.target.value })
                }
              />
            </Field>
          </form>
          {error ? (
            <Notice danger>
              <span role="alert">{error}</span>
            </Notice>
          ) : null}
        </Dialog>
      ) : null}
    </Panel>
  );
}
