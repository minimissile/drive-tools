import { useDeferredValue, useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Copy,
  ExternalLink,
  Pencil,
  Plus,
} from "lucide-react";
import { useApp } from "../state";
import {
  Button,
  Cover,
  CopyStatus,
  Empty,
  Header,
  Notice,
  Panel,
  RecoverShare,
  SearchField,
  accountLabel,
  formatSize,
  providerName,
} from "../components";
import type { ResourcePage } from "../../shared/types";
export default function LibraryPage() {
  const {
    data,
    command,
    select,
    selectedResourceId,
    selectedCopyId,
    navigate,
    edit,
    notify,
    busy,
  } = useApp();
  const [query, setQuery] = useState(""),
    deferredQuery = useDeferredValue(query),
    [results, setResults] = useState<ResourcePage>({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
    }),
    [page, setPage] = useState(1),
    [loading, setLoading] = useState(true),
    [checked, setChecked] = useState<string[]>([]),
    [category, setCategory] = useState("all"),
    [accountId, setAccountId] = useState("all");
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void window.panxu
        .invoke<ResourcePage>("resource.page", {
          query: deferredQuery,
          category: category === "all" ? undefined : category,
          accountId: accountId === "all" ? undefined : accountId,
          page,
          pageSize: 25,
        })
        .then((r) => {
          if (active) {
            setResults(r);
            setChecked([]);
          }
        })
        .catch((e) => {
          if (active) notify(e.message, true);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [deferredQuery, category, accountId, page, notify, data?.resources]);
  const rows = results.items;
  const checkable = rows.flatMap((r) =>
    r.copies
      .filter(
        (c) =>
          c.status === "ready" &&
          (accountId === "all" || c.accountId === accountId),
      )
      .map((c) => c.id),
  );
  const inspectShares = async (copyIds: string[]) => {
    await command(
      "copies.check",
      { copyIds },
      "本人分享检查已完成，结果已记录到资源档案。",
    );
  };
  const resource = rows.find((r) => r.id === selectedResourceId) ?? rows[0];
  const copies =
    resource?.copies.filter(
      (c) => accountId === "all" || c.accountId === accountId,
    ) ?? [];
  const copy = copies.find((c) => c.id === selectedCopyId) ?? copies[0];
  const shareCheck = data!.shareChecks.find((c) => c.copyId === copy?.id);
  return (
    <>
      <Header
        title="让每份资源，产生内容。"
        description="采集、转存与内容运营，从你的本地资源库开始。"
        action={
          <Button primary onClick={() => edit(null)}>
            <Plus size={16} />
            录入资源
          </Button>
        }
      />
      <div className="stat-strip">
        <div>
          全部资源<strong>{data!.resourceTotals.resources}</strong>
        </div>
        <div>
          已归档副本
          <strong>{data!.resourceTotals.readyCopies}</strong>
        </div>
        <div>
          需要处理
          <strong>{data!.resourceTotals.attentionJobs}</strong>
        </div>
      </div>
      {data!.accounts.length === 0 ? (
        <Notice>
          先连接本人网盘账号，再录入资源。
          <Button quiet onClick={() => navigate("accounts")}>
            添加网盘账号 <ArrowRight size={14} />
          </Button>
        </Notice>
      ) : null}
      <div className="toolbar">
        <SearchField
          value={query}
          onChange={(v) => {
            setQuery(v);
            setPage(1);
          }}
        />
        <select
          aria-label="分类筛选"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">全部分类</option>
          {data!.resourceTotals.categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          aria-label="资源账号筛选"
          value={accountId}
          onChange={(e) => {
            setAccountId(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">全部账号</option>
          {data!.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.alias}
            </option>
          ))}
        </select>
      </div>
      <div className="toolbar">
        <label className="checkbox">
          <input
            type="checkbox"
            aria-label="选择本页可检查分享"
            checked={
              checkable.length > 0 && checked.length === checkable.length
            }
            disabled={checkable.length > 25 || loading}
            onChange={(e) => setChecked(e.target.checked ? checkable : [])}
          />
          选择本页本人分享
          {checkable.length > 25 ? "（请按账号筛选，每次最多25份）" : ""}
        </label>
        <Button
          disabled={!checked.length || busy > 0 || loading}
          onClick={() => void inspectShares(checked)}
        >
          检查所选 {checked.length} 份分享
        </Button>
        <Button quiet onClick={() => navigate("bulk")}>
          批量录入
        </Button>
      </div>
      <div className="library-layout">
        <section className="resource-list">
          <div className="list-heading">
            <span>资源名称</span>
            <span>{loading ? "读取中…" : `共 ${results.total} 份资源`}</span>
          </div>
          {rows.length ? (
            rows.map((r) => (
              <div key={r.id} className="resource-select-row">
                <input
                  type="checkbox"
                  aria-label={`检查${r.title}的分享`}
                  disabled={
                    !r.copies.some(
                      (c) =>
                        c.status === "ready" &&
                        (accountId === "all" || c.accountId === accountId),
                    ) || loading
                  }
                  checked={r.copies.some((c) => checked.includes(c.id))}
                  onChange={(e) => {
                    const ids = r.copies
                      .filter(
                        (c) =>
                          c.status === "ready" &&
                          (accountId === "all" || c.accountId === accountId),
                      )
                      .map((c) => c.id);
                    setChecked((old) =>
                      e.target.checked
                        ? [...new Set([...old, ...ids])].slice(0, 25)
                        : old.filter((id) => !ids.includes(id)),
                    );
                  }}
                />
                <button
                  key={r.id}
                  className={`resource-row ${r.id === resource?.id ? "selected" : ""}`}
                  onClick={() => select(r.id)}
                >
                  <Cover id={r.coverId} title={r.title} />
                  <div className="resource-row-copy">
                    <strong>{r.title}</strong>
                    <div className="muted">
                      {providerName(r.provider)}网盘<span>·</span>
                      {r.category}
                      <span>·</span>
                      {r.copies.length} 个账号副本
                    </div>
                    <div className="row compact">
                      {r.tags.slice(0, 3).map((t) => (
                        <span className="tag" key={t}>
                          {t}
                        </span>
                      ))}
                      <span
                        className={
                          r.copies.some((c) => c.status === "ready")
                            ? "good-text"
                            : "muted"
                        }
                      >
                        {r.copies.some((c) => c.status === "ready")
                          ? "本人分享已就绪"
                          : "等待归档"}
                      </span>
                    </div>
                  </div>
                  <small className="resource-date">
                    {new Date(r.updatedAt).toLocaleDateString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                    })}
                  </small>
                </button>
              </div>
            ))
          ) : loading ? (
            <p className="muted">正在读取资源…</p>
          ) : (
            <Empty
              title={query ? "没有找到匹配资源" : "你的资源库从这里开始"}
              action={
                <Button primary onClick={() => edit(null)}>
                  <Plus size={15} />
                  录入第一份资源
                </Button>
              }
            >
              录入标题和分享链接，转存后生成自己的分享，资源信息自动留在本地。
            </Empty>
          )}
          <div className="row spread pagination" aria-label="资源翻页">
            <Button
              disabled={loading || results.page <= 1}
              onClick={() => setPage(results.page - 1)}
            >
              上一页
            </Button>
            <small>
              第 {results.page} /{" "}
              {Math.max(1, Math.ceil(results.total / results.pageSize))} 页 ·
              每页 {results.pageSize} 份
            </small>
            <Button
              disabled={
                loading || results.page * results.pageSize >= results.total
              }
              onClick={() => setPage(results.page + 1)}
            >
              下一页
            </Button>
          </div>
        </section>
        {resource && copy ? (
          <Panel
            title="资源档案"
            extra={<small>{providerName(resource.provider)}网盘</small>}
            className="resource-detail"
          >
            <Cover id={resource.coverId} title={resource.title} large />
            <h2 className="detail-title">{resource.title}</h2>
            <div className="row compact">
              {resource.tags.map((t) => (
                <span className="tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
            <p className="detail-summary">
              {resource.summary ||
                "还没有填写资源说明。补充适合人群与具体内容，有助于后续提词。"}
            </p>
            <hr />
            <FieldLike label="资源副本">
              <select
                aria-label="档案账号副本"
                value={copy.id}
                onChange={(e) => select(resource.id, e.target.value)}
              >
                {copies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {accountLabel(data!.accounts, c.accountId)}
                  </option>
                ))}
              </select>
            </FieldLike>
            <div className="property">
              <span>状态</span>
              <CopyStatus copy={copy} />
            </div>
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
            <small>本人分享链接</small>
            <div className="link-box">
              {copy.shareUrl ?? "转存与核验完成后，生成本人分享链接。"}
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
            <Button
              disabled={copy.status !== "ready" || busy > 0}
              onClick={() => void inspectShares([copy.id])}
            >
              检查此本人分享
            </Button>
            <div className="row detail-actions">
              <Button
                disabled={!copy.shareUrl}
                onClick={async () => {
                  const result = await command<{ text: string }>("copy.link", {
                    copyId: copy.id,
                  });
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
                quiet
                onClick={() => void command("copy.open", { id: copy.id })}
              >
                <ExternalLink size={14} />
                网盘
              </Button>
            </div>
            <div className="row detail-actions">
              <Button
                primary
                disabled={copy.status !== "ready"}
                onClick={() => {
                  select(resource.id, copy.id);
                  navigate("traffic");
                }}
              >
                进入选题
                <ArrowRight size={14} />
              </Button>
              <Button onClick={() => edit(resource.id, copy.id)}>
                <Pencil size={13} />
                {copy.status === "draft" ? "继续录入" : "编辑资料"}
              </Button>
            </div>
            <div className="row detail-actions">
              <Button
                quiet
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
              </Button>
              <Button
                quiet
                disabled={copy.noteStatus !== "synced"}
                onClick={() => void command("notes.open", { copyId: copy.id })}
              >
                打开笔记
              </Button>
            </div>
            <div className="row detail-actions">
              <Button quiet onClick={() => edit(resource.id, "new")}>
                另存到其他账号
              </Button>
              <Button
                disabled={copy.status !== "ready"}
                onClick={() => {
                  select(resource.id, copy.id);
                  navigate("split");
                }}
              >
                拆分为多个链接
              </Button>
              <RecoverShare copy={copy} />
            </div>
            <details className="private-source">
              <summary>内部追溯信息</summary>
              <small>来源链接仅作内部记录，禁止用于对外分发。</small>
              <p>{resource.sourceUrl}</p>
              <small>保存目录</small>
              <p>{copy.directory}</p>
            </details>
          </Panel>
        ) : null}
      </div>
    </>
  );
}
function FieldLike({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
    </div>
  );
}
