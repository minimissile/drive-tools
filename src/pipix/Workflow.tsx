import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Header } from "../ui/primitives";
import { useAppActions, useAppData } from "../state";
import { ipc } from "../api/client";
import { WeiboComposer } from "../accounts/WeiboComposer";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import { PipixSources } from "./PipixSources";
import { ContentSupplyWorkflow } from "../content-supply/Workflow";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import "./pipix.css";

export default function PipixWorkflow() {
  const { data } = useAppData();
  const { notify } = useAppActions();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const navSchema = z.object({
    tab: z
      .enum(["candidates", "queue", "logs", "discovery"])
      .default("candidates"),
  });
  const nav = useLocalDraft(
    `pipix-workspace-v2:${data!.dataPath}`,
    navSchema.parse({}),
    (value) => navSchema.parse(value),
  );
  const tab = nav.value.tab;
  const [composer, setComposer] = useState<{
    account: WebsiteAccountView;
    postId: string;
  } | null>(null);
  return (
    <div className="pipix-workflow">
      <Header
        title="皮皮虾采集"
        description="采集一次，按需送入不同渠道。原帖、图片与评论保存在当前工作空间，渠道草稿分别编辑。"
      />
      <Tabs value={tab} onChange={(tab) => nav.update({ tab })}>
        <TabList
          label="皮皮虾工作区"
          items={[
            ["candidates", "供稿候选"],
            ["queue", "编辑队列"],
            ["logs", "供稿日志"],
            ["discovery", "发现与采集"],
          ]}
        />
        <TabPanel value={tab}>
          {tab !== "discovery" ? (
            <ContentSupplyWorkflow
              workspace={data!.dataPath}
              tab={tab}
              onTabChange={(tab) => nav.update({ tab })}
              onOpenWeibo={async (accountId, postId) => {
                try {
                  const accounts = await ipc("websiteAccounts.list");
                  const account = accounts.find(
                    (a) => a.id === accountId && a.provider === "weibo",
                  );
                  if (!account)
                    throw new Error("原稿账号已不存在，请在账号管理中检查。");
                  if (alive.current) setComposer({ account, postId });
                } catch (error) {
                  notify(
                    error instanceof Error ? error.message : "暂时无法打开原稿",
                    "error",
                  );
                }
              }}
            />
          ) : (
            <PipixSources
              workspace={data!.dataPath}
              onOpenWeibo={(account, postId) =>
                setComposer({ account, postId })
              }
            />
          )}
        </TabPanel>
      </Tabs>
      {composer ? (
        <WeiboComposer
          key={composer.postId}
          account={{
            ...composer.account,
            key: `website:${composer.account.id}`,
          }}
          initialPostId={composer.postId}
          onClose={() => setComposer(null)}
        />
      ) : null}
    </div>
  );
}
