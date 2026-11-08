import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ExternalLink, Plus, RefreshCw, Save, Send } from "lucide-react";
import {
  bilibiliKinds,
  type BilibiliDraft,
  type BilibiliPreview,
} from "../../shared/bilibili";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import {
  useAppActions,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import { ResourcePicker } from "../resources/components";
import { formatTime } from "../lib/format";
import {
  Button,
  Empty,
  Field,
  Header,
  LoadingState,
  Notice,
} from "../ui/primitives";
import { DataState } from "../ui/DataState";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { SearchSelect } from "../ui/SearchSelect";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { BilibiliEditor, type EditorFields } from "./editor";
import "./workspace.css";

const navigationSchema = z.object({
  accountId: z.string(),
  draftId: z.string(),
  copyId: z.string(),
  newKey: z.string(),
  tab: z.enum(["content", "guide"]),
});
const stageLabel = {
  draft: "本地草稿",
  prepared: "官网填写完成",
  attention: "待处理",
};

export default function BilibiliWorkspace() {
  const { data } = useAppData();
  const { resource, copy, select } = useAppSelection();
  const { navigate } = useAppNavigation();
  const { notify } = useAppActions();
  const scope = data!.dataPath;
  const navigation = useLocalDraft(
    `bilibili-workspace:v1:${scope}`,
    {
      accountId: "",
      draftId: "",
      copyId: "",
      newKey: "initial",
      tab: "content" as "content" | "guide",
    },
    (raw) => navigationSchema.parse(raw),
  );
  const v = navigation.value;
  const accountsQuery = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
  });
  const drafts = useIpcQuery("bilibili.list", undefined, {
    keepPrevious: true,
  });
  const accounts = (accountsQuery.data ?? []).filter(
    (account) => account.provider === "bilibili",
  );
  const account =
    accounts.find((item) => item.id === v.accountId) ??
    (!v.accountId ? accounts[0] : undefined);
  const accountId = account?.id ?? v.accountId;
  const selected = useIpcQuery(
    "bilibili.get",
    { id: v.draftId },
    { enabled: !!v.draftId },
  );
  const [seed, setSeed] = useState<EditorFields | null>(null);
  const [preview, setPreview] = useState<BilibiliPreview | null>(null);
  const [operation, setOperation] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const perform = async (name: string, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setOperation(name);
    setError("");
    try {
      await action();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      lock.current = false;
      if (mounted.current) setOperation("");
    }
  };
  const reloadAccounts = () => accountsQuery.reload();
  const connect = () =>
    void perform("connect", async () => {
      const created = await ipc("websiteAccounts.add", {
        provider: "bilibili",
      });
      if (!mounted.current) return;
      navigation.update({
        accountId: created.id,
        draftId: "",
        copyId: "",
        newKey: crypto.randomUUID(),
      });
      reloadAccounts();
      await ipc("websiteAccounts.login", { id: created.id });
      if (mounted.current) {
        reloadAccounts();
        notify("已打开B站官方登录窗口，登录后点击核验账号。", "info");
      }
    });
  const accountAction = (kind: "login" | "check") => {
    if (!account) return;
    void perform(kind, async () => {
      if (kind === "login") {
        await ipc("websiteAccounts.login", { id: account.id });
        if (mounted.current)
          notify("已打开B站登录窗口，登录后核验账号身份。", "info");
      } else {
        const checked = await ipc("websiteAccounts.check", { id: account.id });
        if (mounted.current)
          notify(
            checked.status === "connected" && !checked.unverified
              ? "B站账号身份已核实。"
              : checked.message || "账号尚未完成核验，请查看当前身份。",
            checked.status === "connected" && !checked.unverified
              ? "success"
              : "warning",
          );
      }
      if (mounted.current) reloadAccounts();
    });
  };
  const reset = (patch: Partial<typeof v>) => {
    setSeed(null);
    setPreview(null);
    setError("");
    navigation.update(patch);
  };
  const openDraft = (id: string) => {
    const draft = drafts.data?.find((item) => item.id === id);
    if (!draft) return;
    reset({ draftId: id, accountId: draft.accountId, copyId: draft.copyId });
    const match = data?.resources.find((item) =>
      item.copies.some((candidate) => candidate.id === draft.copyId),
    );
    if (match) select(match.id, draft.copyId);
  };
  const saved = selected.data;
  const editorCopyId = v.copyId || saved?.copyId || copy?.id || "";
  const linkedResource = resource?.copies.some(
    (item) => item.id === editorCopyId,
  )
    ? resource
    : data?.resources.find((item) =>
        item.copies.some((candidate) => candidate.id === editorCopyId),
      );
  const visibleDrafts = (drafts.data ?? []).filter(
    (draft) => !accountId || draft.accountId === accountId,
  );
  const acceptSaved = (draft: BilibiliDraft, nextPreview?: BilibiliPreview) => {
    setSeed(null);
    if (nextPreview) setPreview(nextPreview);
    navigation.update({
      draftId: draft.id,
      copyId: draft.copyId,
      accountId: draft.accountId,
    });
    if (draft.id === v.draftId) selected.setData(draft);
    drafts.reload();
  };

  return (
    <div className="bilibili-workspace">
      <Header
        title="哔哩哔哩内容操作"
        description="连接本人账号，整理视频、图文动态与专栏稿件，再交付到官网编辑器。"
        action={
          <Button quiet onClick={() => navigate("bilibili-accounts")}>
            管理B站账号
          </Button>
        }
      />
      <section className="bilibili-account panel" aria-label="B站账号连接">
        {accountsQuery.error ? (
          <QueryError
            error={accountsQuery.error}
            loading={accountsQuery.loading}
            onRetry={accountsQuery.reload}
            title="暂时无法读取B站账号"
          />
        ) : null}
        {!accountsQuery.data && accountsQuery.loading ? (
          <LoadingState compact label="正在读取B站账号…" />
        ) : null}
        {accounts.length ? (
          <>
            <div className="bilibili-account-controls">
              <Field label="B站账号">
                <Select
                  aria-label="B站账号"
                  value={accountId}
                  disabled={!!operation}
                  onValueChange={(id) =>
                    reset({
                      accountId: id,
                      draftId: "",
                      copyId: "",
                      newKey: crypto.randomUUID(),
                    })
                  }
                  items={accounts.map((item) => ({
                    value: item.id,
                    label: item.nickname
                      ? `${item.alias} · ${item.nickname}`
                      : item.alias,
                  }))}
                />
              </Field>
              <Button
                disabled={!account || !!operation}
                onClick={() => accountAction("login")}
              >
                打开登录窗口
              </Button>
              <Button
                disabled={!account || !!operation}
                onClick={() => accountAction("check")}
              >
                <RefreshCw size={14} />
                {operation === "check" ? "正在核验…" : "核验账号"}
              </Button>
              <Button quiet disabled={!!operation} onClick={connect}>
                <Plus size={14} />
                添加账号
              </Button>
            </div>
            {account ? (
              <AccountStatus account={account} />
            ) : (
              <Notice warning>原账号已不可用，请选择其它B站账号。</Notice>
            )}
          </>
        ) : accountsQuery.data ? (
          <Empty
            compact
            icon={Send}
            title="连接一个B站账号"
            action={
              <Button primary disabled={!!operation} onClick={connect}>
                {operation === "connect" ? "正在连接…" : "连接B站账号"}
              </Button>
            }
          >
            使用B站官方登录窗口扫码或登录，盘序核验身份后关联稿件。
          </Empty>
        ) : null}
        {error ? (
          <DataState kind="error" compact title="账号操作未完成">
            {error}
          </DataState>
        ) : null}
      </section>
      {navigation.error ? <Notice warning>{navigation.error}</Notice> : null}
      <Tabs value={v.tab} onChange={(tab) => navigation.update({ tab })}>
        <TabList
          label="B站内容工作区"
          items={[
            ["content", "稿件"],
            ["guide", "使用与功能"],
          ]}
        />
        <TabPanel value="content">
          <div className="bilibili-content-grid">
            <aside
              className="bilibili-draft-list panel"
              aria-label="B站本地稿件"
            >
              <div className="bilibili-section-heading">
                <strong>本地稿件</strong>
                <Button
                  quiet
                  size="compact"
                  onClick={() =>
                    reset({
                      draftId: "",
                      copyId: copy?.id ?? "",
                      newKey: crypto.randomUUID(),
                    })
                  }
                >
                  <Plus size={14} />
                  新建稿件
                </Button>
              </div>
              {drafts.error ? (
                <QueryError
                  error={drafts.error}
                  loading={drafts.loading}
                  onRetry={drafts.reload}
                  title="暂时无法读取稿件"
                />
              ) : null}
              {!drafts.data && drafts.loading ? (
                <LoadingState compact label="正在读取本地稿件…" />
              ) : null}
              {drafts.data ? (
                <SearchSelect
                  label="查找B站稿件"
                  value={{
                    value: v.draftId,
                    label:
                      drafts.data.find((draft) => draft.id === v.draftId)
                        ?.title ?? "新建稿件",
                  }}
                  items={visibleDrafts.map((draft) => ({
                    value: draft.id,
                    label: `${draft.title} · ${bilibiliKinds[draft.kind]}`,
                  }))}
                  onChange={openDraft}
                  placeholder="搜索本地稿件…"
                  emptyMessage="该账号暂无匹配稿件"
                />
              ) : null}
              {visibleDrafts.length ? (
                <ul>
                  {visibleDrafts.map((draft) => (
                    <li key={draft.id}>
                      <button
                        type="button"
                        className="bilibili-draft-row"
                        aria-current={
                          v.draftId === draft.id ? "true" : undefined
                        }
                        onClick={() => openDraft(draft.id)}
                      >
                        <strong>{draft.title}</strong>
                        <span>
                          {bilibiliKinds[draft.kind]} ·{" "}
                          {stageLabel[draft.stage]}
                        </span>
                        <small>{formatTime(draft.updatedAt)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : drafts.data && !drafts.error ? (
                <Empty compact icon={Save} title="还没有保存的稿件">
                  填写内容后保存，稿件与官网准备记录会保留在本机。
                </Empty>
              ) : null}
            </aside>
            <section
              className="bilibili-editor-region panel"
              aria-label="B站稿件编辑"
            >
              {resource ? (
                <ResourcePicker />
              ) : (
                <Notice>
                  尚未选择资源，可先编辑文字，或到资源库选择资料后返回。
                </Notice>
              )}
              {v.draftId && selected.error ? (
                <QueryError
                  error={selected.error}
                  loading={selected.loading}
                  onRetry={selected.reload}
                  title="暂时无法打开该稿件"
                />
              ) : null}
              {v.draftId && !saved && selected.loading ? (
                <LoadingState compact label="正在读取稿件…" />
              ) : null}
              {(!v.draftId || saved) && !selected.error ? (
                <BilibiliEditor
                  key={`${scope}:${accountId}:${v.draftId || v.newKey}:${editorCopyId}`}
                  scope={scope}
                  account={account}
                  accountId={accountId}
                  copyId={editorCopyId}
                  resource={linkedResource}
                  currentCopyId={copy?.id ?? ""}
                  saved={saved ?? null}
                  seed={seed}
                  initialPreview={
                    preview?.draft.id === v.draftId ? preview : null
                  }
                  editorKey={v.draftId || v.newKey}
                  onSaved={acceptSaved}
                  onAssociate={(fields) => {
                    setSeed(fields);
                    setPreview(null);
                    navigation.update({ copyId: copy?.id ?? "" });
                  }}
                />
              ) : null}
            </section>
          </div>
        </TabPanel>
        <TabPanel value="guide">
          <BilibiliGuide />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function AccountStatus({ account }: { account: WebsiteAccountView }) {
  const connected = account.status === "connected" && !account.unverified;
  return (
    <div className="bilibili-account-status" role="status">
      <span className={`tag${connected ? " success" : ""}`}>
        {account.checking
          ? "正在检查"
          : account.unverified
            ? "待核验"
            : connected
              ? "身份已核实"
              : account.status === "expired"
                ? "登录已失效"
                : "尚未连接"}
      </span>
      <span>
        {account.nickname || account.alias}
        {account.uid ? ` · UID ${account.uid}` : " · 尚未取得UID"}
      </span>
      {account.checkedAt ? (
        <small>核验于 {formatTime(account.checkedAt)}</small>
      ) : null}
      {account.message ? <p>{account.message}</p> : null}
    </div>
  );
}

function BilibiliGuide() {
  return (
    <section className="bilibili-guide panel" aria-label="B站功能与使用说明">
      <h2>从本地稿件到官网准备</h2>
      <p>
        先连接并核验B站账号，选择资源与稿件形式。文字和制作素材保存在本机；“填写官网投稿”才会上传所选素材并填写官网编辑器，最终提交在官网完成。
      </p>
      <table>
        <thead>
          <tr>
            <th>稿件形式</th>
            <th>当前流程</th>
            <th>官网核对事项</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>视频投稿</td>
            <td>资源目录或预览图片制作视频 → 选择成片 → 标题、简介和标签</td>
            <td>分区、封面裁切、原创/转载类型、音乐使用范围</td>
          </tr>
          <tr>
            <td>图文动态</td>
            <td>编辑文字 → 关联真实资源封面 → 官网动态编辑器</td>
            <td>图片上传结果、话题、可见范围</td>
          </tr>
          <tr>
            <td>专栏文章</td>
            <td>编辑标题与正文 → 官网专栏编辑器</td>
            <td>正文排版、图片、分类、封面、标签</td>
          </tr>
        </tbody>
      </table>
      <h3>准备记录与发布结果</h3>
      <p>
        官网填写完成不代表发布成功。仅记录你回填的官网内容链接，状态保持“待核实”；后续再接入官方审核状态及作品数据统计。
      </p>
      <h3>资源与推广内容</h3>
      <p>
        内容应完整说明资料用途与实际内容。网盘链接、商业推广声明及承载位置按B站社区公约和当前账号能力核查，不默认附加引流链接。
      </p>
      <Button
        quiet
        onClick={() =>
          void ipc("system.external", {
            url: "https://member.bilibili.com/studio/convention/",
          })
        }
      >
        <ExternalLink size={14} />
        查看B站社区公约
      </Button>
    </section>
  );
}
