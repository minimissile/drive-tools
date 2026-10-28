import { useState } from "react";
import { Header } from "../ui/primitives";
import { useAppData } from "../state";
import { WeiboComposer } from "../accounts/WeiboComposer";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import { PipixSources } from "./PipixSources";

export default function PipixWorkflow() {
  const { data } = useAppData();
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
      <PipixSources
        workspace={data!.dataPath}
        onOpenWeibo={(account, postId) => setComposer({ account, postId })}
      />
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
