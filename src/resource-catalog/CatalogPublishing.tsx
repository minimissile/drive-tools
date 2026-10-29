import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, Download, ExternalLink, RefreshCw } from "lucide-react";
import type {
  CatalogDetail,
  CatalogItem,
  CatalogPreparation,
  CatalogProvider,
  CatalogPublication,
  CatalogSnapshot,
} from "../../shared/resource-catalog";
import {
  documentPlatformSpecs,
  documentProviders,
} from "../../shared/document-platforms";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { formatTime } from "../lib/format";
import { useAppActions } from "../state";
import {
  Button,
  Empty,
  Field,
  Loading,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";

export function CatalogPublishing({
  detail,
  onChanged,
  onManageAccounts,
}: {
  detail: CatalogDetail;
  onChanged(): void;
  onManageAccounts(): void;
}) {
  const { notify } = useAppActions();
  const accounts = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
  });
  const [provider, setProvider] = useState<CatalogProvider>("feishu");
  const [accountId, setAccountId] = useState("");
  const [selectedId, setSelectedId] = useState(
    () => detail.preparations.find((item) => !item.confirmedAt)?.id ?? "",
  );
  const [prepared, setPrepared] = useState<{
    preparation: CatalogPreparation;
    snapshot: CatalogSnapshot;
  } | null>(null);
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const [url, setUrl] = useState(() => {
    const first = detail.preparations.find((item) => !item.confirmedAt);
    return (
      detail.publications.find((item) => item.id === first?.publicationId)
        ?.url ?? ""
    );
  });
  // Public access is an explicit acknowledgement for this submission, never a restored draft.
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const catalogId = detail.catalog.id;
  const archived = detail.catalog.archived;
  const availableAccounts = (accounts.data ?? []).filter(
    (account) => account.provider === provider,
  );
  const selectedAccount = availableAccounts.find(
    (account) => account.id === accountId,
  );
  useEffect(() => {
    if (
      accounts.data &&
      !availableAccounts.some((account) => account.id === accountId)
    )
      setAccountId(availableAccounts[0]?.id ?? "");
  }, [provider, accounts.data, accountId]);
  const preparations = [
    ...(prepared &&
    !detail.preparations.some((item) => item.id === prepared.preparation.id)
      ? [prepared.preparation]
      : []),
    ...detail.preparations,
  ].filter((item) => !item.confirmedAt && !confirmedIds.includes(item.id));
  const active = preparations.find((item) => item.id === selectedId);
  const frozen =
    prepared?.preparation.id === active?.id ? prepared?.snapshot : null;
  const activePublication = detail.publications.find(
    (item) => item.id === active?.publicationId,
  );

  const run = async <T,>(
    label: string,
    action: () => Promise<T>,
    done?: (value: T) => void,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setPending(label);
    setError("");
    try {
      const value = await action();
      if (mounted.current) done?.(value);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      lock.current = false;
      if (mounted.current) setPending("");
    }
  };
  const selectPreparation = (id: string) => {
    setSelectedId(id);
    const preparation = preparations.find((item) => item.id === id);
    setUrl(
      detail.publications.find((item) => item.id === preparation?.publicationId)
        ?.url ?? "",
    );
    setPublicConfirmed(false);
    setError("");
  };
  const prepare = (publication?: CatalogPublication) => {
    const targetProvider = publication?.provider ?? provider;
    const targetAccountId = publication?.accountId ?? accountId;
    void run(
      publication ? "正在准备原文档更新…" : "正在冻结发布内容…",
      () =>
        ipc("resourceCatalog.prepare", {
          id: catalogId,
          expectedRevision: detail.catalog.revision,
          provider: targetProvider,
          accountId: targetAccountId,
          publicationId: publication?.id,
        }),
      (value) => {
        setPrepared(value);
        setSelectedId(value.preparation.id);
        setUrl(publication?.url ?? "");
        setPublicConfirmed(false);
        notify(
          `已保存 V${value.preparation.version} 交接快照，请在官方平台完成编辑与分享。`,
          "success",
        );
        onChanged();
      },
    );
  };
  const copyContent = () => {
    if (!active) return;
    void run(
      "正在复制冻结内容…",
      () =>
        ipc("resourceCatalog.copy", {
          id: catalogId,
          preparationId: active.id,
        }),
      (result) => {
        notify(
          result.format === "rich"
            ? "已复制清单富文本，可粘贴到官方文档。"
            : "已复制清单文本，可粘贴到官方文档。",
          "success",
        );
      },
    );
  };
  const exportContent = (format: "xlsx" | "md") => {
    if (!active) return;
    void run(
      "正在导出冻结内容…",
      () =>
        ipc("resourceCatalog.export", {
          id: catalogId,
          preparationId: active.id,
          format,
        }),
      (path) => {
        if (path) notify(`已导出 V${active.version} 交接文件。`, "success");
      },
    );
  };
  const confirm = () => {
    if (!active || !publicConfirmed || !url.trim()) return;
    const preparationId = active.id;
    void run(
      "正在登记文档链接…",
      () =>
        ipc("resourceCatalog.confirm", {
          id: catalogId,
          preparationId,
          url: url.trim(),
          publicConfirmed: true,
        }),
      () => {
        setConfirmedIds((ids) => [...ids, preparationId]);
        setSelectedId("");
        setPrepared(null);
        setPublicConfirmed(false);
        setUrl("");
        notify(
          "已登记文档链接与交接版本；平台内容和访问权限以你的实际操作为准。",
          "success",
        );
        onChanged();
      },
    );
  };
  const copyLink = (value: string) =>
    void run(
      "正在复制文档链接…",
      () => ipc("system.copyText", { text: value }),
      () => notify("已复制文档链接。", "success"),
    );
  const openPublication = (publication: CatalogPublication) =>
    void run(
      "正在打开原文档…",
      () =>
        ipc("websiteAccounts.openDocument", {
          id: publication.accountId,
          url: publication.url,
        }),
      () => notify("已打开关联账号的官方文档窗口。", "info"),
    );

  return (
    <div className="catalog-publishing">
      <Panel
        title="发布交接"
        extra={
          <Button quiet disabled={!!pending} onClick={onManageAccounts}>
            管理文档账号
          </Button>
        }
      >
        <p className="muted">
          冻结这一版清单，在官方平台粘贴或导入后，将可供访问的文档链接登记到这里。
        </p>
        {archived ? (
          <Notice>此清单已归档。恢复后可准备交接、复制内容和登记更新。</Notice>
        ) : null}
        {accounts.loading && !accounts.data ? (
          <LoadingState compact label="正在读取文档平台账号…" />
        ) : null}
        <QueryError
          error={accounts.error}
          loading={accounts.loading}
          onRetry={accounts.reload}
          title="文档账号读取失败"
        />
        {accounts.data ? (
          <>
            <div className="catalog-publish-toolbar">
              <Field label="文档平台">
                <Select
                  aria-label="清单发布平台"
                  value={provider}
                  disabled={!!pending || archived}
                  onValueChange={(value) => {
                    setProvider(value as CatalogProvider);
                    setAccountId("");
                  }}
                  items={documentProviders.map((value) => ({
                    value,
                    label: documentPlatformSpecs[value].name,
                  }))}
                />
              </Field>
              <Field label="关联账号">
                <Select
                  aria-label="清单发布账号"
                  value={accountId}
                  disabled={
                    !!pending ||
                    archived ||
                    !!accounts.error ||
                    !availableAccounts.length
                  }
                  onValueChange={setAccountId}
                  items={
                    availableAccounts.length
                      ? availableAccounts.map((account) => ({
                          value: account.id,
                          label: `${account.alias} · ${account.status === "connected" ? "已识别会话" : "待登录"}`,
                        }))
                      : [{ value: "", label: "请先添加此平台账号" }]
                  }
                />
              </Field>
              <Button
                primary
                disabled={
                  !!pending ||
                  archived ||
                  !selectedAccount ||
                  !!accounts.error ||
                  !detail.current.items.length
                }
                onClick={() => prepare()}
              >
                准备发布内容
              </Button>
            </div>
            {!availableAccounts.length ? (
              <Notice>
                尚未连接{documentPlatformSpecs[provider].name}。请到“账号管理 →
                其他账号”添加账号并登录。
                <Button quiet disabled={!!pending} onClick={onManageAccounts}>
                  去添加账号
                </Button>
              </Notice>
            ) : selectedAccount?.status !== "connected" ? (
              <p className="muted">
                可以先准备本地交接内容；打开官方文档前，请在其他账号中完成登录并检查会话。
              </p>
            ) : null}
          </>
        ) : null}

        {preparations.length ? (
          <div className="catalog-handoff">
            <Field label="待登记的交接">
              <Select
                aria-label="待登记交接版本"
                disabled={!!pending || archived}
                value={selectedId}
                onValueChange={selectPreparation}
                items={[
                  { value: "", label: "选择已有交接，或准备一份新内容" },
                  ...preparations.map((item) => ({
                    value: item.id,
                    label: `V${item.version} · ${documentPlatformSpecs[item.provider].name} · ${item.accountAlias}${item.publicationId ? " · 更新原文档" : ""}`,
                  })),
                ]}
              />
            </Field>
            {active ? (
              <>
                <div className="catalog-handoff-meta">
                  <strong>
                    V{active.version} ·{" "}
                    {documentPlatformSpecs[active.provider].name}
                  </strong>
                  <span>
                    {active.accountAlias} · {formatTime(active.createdAt)}
                  </span>
                  <Status kind="warning">
                    {active.publicationId ? "原文档更新待登记" : "新文档待登记"}
                  </Status>
                </div>
                {frozen ? (
                  <p className="muted">
                    此交接冻结了 {frozen.items.length}{" "}
                    项资源。复制、导出与后续登记均使用这份内容。
                  </p>
                ) : (
                  <p className="muted">
                    已恢复此交接的版本记录。复制和导出会使用当时的冻结内容；清单预览展示的是当前资源。
                  </p>
                )}
                {active.hash !== detail.current.hash ? (
                  <Notice warning>
                    资源或清单配置已变化。此交接仍保留 V{active.version}{" "}
                    的冻结内容；如要发布最新内容，请重新准备。
                  </Notice>
                ) : null}
                <div className="catalog-publish-actions">
                  <Button
                    primary
                    disabled={!!pending || archived}
                    onClick={copyContent}
                  >
                    <ClipboardCopy size={14} />
                    复制交接内容
                  </Button>
                  <Button
                    disabled={!!pending || archived}
                    onClick={() =>
                      void run(
                        "正在打开官方文档…",
                        () =>
                          ipc("resourceCatalog.open", {
                            id: catalogId,
                            preparationId: active.id,
                          }),
                        () =>
                          notify(
                            active.publicationId
                              ? "已打开原文档，请更新内容并确认分享权限。"
                              : "已打开官方工作台，请创建文档并粘贴或导入内容。",
                            "info",
                          ),
                      )
                    }
                  >
                    <ExternalLink size={14} />
                    {active.publicationId ? "打开原文档" : "打开官方工作台"}
                  </Button>
                  <Button
                    quiet
                    disabled={!!pending || archived}
                    onClick={() => exportContent("xlsx")}
                  >
                    <Download size={14} />
                    导出表格
                  </Button>
                  <Button
                    quiet
                    disabled={!!pending || archived}
                    onClick={() => exportContent("md")}
                  >
                    导出 Markdown
                  </Button>
                </div>
                <div className="catalog-confirm-fields">
                  <Field
                    label={
                      activePublication ? "原文档分享链接" : "文档分享链接"
                    }
                    hint={
                      activePublication
                        ? "更新交接沿用原文档链接。发布到另一文档时，请新建交接。"
                        : "填写官方平台的完整文档链接，不能使用登录页或工作台地址。"
                    }
                  >
                    <input
                      aria-label="清单文档分享链接"
                      value={url}
                      type="url"
                      maxLength={2000}
                      placeholder="https://…"
                      disabled={!!pending || archived}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        setPublicConfirmed(false);
                      }}
                    />
                  </Field>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={publicConfirmed}
                      disabled={!!pending || archived}
                      onChange={(event) =>
                        setPublicConfirmed(event.target.checked)
                      }
                    />
                    <span>
                      我已在官方平台保存这一版内容，设置分享权限，并检查目标访问者可以打开文档。
                    </span>
                  </label>
                  <p className="muted">
                    登记只保存链接和版本记录，盘序不会自动提交文档或修改平台的公开权限。
                  </p>
                  <Button
                    primary
                    disabled={
                      !!pending || archived || !url.trim() || !publicConfirmed
                    }
                    onClick={confirm}
                  >
                    {active.publicationId ? "登记原文档更新" : "登记发布链接"}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {pending ? <Loading label={pending} /> : null}
        {error ? (
          <div role="alert">
            <Notice danger>{error}</Notice>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="发布维护"
        extra={
          <span className="muted">{detail.publications.length} 份文档</span>
        }
      >
        {detail.publications.length ? (
          <div className="catalog-publications">
            {detail.publications.map((publication) => (
              <article key={publication.id} className="catalog-publication">
                <div className="catalog-publication-heading">
                  <div>
                    <strong>
                      {documentPlatformSpecs[publication.provider].name}
                    </strong>
                    <p className="muted">
                      {publication.accountAlias} · 已登记 V{publication.version}{" "}
                      · {formatTime(publication.confirmedAt)}
                    </p>
                  </div>
                  <Status kind={publication.needsUpdate ? "warning" : "good"}>
                    {publication.needsUpdate
                      ? "本地内容待同步"
                      : "本地版本一致"}
                  </Status>
                </div>
                <p className="catalog-publication-url">{publication.url}</p>
                <div className="catalog-publish-actions">
                  <Button
                    disabled={!!pending}
                    onClick={() => openPublication(publication)}
                  >
                    <ExternalLink size={14} />
                    打开原文档
                  </Button>
                  <Button
                    quiet
                    disabled={!!pending}
                    onClick={() => copyLink(publication.url)}
                  >
                    <ClipboardCopy size={14} />
                    复制访问链接
                  </Button>
                  <Button
                    primary
                    disabled={
                      !!pending || archived || !detail.current.items.length
                    }
                    onClick={() => prepare(publication)}
                  >
                    <RefreshCw size={14} />
                    准备更新原文档
                  </Button>
                </div>
                {publication.needsUpdate ? (
                  <details className="catalog-publication-diff">
                    <summary>
                      查看与登记版本的差异：新增 {publication.diff.added.length}{" "}
                      · 变化 {publication.diff.changed.length} · 移除{" "}
                      {publication.diff.removed.length}
                      {publication.diff.metadataChanged
                        ? " · 清单说明变化"
                        : ""}
                    </summary>
                    <div className="catalog-diff-columns">
                      <DiffItems title="新增" items={publication.diff.added} />
                      <DiffItems
                        title="变化"
                        items={publication.diff.changed}
                      />
                      <DiffItems
                        title="移除"
                        items={publication.diff.removed}
                      />
                    </div>
                    {publication.diff.metadataChanged ? (
                      <p className="muted">
                        标题、分类或清单介绍已改变，准备更新时会一并带入。
                      </p>
                    ) : null}
                  </details>
                ) : (
                  <p className="muted">
                    当前公开内容与登记快照一致。平台上的实际内容、链接有效性和访问权限仍需在官方文档核对。
                  </p>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty compact title="还没有登记文档">
            准备交接并在官方平台完成分享后，在上方登记文档链接。
          </Empty>
        )}
        {detail.history.length ? (
          <details
            className="catalog-publication-history"
            open={showHistory}
            onToggle={(event) => setShowHistory(event.currentTarget.open)}
          >
            <summary>版本登记历史 · {detail.history.length} 条</summary>
            {showHistory ? (
              <ol>
                {detail.history.map((receipt) => (
                  <li key={receipt.preparationId}>
                    <strong>
                      V{receipt.version} ·{" "}
                      {documentPlatformSpecs[receipt.provider].name}
                    </strong>
                    <span>
                      {receipt.accountAlias} · {formatTime(receipt.confirmedAt)}
                    </span>
                    <p className="catalog-publication-url">{receipt.url}</p>
                    <Button
                      quiet
                      disabled={!!pending}
                      onClick={() => copyLink(receipt.url)}
                    >
                      复制此版本文档链接
                    </Button>
                  </li>
                ))}
              </ol>
            ) : null}
          </details>
        ) : null}
      </Panel>
    </div>
  );
}

function DiffItems({ title, items }: { title: string; items: CatalogItem[] }) {
  return (
    <section>
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
  );
}
