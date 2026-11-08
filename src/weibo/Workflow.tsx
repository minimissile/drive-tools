import { AiIcon } from "../ui/AiIcon";
import { useEffect, useRef, useState } from "react";

import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import { Button, Notice, Panel, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import DraftEditor from "../studio/DraftEditor";
import { Cover } from "../resources/components";
import {
  weiboPostText,
  weiboStageLabels,
  type WeiboMarketingDetail,
} from "../../shared/weibo-marketing";
import { formatTime } from "../lib/format";
import { WeiboDelivery, WeiboReceipt } from "./Delivery";
import { WeiboStatistics } from "./Statistics";
import "../studio/studio.css";
import "./weibo.css";

export function WeiboTask({ detail }: { detail: WeiboMarketingDetail }) {
  const { run, draft } = detail;
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity(),
    { navigate } = useAppNavigation();
  const locked = [
    "filled",
    "submitting",
    "uncertain",
    "handoff",
    "submitted",
    "published",
  ].includes(run.stage);
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
                <AiIcon size={15} />
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
              continueLabel="准备发布"
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
      {run.url && (run.options?.accountId || run.prepared?.accountId) ? (
        <Panel title="微博数据统计">
          <WeiboStatistics
            accountId={(run.options?.accountId || run.prepared?.accountId)!}
            url={run.url}
          />
        </Panel>
      ) : null}
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
