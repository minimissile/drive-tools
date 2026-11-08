import { useEffect, useRef, useState } from "react";
import {
  ClipboardCopy,
  ExternalLink,
  RefreshCw,
  Upload,
  EyeOff,
} from "lucide-react";
import type {
  CatalogDetail,
  CatalogDiff,
  CatalogSiteState,
} from "../../shared/resource-catalog";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import { formatTime } from "../lib/format";
import { Button, Loading, Notice, Panel, Status } from "../ui/primitives";

export function CatalogSitePublishing({
  detail,
  onChanged,
  onSettings,
}: {
  detail: CatalogDetail;
  onChanged(): void;
  onSettings(): void;
}) {
  const [site, setSite] = useState(detail.site);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true),
    lock = useRef(false);
  const { notify } = useAppActions();
  useEffect(() => {
    setSite(detail.site);
  }, [detail.site]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!site)
    return (
      <Notice>
        清单站点功能的后端更新尚未加载，请在主窗口点击“应用更新并重启”后继续。
      </Notice>
    );
  const publication = site.publication;
  const busy = !!pending;
  const run = async (
    label: string,
    action: () => Promise<CatalogSiteState>,
    message: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setPending(label);
    setError("");
    try {
      const value = await action();
      if (!alive.current) return;
      setSite(value);
      if (!value.error) notify(message, "success");
      onChanged();
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending("");
    }
  };
  const linkAction = async (copy: boolean) => {
    if (!publication || lock.current) return;
    lock.current = true;
    setPending(copy ? "正在复制地址…" : "正在打开清单…");
    setError("");
    try {
      if (copy) {
        await ipc("system.copyText", { text: publication.url });
        notify("已复制清单地址。", "success");
      } else await ipc("system.external", { url: publication.url });
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending("");
    }
  };
  return (
    <Panel
      title="落地页站点"
      extra={
        <Button size="compact" disabled={busy} onClick={onSettings}>
          站点连接设置
        </Button>
      }
    >
      <div className="catalog-site-publishing">
        <p className="muted catalog-site-description">
          将当前清单发布到已连接的盘序站点。无需文档账号，也无需为每项资源生成正文；已有资源介绍页会自动关联。
        </p>
        <div className="catalog-site-status">
          <div className="catalog-title-line">
            <Status
              kind={
                site.pending
                  ? "warning"
                  : publication?.active
                    ? site.needsUpdate
                      ? "warning"
                      : "good"
                    : undefined
              }
            >
              {site.pending
                ? "结果待核对"
                : publication?.active
                  ? site.needsUpdate
                    ? "有内容待更新"
                    : "已发布"
                  : publication
                    ? "已撤下"
                    : "本机尚无发布记录"}
            </Status>
            {publication ? (
              <span className="muted">
                站点 V{publication.version} ·{" "}
                {formatTime(publication.updatedAt)}
              </span>
            ) : null}
          </div>
          {publication ? (
            <>
              <p className="catalog-publication-url">{publication.url}</p>
              <p className="muted">
                此地址持续沿用。
                {publication.active
                  ? `线上快照含 ${publication.snapshot.items.length} 项资源。`
                  : "公开页面已撤下，重新发布将恢复同一地址。"}
              </p>
            </>
          ) : (
            <p className="muted">
              首次发布后会获得固定清单地址，后续可在这里更新和撤下。
            </p>
          )}
          <div className="catalog-publish-actions">
            {publication ? (
              <>
                <Button
                  size="compact"
                  disabled={busy}
                  onClick={() => void linkAction(true)}
                >
                  <ClipboardCopy size={14} />
                  复制地址
                </Button>
                <Button
                  size="compact"
                  disabled={busy || !publication.active}
                  onClick={() => void linkAction(false)}
                >
                  <ExternalLink size={14} />
                  打开清单
                </Button>
              </>
            ) : null}
            <Button
              size="compact"
              disabled={busy}
              onClick={() =>
                void run(
                  "正在读取站点状态…",
                  () =>
                    ipc("resourceCatalog.siteRefresh", {
                      id: detail.catalog.id,
                    }),
                  "已读取站点清单状态。",
                )
              }
            >
              <RefreshCw size={14} />
              读取站点状态
            </Button>
            {publication?.active && !site.pending ? (
              <Button
                size="compact"
                disabled={busy}
                onClick={() =>
                  void run(
                    "正在撤下并核对站点…",
                    () =>
                      ipc("resourceCatalog.siteWithdraw", {
                        id: detail.catalog.id,
                        expectedVersion: publication.version,
                        confirmed: true,
                      }),
                    "公开清单已撤下，原地址已保留。可重新发布恢复。",
                  )
                }
              >
                <EyeOff size={14} />
                撤下页面
              </Button>
            ) : null}
          </div>
          {site.checkedAt ? (
            <p className="muted">
              上次核对：{formatTime(site.checkedAt)}
              。站点状态仅在发布操作或主动读取时更新。
            </p>
          ) : null}
        </div>
        {site.needsUpdate && site.diff ? <SiteDiff diff={site.diff} /> : null}
        {error || site.error ? (
          <div role="alert">
            <Notice danger>{error || site.error}</Notice>
          </div>
        ) : null}
        {site.pending ? (
          <Notice warning>
            上次{site.pending === "publish" ? "发布" : "撤下"}
            结果待核对。重试会发送原请求，不会另建清单或改用当前内容。
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  "正在重试原操作…",
                  () =>
                    ipc("resourceCatalog.siteRetry", { id: detail.catalog.id }),
                  "原站点操作已完成并核对。",
                )
              }
            >
              重试原操作
            </Button>
          </Notice>
        ) : detail.catalog.archived ? (
          <Notice>
            清单已归档。可继续读取站点状态或撤下页面；重新发布前请恢复维护。
          </Notice>
        ) : (
          <div className="catalog-site-submit">
            <div>
              <strong>
                当前待发布内容 · {detail.current.items.length} 项资源
              </strong>
              <p className="muted">
                公开清单标题、介绍、资源说明、标签，以及已核实本人分享和提取码。未纳入的资源与账号资料不会上传。
              </p>
            </div>
            {!detail.current.items.length && publication ? (
              <Notice warning>
                当前没有可公开资源。更新后会移除线上原有资源，保留空清单提示。
              </Notice>
            ) : null}
            <Button
              primary
              disabled={busy || (!detail.current.items.length && !publication)}
              onClick={() =>
                void run(
                  "正在发布并核对站点…",
                  () =>
                    ipc("resourceCatalog.sitePublish", {
                      id: detail.catalog.id,
                      expectedRevision: detail.catalog.revision,
                      expectedHash: detail.current.hash,
                      publicConfirmed: true,
                    }),
                  "清单已发布，站点回执已核对。",
                )
              }
            >
              <Upload size={15} />
              {publication
                ? publication.active
                  ? "更新站点清单"
                  : "重新发布清单"
                : "发布到落地页站点"}
            </Button>
          </div>
        )}
        {busy ? <Loading label={pending} /> : null}
      </div>
    </Panel>
  );
}

function SiteDiff({ diff }: { diff: CatalogDiff }) {
  return (
    <details className="catalog-publication-diff">
      <summary>
        与线上快照比较：新增 {diff.added.length} · 变化 {diff.changed.length} ·
        移除 {diff.removed.length}
        {diff.metadataChanged ? " · 清单信息或资源页关联变化" : ""}
      </summary>
      <div className="catalog-diff-columns">
        {(
          [
            ["新增", diff.added],
            ["变化", diff.changed],
            ["移除", diff.removed],
          ] as const
        ).map(([title, items]) => (
          <section key={title}>
            <h4>
              {title} · {items.length}
            </h4>
            {items.length ? (
              <ul className="catalog-diff-list">
                {items.map((item) => (
                  <li key={item.resourceId}>{item.title}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">无{title}资源</p>
            )}
          </section>
        ))}
      </div>
    </details>
  );
}
