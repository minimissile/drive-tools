import { useEffect, useRef, useState } from "react";
import type { SmzdmDetail, SmzdmResourceLink } from "../../shared/smzdm";
import {
  DriveResourceDialog,
  type DriveResourceTarget,
} from "../drive-files/DriveResourceDialog";
import { providers } from "../../shared/platforms";
import { ipc } from "../api/client";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";
export function ArticleResources({
  detail,
  busy,
  beforeAction,
  onChanged,
  onBusy,
}: {
  detail: SmzdmDetail;
  busy: boolean;
  onBusy(value: boolean): void;
  beforeAction(): Promise<SmzdmDetail>;
  onChanged(next: SmzdmDetail): void;
}) {
  const { data } = useAppData(),
    { edit } = useAppNavigation(),
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
  const editable = detail.article.stage === "editing";
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
      title={`配套资源 · ${detail.article.links.length} 个网盘链接`}
      extra={
        <Button
          disabled={
            busy || !!pending || !editable || !detail.article.links.length
          }
          onClick={() =>
            void run("sync", async () => {
              const next = await ipc("smzdm.syncLinks", {
                id: detail.article.id,
              });
              if (alive.current) onChanged(next);
            })
          }
        >
          {pending === "sync" ? "正在同步…" : "同步替换为本人链接"}
        </Button>
      }
    >
      <small>
        资源沿用现有录入、文件选择、转存、建链与归档流程。完成后返回这里同步链接。
      </small>
      {error ? <Notice danger>{error}</Notice> : null}
      {detail.article.links.length ? (
        <div className="smzdm-resource-list">
          {detail.article.links.map((link, i) => {
            const row = detail.resources.find((r) => r.linkId === link.id)!;
            const matching = (data?.accounts ?? []).filter(
              (a) => a.provider === link.provider,
            );
            const accountId = accounts[link.id] ?? matching[0]?.id ?? "";
            const linked = !!link.copyId && row.status !== "missing";
            const copyId = selected[link.id] ?? row.candidates[0]?.copyId ?? "";
            return (
              <article className="smzdm-resource-row" key={link.id}>
                <div>
                  <strong>
                    资源 {i + 1} · {providers[link.provider]}
                  </strong>
                  <code>{link.sourceText}</code>
                  <small>
                    {row.title} · {row.message}
                  </small>
                  {link.ownUrl ? (
                    <small className="smzdm-own-url">
                      已替换：{link.ownUrl}
                    </small>
                  ) : null}
                </div>
                <div className="smzdm-resource-controls">
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
                  {row.candidates.length && !linked ? (
                    <>
                      <Field label={`资源 ${i + 1} 已有副本`}>
                        <Select
                          value={copyId}
                          onValueChange={(v) =>
                            setSelected({ ...selected, [link.id]: v })
                          }
                          items={row.candidates.map((c) => ({
                            value: c.copyId,
                            label: `${c.title} · ${c.account}`,
                          }))}
                        />
                      </Field>
                      <Button
                        disabled={busy || !!pending || !editable}
                        onClick={() =>
                          void run(link.id, async () => {
                            const next = await ipc("smzdm.bindResource", {
                              id: detail.article.id,
                              linkId: link.id,
                              copyId,
                            });
                            if (alive.current) onChanged(next);
                          })
                        }
                      >
                        关联已有副本
                      </Button>
                    </>
                  ) : null}
                  {!linked ? (
                    <>
                      <Field label={`资源 ${i + 1} 目标网盘账号`}>
                        <Select
                          value={accountId}
                          disabled={!matching.length}
                          onValueChange={(v) =>
                            setAccounts({ ...accounts, [link.id]: v })
                          }
                          items={
                            matching.length
                              ? matching.map((a) => ({
                                  value: a.id,
                                  label: a.alias,
                                }))
                              : [
                                  {
                                    value: "",
                                    label: `先添加${providers[link.provider]}账号`,
                                    disabled: true,
                                  },
                                ]
                          }
                        />
                      </Field>
                      <Button
                        disabled={busy || !!pending || !editable || !accountId}
                        onClick={() =>
                          void run(link.id, async () => {
                            const result = await ipc("smzdm.resource", {
                              id: detail.article.id,
                              linkId: link.id,
                              accountId,
                            });
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
                        入库并继续转存
                      </Button>
                    </>
                  ) : (
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
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="muted">
          原文未检测到支持的网盘分享链接，可直接整理文章。
        </p>
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
