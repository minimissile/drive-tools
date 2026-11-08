import { useEffect, useRef, useState } from "react";
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
import "./article-resources.css";
interface ResourceDetail {
  article: { id: string; stage: string; links: SmzdmResourceLink[] };
  resources: SmzdmDetail["resources"];
}
export interface ArticleResourceActions<T> {
  sync(id: string): Promise<T>;
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
  beforeAction(): Promise<unknown>;
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
  const allReplaced = links.every((link) => !!link.ownUrl);
  const replacedCount = links.filter((link) => !!link.ownUrl).length;
  const canSync = partialSync ? readyCount > 0 : allReady;
  const run = async (id: string, action: () => Promise<void>) => {
    if (lock.current || busy) return;
    lock.current = true;
    onBusy(true);
    setPending(id);
    setError("");
    try {
      await beforeAction();
      await action();
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
      {error ? (
        <Notice danger>
          <span role="alert">{error}</span>
        </Notice>
      ) : null}
      {links.length ? (
        <>
          <p className="article-resource-progress muted">
            {allReplaced && allReady
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
              const replaced = ready && !!link.ownUrl;
              const candidate =
                row.candidates.find((c) => c.copyId === selected[link.id]) ??
                row.candidates[0];
              const canReuse = !linked && !!candidate;
              const newResource = (
                <div className="article-resource-new">
                  {matching.length > 1 ? (
                    <Field label={`资源 ${i + 1} 目标网盘账号`}>
                      <Select
                        value={accountId}
                        disabled={busy || !!pending || !editable}
                        onValueChange={(v) =>
                          setAccounts({ ...accounts, [link.id]: v })
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
                      primary={!canReuse}
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
              return (
                <article className="article-resource-row" key={link.id}>
                  <div>
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
                        {replaced
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
                      <small>
                        {row.title}
                        {!ready ? ` · ${row.message}` : ""}
                      </small>
                    ) : null}
                    {replaced ? (
                      <small className="article-own-url">{link.ownUrl}</small>
                    ) : null}
                    {linked ? (
                      <details className="article-resource-source">
                        <summary>原网盘链接</summary>
                        <code>{link.sourceText}</code>
                      </details>
                    ) : (
                      <small className="article-resource-link">
                        {link.url}
                      </small>
                    )}
                  </div>
                  <div className="article-resource-controls">
                    <Button
                      disabled={
                        busy ||
                        !!pending ||
                        !!viewLoading ||
                        (!linked && !accountId)
                      }
                      onClick={() => void viewLink(link, accountId)}
                    >
                      {viewLoading === link.id ? "正在读取…" : "查看网盘资源"}
                    </Button>
                    {canReuse ? (
                      <>
                        {row.candidates.length > 1 ? (
                          <Field label={`资源 ${i + 1} 已有副本`}>
                            <Select
                              value={candidate.copyId}
                              disabled={busy || !!pending || !editable}
                              onValueChange={(v) =>
                                setSelected({ ...selected, [link.id]: v })
                              }
                              items={row.candidates.map((c) => ({
                                value: c.copyId,
                                label: `${c.title} · ${c.account}`,
                              }))}
                            />
                          </Field>
                        ) : (
                          <small className="article-resource-target">
                            {candidate.title} · {candidate.account}
                          </small>
                        )}
                        <Button
                          primary
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
                      canReuse ? (
                        <details className="article-resource-alternative">
                          <summary>改用新副本</summary>
                          {newResource}
                        </details>
                      ) : (
                        newResource
                      )
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
    </Panel>
  );
}
