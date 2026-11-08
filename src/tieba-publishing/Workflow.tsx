import { z } from "zod";
import { ArrowRight, Plus } from "lucide-react";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import {
  Button,
  Empty,
  Header,
  LoadingState,
  Panel,
  Notice,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { formatTime } from "../lib/format";
import { PublishingEditor } from "./PublishingEditor";
import { PostStatistics } from "./PostStatistics";
import { publishingBackendPending, publishingStatus } from "./view";
import "./publishing.css";

export default function TiebaPublishingWorkflow() {
  const { data } = useAppData();
  const { command } = useAppActions();
  const { navigate } = useAppNavigation();
  const selection = useLocalDraft(
    `panxu-tieba-publishing-selection-v1:${data!.dataPath}`,
    { id: "", tab: "compose" as "compose" | "statistics", newKey: "initial" },
    (value) =>
      z
        .object({
          id: z.string(),
          tab: z.enum(["compose", "statistics"]),
          newKey: z.string().default("initial"),
        })
        .parse(value),
  );
  const snapshot = useIpcQuery("tieba.publishing.snapshot", undefined, {
    keepPrevious: true,
  });
  const current = snapshot.data?.drafts.find(
    (draft) => draft.id === selection.value.id,
  );
  const unavailable = !!selection.value.id && !!snapshot.data && !current;
  const newDraft = () =>
    selection.update({ id: "", newKey: crypto.randomUUID() });
  return (
    <div className="tieba-publishing">
      <Header
        title="贴吧资源发帖"
        description="选流量词与网盘资料，审阅后发布到指定贴吧，并核对帖子数据。"
        action={
          <Button quiet onClick={() => navigate("tieba-autocare")}>
            贴吧养号 <ArrowRight size={14} />
          </Button>
        }
      />
      <Tabs
        className="tieba-publishing-tabs"
        value={selection.value.tab}
        onChange={(tab) => selection.update({ tab })}
      >
        <TabList
          label="贴吧资源发帖工作区"
          items={[
            ["compose", "资源发帖"],
            ["statistics", "帖子统计"],
          ]}
        />
        <TabPanel value="compose" keepMounted>
          {publishingBackendPending(snapshot.error) ? (
            <Notice warning>
              贴吧资源发帖等待后端更新。请点击顶部“应用更新并重启”，完成后重试读取。
              <Button quiet size="compact" onClick={snapshot.reload}>
                重试读取
              </Button>
            </Notice>
          ) : (
            <QueryError
              error={snapshot.error}
              loading={snapshot.loading}
              onRetry={snapshot.reload}
            />
          )}
          {!snapshot.data && !snapshot.error ? (
            <LoadingState label="正在读取贴吧发帖工作区…" />
          ) : snapshot.data ? (
            <div className="tieba-publishing-layout">
              <div className="tieba-publishing-main">
                {unavailable ? (
                  <Empty
                    title="原稿件已不在当前空间"
                    action={<Button onClick={newDraft}>新建稿件</Button>}
                  >
                    没有切换到其他稿件，请选择历史记录或新建。
                  </Empty>
                ) : (
                  <PublishingEditor
                    key={`${data!.dataPath}:${current?.id ?? `new-${selection.value.newKey}`}`}
                    formKey={current?.id ?? `new-${selection.value.newKey}`}
                    draft={current}
                    snapshot={snapshot.data}
                    command={command}
                    onSaved={(value) => {
                      snapshot.setData(value);
                      if (value.savedDraftId)
                        selection.update({ id: value.savedDraftId });
                    }}
                    onDirectoryChange={snapshot.reload}
                    onNewDraft={newDraft}
                  />
                )}
              </div>
              <aside className="tieba-publishing-history">
                <Panel
                  title="发帖记录"
                  extra={
                    <Button size="compact" onClick={newDraft}>
                      <Plus size={14} />
                      新建
                    </Button>
                  }
                >
                  {snapshot.data.drafts.length ? (
                    <div
                      className="tieba-publishing-draft-list"
                      aria-label="资源发帖记录"
                    >
                      {snapshot.data.drafts.map((draft) => (
                        <button
                          type="button"
                          key={draft.id}
                          aria-current={
                            current?.id === draft.id ? "true" : undefined
                          }
                          onClick={() => selection.update({ id: draft.id })}
                        >
                          <strong>
                            {draft.title || draft.keyword || "未命名稿件"}
                          </strong>
                          <span>
                            {draft.forumName} · {formatTime(draft.updatedAt)}
                          </span>
                          <Status kind={publishingStatus(draft.status).kind}>
                            {publishingStatus(draft.status).label}
                          </Status>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty compact title="还没有资源帖子">
                      先选择流量词、资源和目标贴吧，准备第一篇资源帖子。
                    </Empty>
                  )}
                </Panel>
              </aside>
            </div>
          ) : null}
        </TabPanel>
        <TabPanel value="statistics" keepMounted>
          <PostStatistics />
        </TabPanel>
      </Tabs>
    </div>
  );
}
