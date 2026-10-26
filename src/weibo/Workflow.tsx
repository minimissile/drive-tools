import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Plus, Sparkles } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import {
  Button,
  Empty,
  Header,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import DraftEditor from "../studio/DraftEditor";
import { Cover } from "../resources/components";
import {
  weiboPostText,
  weiboStageLabels,
  type WeiboMarketingDetail,
} from "../../shared/weibo-marketing";
import { formatTime } from "../lib/format";
import { WeiboSetup } from "./Setup";
import { WeiboDelivery, WeiboReceipt } from "./Delivery";
import "../studio/studio.css";
import "./weibo.css";

export default function WeiboWorkflow() {
  const { data } = useAppData(),
    { busy } = useAppActivity();
  const { navigate } = useAppNavigation();
  const selection = useLocalDraft(
    `panxu-weibo-selection-v1:${data!.dataPath}`,
    { id: "" },
    (raw) => z.object({ id: z.string() }).parse(raw),
  );
  const runId = selection.value.id;
  const history = useIpcQuery("weibo.history", undefined, {
    revision: busy,
    keepPrevious: true,
  });
  const detail = useIpcQuery(
    "weibo.get",
    { id: runId },
    {
      enabled: !!runId,
      revision: busy,
      invalidate: data?.drafts,
      keepPrevious: true,
      refreshInterval: busy > 0 ? 2000 : 0,
    },
  );
  const [historyPage, setHistoryPage] = useState(1);
  const page = Math.min(
    historyPage,
    Math.max(1, Math.ceil((history.data?.length ?? 0) / 6)),
  );
  const open = (id: string) => selection.update({ id });
  // Previous data may be retained while refreshing, but must never display another task after selection changes.
  const selected = detail.data?.run.id === runId ? detail.data : null;
  return (
    <div className="weibo-workflow">
      <Header
        title="微博图文营销"
        description="从本人资料出发，准备推荐图文，在指定窗口发布，再把微博链接与资料效果关联。"
        action={
          <div className="row">
            <Button onClick={() => navigate("website-accounts")}>
              管理微博账号
            </Button>
            {runId ? (
              <Button onClick={() => open("")}>
                <Plus size={15} />
                新建图文任务
              </Button>
            ) : null}
          </div>
        }
      />
      {selection.error ? <Notice warning>{selection.error}</Notice> : null}
      <div className="weibo-workflow-layout">
        <section className="weibo-workflow-main" aria-label="微博图文工作区">
          {!runId ? (
            <WeiboSetup onCreated={open} />
          ) : (
            <>
              <QueryError
                error={detail.error}
                loading={detail.loading}
                onRetry={detail.reload}
                title="微博任务读取失败"
              />
              {!selected && detail.loading ? (
                <LoadingState label="正在读取微博图文任务…" />
              ) : null}
              {selected ? (
                <WeiboTask key={selected.run.id} detail={selected} />
              ) : null}
            </>
          )}
        </section>
        <aside className="weibo-workflow-aside" aria-label="微博任务历史">
          <Panel
            title="图文任务"
            extra={
              <Button
                quiet
                size="compact"
                disabled={history.loading}
                onClick={history.reload}
              >
                刷新
              </Button>
            }
          >
            <QueryError
              error={history.error}
              loading={history.loading}
              onRetry={history.reload}
            />
            {!history.data && history.loading ? (
              <LoadingState compact label="正在读取图文任务…" />
            ) : history.data?.length ? (
              <>
                <div className="weibo-task-list">
                  {history.data.slice((page - 1) * 6, page * 6).map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      aria-current={run.id === runId ? "true" : undefined}
                      onClick={() => open(run.id)}
                    >
                      <strong>{run.input.keyword}</strong>
                      <span>{weiboStageLabels[run.stage]}</span>
                      <small>{formatTime(run.updatedAt)}</small>
                    </button>
                  ))}
                </div>
                {history.data.length > 6 ? (
                  <Pagination
                    page={page}
                    pageSize={6}
                    total={history.data.length}
                    onPageChange={setHistoryPage}
                    label="微博任务分页"
                  />
                ) : null}
              </>
            ) : history.data && !history.error ? (
              <Empty compact title="还没有微博任务">
                从左侧选题和本人资料开始。
              </Empty>
            ) : null}
          </Panel>
          <div className="weibo-process-note">
            <strong>资料 → 图文 → 发布 → 复盘</strong>
            <p>
              网盘转存与建链沿用原流程。这里负责资源推荐图文、发布交接和回执。
            </p>
            <p>自动填写并上传后确认发布，官方回执会自动保存；安全验证和异常结果可在窗口核对。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function WeiboTask({ detail }: { detail: WeiboMarketingDetail }) {
  const { run, draft } = detail;
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity(),
    { navigate } = useAppNavigation();
  const locked = ["filled", "submitting", "uncertain", "handoff", "submitted", "published"].includes(run.stage);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const coverId = detail.coverId;
  const [artwork, setArtwork] = useState<"cover" | "creative">(
    run.options?.artwork ?? (detail.hasCover ? "cover" : "creative"),
  );
  const generated = async () => {
    await command("weibo.generate", { id: run.id, artwork });
  };
  const attach = (draftId: string) => {
    if (alive.current)
      void command("weibo.attachDraft", { id: run.id, draftId });
  };
  return (
    <>
      <Panel
        title={run.input.keyword}
        extra={
          <Status
            kind={
              run.receiptSyncPending
                ? "warning"
                : run.stage === "published"
                  ? "good"
                  : ["attention", "uncertain", "handoff"].includes(run.stage)
                    ? "warning"
                    : "normal"
            }
          >
            {weiboStageLabels[run.stage]}
          </Status>
        }
      >
        <div className="weibo-resource-summary">
          {coverId ? <Cover id={coverId} title={detail.resourceTitle} /> : null}
          <div>
            <strong>{detail.resourceTitle}</strong>
            <p>
              {run.input.audience
                ? `面向：${run.input.audience}`
                : "按实际资料用途推荐"}
            </p>
            <small>
              {run.source.source}
              {run.source.observedAt
                ? ` · ${formatTime(run.source.observedAt)}`
                : ""}
            </small>
          </div>
        </div>
        {run.receiptSyncPending || run.stage === "attention" ? (
          <Notice warning>{run.message}</Notice>
        ) : (
          <p className="weibo-task-message" role="status">
            {run.message}
          </p>
        )}
        <details className="weibo-facts">
          <summary>查看资源依据与选词记录</summary>
          <p>{run.input.evidence}</p>
          <small>
            匹配来自资料标题、摘要、标签和文件名，未自动阅读网盘文件正文。微博搜索热度未提供。
          </small>
          {Object.keys(run.source.metrics).length ? (
            <pre>{JSON.stringify(run.source.metrics, null, 2)}</pre>
          ) : null}
        </details>
      </Panel>
      <Panel
        title="文案与配图"
        extra={
          <small>
            已保存 v{draft.version} · {draft.reviewed ? "已审阅" : "待审阅"}
          </small>
        }
      >
        {!locked ? (
          <>
            <div className="weibo-creation-toolbar">
              <Select
                aria-label="微博生成方式"
                value={artwork}
                disabled={busy > 0}
                items={[
                  { value: "cover", label: "生成文案，配资源封面" },
                  { value: "creative", label: "生成文案与 AI 单图方案" },
                ]}
                onValueChange={(value) =>
                  setArtwork(value as "cover" | "creative")
                }
              />
              <Button
                disabled={busy > 0 || !data!.settings.openrouterConfigured}
                onClick={() => void generated()}
              >
                <Sparkles size={15} />
                生成推荐图文方案
              </Button>
              <Select
                aria-label="微博稿件版本"
                value={draft.id}
                disabled={busy > 0}
                items={detail.versions.map((item) => ({
                  value: item.id,
                  label: `${item.title} · v${item.version}`,
                }))}
                onValueChange={attach}
              />
            </div>
            {!data!.settings.openrouterConfigured ? (
              <p className="muted">
                尚未配置
                AI，可直接手工编辑并使用资源封面；需要生成时到连接与设置配置。
              </p>
            ) : null}
            <p className="muted">
              生成 AI
              配图方案后，还需在编辑器中生成实际图片。已有内容会保留为历史版本。
            </p>
            <DraftEditor
              key={draft.id}
              draft={draft}
              onSaved={attach}
              continueLabel="准备微博图文包"
              onContinue={() =>
                document
                  .getElementById("weibo-delivery")
                  ?.scrollIntoView({ block: "start", behavior: "instant" })
              }
            />
          </>
        ) : (
          <>
            <div className="weibo-post-preview">
              {run.prepared?.text ?? weiboPostText(draft)}
            </div>
            <p className="muted">
              这份图文已交接，先在下方登记结果。确认尚未发布后，可返回修改。
            </p>
          </>
        )}
      </Panel>
      <div id="weibo-delivery" tabIndex={-1}>
        <WeiboDelivery detail={detail} />
      </div>
      <WeiboReceipt detail={detail} />
      <details className="weibo-events">
        <summary>任务记录 · {run.events.length} 项</summary>
        <ol>
          {[...run.events].reverse().map((event, index) => (
            <li key={`${event.at}:${index}`}>
              <time>{formatTime(event.at)}</time>
              <span>{event.message}</span>
            </li>
          ))}
        </ol>
      </details>
      <Button quiet onClick={() => navigate("library")}>
        回到资源库维护资料与封面
      </Button>
    </>
  );
}
