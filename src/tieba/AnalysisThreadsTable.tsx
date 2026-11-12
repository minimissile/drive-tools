import { ArrowUpRight } from "lucide-react";
import type { TiebaAnalysisThread } from "../../shared/tieba-analysis";
import { useAppActions } from "../state";
import { Button } from "../ui/primitives";

const number = new Intl.NumberFormat("zh-CN");
const date = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export const formatAnalysisCount = (value: number | null | undefined) =>
  value == null ? "未知" : number.format(value);

export const formatAnalysisTime = (value: string | number) =>
  date.format(new Date(value));

export function AnalysisThreadsTable({
  threads,
  scope,
}: {
  threads: readonly (TiebaAnalysisThread & { author?: string })[];
  scope: "user" | "forum";
}) {
  const { command } = useAppActions();
  return (
    <div className="table-scroll">
      <table
        className="tieba-analysis-table"
        aria-label={scope === "forum" ? "吧内公开主题帖数据" : "公开主题帖数据"}
      >
        <thead>
          <tr>
            <th scope="col">主题帖</th>
            <th scope="col">{scope === "forum" ? "作者" : "贴吧"}</th>
            <th scope="col">发布时间（北京时间）</th>
            <th scope="col">浏览量</th>
            {scope === "user" ? <th scope="col">潜力值</th> : null}
            <th scope="col">回复</th>
            <th scope="col">获赞</th>
            <th scope="col">分享数</th>
          </tr>
        </thead>
        <tbody>
          {threads.map((post) => (
            <tr key={post.id}>
              <td>
                <Button
                  quiet
                  size="compact"
                  className="tieba-analysis-link"
                  onClick={() =>
                    void command("system.external", { url: post.url })
                  }
                >
                  <span>{post.title}</span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Button>
              </td>
              <td>
                {(scope === "forum" ? post.author : post.forum) || "未知"}
                {scope === "user" ? (
                  <small className="muted">
                    {post.forumLevel
                      ? `吧内 Lv.${post.forumLevel}`
                      : "吧内等级未知"}
                  </small>
                ) : null}
              </td>
              <td>
                {post.publishedAt ? (
                  <time dateTime={post.publishedAt}>
                    {formatAnalysisTime(post.publishedAt)}
                  </time>
                ) : (
                  "未知"
                )}
              </td>
              <td>
                <strong>{formatAnalysisCount(post.views)}</strong>
              </td>
              {scope === "user" ? (
                <td>
                  {post.potential ? (
                    <>
                      <strong>{post.potential.score}</strong>
                      <small className="muted">
                        {post.potential.place} / {post.potential.sample}
                      </small>
                    </>
                  ) : (
                    "暂无评分"
                  )}
                </td>
              ) : null}
              <td>{formatAnalysisCount(post.replies)}</td>
              <td>{formatAnalysisCount(post.likes)}</td>
              <td>{formatAnalysisCount(post.shares)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
