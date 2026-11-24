import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Plus, SlidersHorizontal, Users } from "lucide-react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatTime } from "../lib/format";
import { useAppData, useAppNavigation } from "../state";
import {
  Button,
  Empty,
  Field,
  Header,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { Select } from "../ui/Select";
import { SearchSelect } from "../ui/SearchSelect";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { QueryError } from "../ui/QueryError";
import { Dialog } from "../ui/Dialog";
import {
  jianshuTemplateItems,
  type JianshuDetail,
  type JianshuTemplate,
} from "../../shared/jianshu";
import type { JianshuSourceMaterial } from "../../shared/jianshu-sources";
import {
  collectionDriveLabels,
  collectionDriveType,
} from "../../shared/resource-collection";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import { Sources } from "./Sources";
import { DraftList } from "./DraftList";
import { Records } from "./Records";
import { ArticleEditor } from "./ArticleEditor";
import { AccountStatus } from "./AccountStatus";
import { jianshuAccountLabel, localServiceError } from "./labels";
import "./jianshu.css";
const schema = z.object({
  tab: z.enum(["compose", "records"]),
  selected: z.string(),
  creating: z.boolean().default(false),
  draftQuery: z.string().max(200).default(""),
  mode: z.enum(["library", "sources"]),
  copyId: z.string(),
  copyTitle: z.string(),
  accountId: z.string(),
  template: z.enum(["resource", "guide"]),
  sourceIds: z.array(z.string()).max(20),
  resourceQuery: z.string().max(100),
});
export default function JianshuWorkflow() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation();
  const form = useLocalDraft(
    `panxu:jianshu:${data!.dataPath}:workspace`,
    {
      tab: "compose" as "compose" | "records",
      selected: "",
      creating: false,
      draftQuery: "",
      mode: "library" as "library" | "sources",
      copyId: "",
      copyTitle: "",
      accountId: "",
      template: "resource" as JianshuTemplate,
      sourceIds: [] as string[],
      resourceQuery: "",
    },
    (v) => schema.parse(v),
  );
  const history = useIpcQuery("jianshu.list", undefined, {
    keepPrevious: true,
  });
  const creating =
    !form.value.selected && (form.value.creating || history.data?.length === 0);
  const accounts = useIpcQuery(
    "websiteAccounts.list",
    { provider: "jianshu" },
    { keepPrevious: true },
  );
  const detail = useIpcQuery(
    "jianshu.get",
    { id: form.value.selected },
    { enabled: !!form.value.selected, keepPrevious: false },
  );
  const currentArticle =
    detail.data?.article.id === form.value.selected ? detail.data : null;
  const matches = useIpcQuery(
    "jianshu.matches",
    { keyword: form.value.resourceQuery },
    {
      delay: 180,
      enabled:
        creating &&
        form.value.tab === "compose" &&
        form.value.mode === "library",
      keepPrevious: true,
    },
  );
  const [pending, setPending] = useState(false),
    [failure, setFailure] = useState(""),
    [showNewSettings, setShowNewSettings] = useState(false),
    [inspecting, setInspecting] = useState<JianshuSourceMaterial | null>(null);
  const lock = useRef(false),
    alive = useRef(true),
    navigation = useRef(0);
  const current = useRef<HTMLElement>(null);
  const newArticleButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const open = (id: string) => {
    navigation.current++;
    form.update({ selected: id, creating: !id, tab: "compose" });
    setFailure("");
  };
  const changeTab = (tab: "compose" | "records") => {
    if (tab !== form.value.tab) navigation.current++;
    form.update({ tab });
  };
  const beginArticle = () => {
    open("");
    const token = navigation.current;
    requestAnimationFrame(() => {
      if (navigation.current === token) current.current?.focus();
    });
  };
  const cancelArticle = () => {
    navigation.current++;
    form.update({ creating: false });
    setFailure("");
    newArticleButton.current?.focus();
  };
  const create = async (blank = false) => {
    if (lock.current) return;
    const startedFrom = navigation.current;
    lock.current = true;
    setPending(true);
    setFailure("");
    try {
      const next = await ipc("jianshu.create", {
        requestId: crypto.randomUUID(),
        template: form.value.template,
        accountId: form.value.accountId || null,
        copyId:
          !blank && form.value.mode === "library"
            ? form.value.copyId || null
            : null,
        sourceIds:
          !blank && form.value.mode === "sources" ? form.value.sourceIds : [],
        title: "",
        body: "",
      });
      if (alive.current) {
        history.reload();
        if (navigation.current === startedFrom) {
          detail.setData(next);
          open(next.article.id);
        }
      }
    } catch (error) {
      if (alive.current && navigation.current === startedFrom)
        setFailure(
          error instanceof Error ? error.message : "文章创建失败，请重试。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  const changed = (next: JianshuDetail) => {
    detail.setData(next);
    history.reload();
  };
  const hasInput =
    form.value.mode === "library"
      ? !!form.value.copyId
      : !!form.value.sourceIds.length;
  const lastAccount = accounts.data?.find((a) => a.id === form.value.accountId);
  const accountVerified = (next: WebsiteAccountView) => {
    if (!alive.current) return;
    accounts.setData(
      (accounts.data ?? []).map((account) =>
        account.id === next.id ? next : account,
      ),
    );
  };
  return (
    <div className="jianshu-workspace">
      <Tabs
        value={form.value.tab}
        onChange={changeTab}
        className="jianshu-tabs"
      >
        <Header
          title="简书内容"
          action={
            <div className="jianshu-page-tools">
              <TabList
                label="简书工作区"
                items={[
                  ["compose", "创作发布"],
                  ["records", "发布记录"],
                ]}
              />
              <div className="jianshu-page-actions">
                <Button quiet onClick={() => navigate("jianshu-accounts")}>
                  <Users size={14} aria-hidden="true" />
                  管理简书账号
                </Button>
                <Button
                  ref={newArticleButton}
                  primary
                  disabled={pending}
                  aria-controls="jianshu-current-article"
                  onClick={beginArticle}
                >
                  <Plus size={14} aria-hidden="true" />
                  新建文章
                </Button>
              </div>
            </div>
          }
        />
        {form.error ? <Notice warning>{form.error}</Notice> : null}
        <TabPanel value="compose" keepMounted>
          <div className="jianshu-compose-layout">
            <DraftList
              rows={history.data}
              selected={form.value.selected}
              query={form.value.draftQuery}
              loading={history.loading}
              error={history.error}
              onSearch={(draftQuery) =>
                form.update({ draftQuery: draftQuery.slice(0, 200) })
              }
              onOpen={open}
              onReload={history.reload}
            />
            <section
              ref={current}
              className="jianshu-current"
              id="jianshu-current-article"
              tabIndex={-1}
              aria-label="当前简书文章"
            >
              {failure ? (
                <Notice danger>{localServiceError(failure)}</Notice>
              ) : null}
              {creating ? (
                <Panel
                  title="开始一篇文章"
                  className="jianshu-new"
                  extra={
                    <div className="jianshu-actions">
                      <Button
                        quiet
                        size="compact"
                        disabled={pending}
                        aria-expanded={showNewSettings}
                        aria-controls="jianshu-new-settings"
                        onClick={() =>
                          setShowNewSettings((visible) => !visible)
                        }
                      >
                        <SlidersHorizontal size={14} aria-hidden="true" />
                        新稿设置
                      </Button>
                      {history.data?.length ? (
                        <Button
                          quiet
                          size="compact"
                          disabled={pending}
                          onClick={cancelArticle}
                        >
                          取消新建
                        </Button>
                      ) : null}
                    </div>
                  }
                >
                  <div
                    className="jianshu-new-options"
                    id="jianshu-new-settings"
                    hidden={!showNewSettings}
                  >
                    <div className="jianshu-form-row field-pair">
                      <Field label="简书账号">
                        <Select
                          aria-label="新文章简书账号"
                          value={form.value.accountId}
                          onValueChange={(accountId) =>
                            form.update({ accountId })
                          }
                          items={[
                            { value: "", label: "先写文章，稍后选择账号" },
                            ...(accounts.data ?? []).map((a) => ({
                              value: a.id,
                              label: jianshuAccountLabel(a),
                            })),
                            ...(form.value.accountId && !lastAccount
                              ? [
                                  {
                                    value: form.value.accountId,
                                    label: "原账号不可用，请重新选择",
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </Field>
                      <Field label="文章模板">
                        <Select
                          aria-label="新文章模板"
                          value={form.value.template}
                          onValueChange={(template) =>
                            form.update({
                              template: template as JianshuTemplate,
                            })
                          }
                          items={jianshuTemplateItems}
                        />
                      </Field>
                    </div>
                    <AccountStatus
                      account={lastAccount}
                      disabled={pending}
                      onVerified={accountVerified}
                    />
                    <QueryError
                      error={accounts.error}
                      loading={accounts.loading}
                      onRetry={accounts.reload}
                    />
                  </div>
                  <Tabs
                    value={form.value.mode}
                    onChange={(mode) => form.update({ mode })}
                  >
                    <TabList
                      label="文章内容来源"
                      items={[
                        ["library", "资源库"],
                        ["sources", "第三方采集"],
                      ]}
                    />
                    <TabPanel value="library" keepMounted>
                      <Field
                        label="选择本人资源"
                        hint="使用已核验的本人分享，资料获取区会自动加入正文预览。"
                      >
                        <SearchSelect
                          label="搜索简书创作资源"
                          inputValue={form.value.resourceQuery}
                          onQueryChange={(resourceQuery) =>
                            form.update({ resourceQuery })
                          }
                          value={{
                            value: form.value.copyId,
                            label: form.value.copyTitle || "选择一份资料",
                          }}
                          items={(matches.data ?? []).map((r) => ({
                            value: r.copyId,
                            label: `${r.title} · ${r.accountAlias}`,
                          }))}
                          onChange={(copyId) => {
                            const row = matches.data?.find(
                              (r) => r.copyId === copyId,
                            );
                            form.update({
                              copyId,
                              copyTitle: row?.title || "",
                              resourceQuery: "",
                            });
                          }}
                          loading={matches.loading}
                          error={localServiceError(matches.error)}
                          onRetry={matches.reload}
                        />
                      </Field>
                      {!matches.loading &&
                      matches.data?.length === 0 &&
                      !matches.error ? (
                        <Empty compact title="还没有可用的本人资源">
                          先录入资料并完成本人分享核验，或切换到第三方采集开始创作。
                          <Button quiet onClick={() => navigate("intake")}>
                            前往录入资源
                          </Button>
                        </Empty>
                      ) : null}
                    </TabPanel>
                    <TabPanel value="sources" keepMounted>
                      <Sources
                        workspace={data!.dataPath}
                        selected={form.value.sourceIds}
                        onSelection={(sourceIds) => form.update({ sourceIds })}
                        onInspect={setInspecting}
                      />
                    </TabPanel>
                  </Tabs>
                  <div className="jianshu-actions jianshu-new-actions">
                    <Button
                      primary
                      disabled={pending || !hasInput}
                      onClick={() => void create()}
                    >
                      {pending ? "正在建立文章…" : "使用所选内容创作"}
                    </Button>
                    <Button
                      quiet
                      disabled={pending}
                      onClick={() => void create(true)}
                    >
                      空白文章
                    </Button>
                  </div>
                </Panel>
              ) : form.value.selected ? (
                <>
                  <QueryError
                    error={localServiceError(detail.error)}
                    loading={detail.loading}
                    onRetry={detail.reload}
                  />
                  {!currentArticle && !detail.error ? (
                    <LoadingState label="正在打开简书文章…" />
                  ) : null}
                  {currentArticle ? (
                    <ArticleEditor
                      key={form.value.selected}
                      initial={currentArticle}
                      workspace={data!.dataPath}
                      accounts={accounts.data ?? []}
                      onAccountVerified={accountVerified}
                      onChanged={changed}
                    />
                  ) : null}
                </>
              ) : history.data ? (
                <Panel className="jianshu-no-selection">
                  <Empty title="选择一篇文章继续">
                    从左侧打开已有稿件，或点击「新建文章」。
                  </Empty>
                </Panel>
              ) : null}
            </section>
          </div>
        </TabPanel>
        <TabPanel value="records" keepMounted>
          <QueryError
            error={localServiceError(history.error)}
            loading={history.loading}
            onRetry={history.reload}
          />
          {!history.data && !history.error ? (
            <LoadingState label="正在读取简书文章记录…" />
          ) : history.data ? (
            <Records
              rows={history.data}
              accounts={accounts.data ?? []}
              open={open}
            />
          ) : null}
        </TabPanel>
      </Tabs>
      {inspecting ? (
        <Dialog title="来源素材" onClose={() => setInspecting(null)}>
          <div className="jianshu-source-detail">
            <h3>{inspecting.title}</h3>
            <small className="muted">
              {inspecting.sourceName}
              {inspecting.author ? ` · ${inspecting.author}` : null}
              {inspecting.publishedAt ? (
                <>
                  {" · "}
                  <time dateTime={inspecting.publishedAt}>
                    {formatTime(inspecting.publishedAt)}
                  </time>
                </>
              ) : null}
            </small>
            <p className="jianshu-source-body">{inspecting.body}</p>
            {inspecting.provider === "tieba" &&
            (inspecting.images.length || inspecting.externalShares.length) ? (
              <dl className="jianshu-source-references">
                {inspecting.images.length ? (
                  <div>
                    <dt>原帖图片引用</dt>
                    <dd>{inspecting.images.length} 张，可在原帖查看</dd>
                  </div>
                ) : null}
                {inspecting.externalShares.length ? (
                  <div>
                    <dt>外部分享线索</dt>
                    <dd>
                      <ul>
                        {inspecting.externalShares.map(({ url }) => (
                          <li key={url}>
                            {collectionDriveLabels[collectionDriveType(url)]}
                            <span className="muted">{url}</span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {inspecting.warnings.map((warning, i) => (
              <Notice key={i}>{warning}</Notice>
            ))}
            <Button
              onClick={() =>
                void ipc("system.external", { url: inspecting.url })
              }
            >
              查看原文
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
