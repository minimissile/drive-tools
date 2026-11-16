import { useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import type { TiebaAnalysisThread } from "../../shared/tieba-analysis";
import type { TiebaDiscoveryImportKind } from "../../shared/tieba-resource-discovery";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import { useFeedbackActions } from "../state/feedback";
import { Button } from "../ui/primitives";
import { PostExposureCell } from "./PostExposureCell";

const number = new Intl.NumberFormat("zh-CN");
const dailyRate = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
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
const archiveLabels: Record<TiebaDiscoveryImportKind, string> = {
  traffic: "流量帖",
  potential: "潜力帖",
  pending: "待观察",
  oldTraffic: "流量帖",
  growthWatch: "待测近期增长",
};

export const formatAnalysisCount = (value: number | null | undefined) =>
  value == null ? "未知" : number.format(value);

export const formatAnalysisTime = (value: string | number) =>
  date.format(new Date(value));

export function AnalysisThreadsTable({
  threads,
  scope,
  observedAt,
  onFindAuthor,
}: {
  threads: readonly (TiebaAnalysisThread & { author?: string })[];
  observedAt: number;
} & ({ scope: "user"; onFindAuthor?: never } | { scope: "forum"; onFindAuthor(target: string): void })) {
  const { command } = useAppActions();
  const { notify } = useFeedbackActions();
  const [importing, setImporting] = useState<string>();
  const [archived, setArchived] = useState<Record<string, TiebaDiscoveryImportKind>>({});
  const lock = useRef(false);

  async function importPost(id: string) {
    if (lock.current) return;
    lock.current = true;
    setImporting(id);
    try {
      const { kind, already, measuredDailyGrowth } = await ipc("tieba.discovery.import", { id });
      if (kind === "growthWatch") {
        notify(measuredDailyGrowth === undefined
          ? "已记录读数，至少 30 分钟后可复查近期增长。"
          : `实测新增 ${dailyRate.format(measuredDailyGrowth)} 次/天，暂未达到门槛，已保留读数。`, "info");
        return;
      }
      setArchived((previous) => ({ ...previous, [id]: kind }));
      notify(already ? `已在「${archiveLabels[kind]}」列表中` : `已入库 · ${archiveLabels[kind]}`, already ? "info" : "success");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "入库失败，请重试。";
      notify(
        /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
          ? "请在顶部点击「应用更新并重启」，然后重试入库。"
          : message,
        "error",
      );
    } finally {
      lock.current = false;
      setImporting(undefined);
    }
  }

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
            <th scope="col">曝光潜力</th>
            <th scope="col">回复</th>
            <th scope="col">获赞</th>
            <th scope="col">分享数</th>
            <th scope="col">操作</th>
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
                {scope === "forum" && (post.author || post.authorId) ? (
                  <Button
                    quiet
                    size="compact"
                    className="tieba-analysis-link"
                    onClick={() => onFindAuthor(post.authorId ? `UID: ${post.authorId}` : post.url)}
                  >
                    <span>{post.author || `UID ${post.authorId}`}</span>
                  </Button>
                ) : (scope === "forum" ? post.author : post.forum) || "未知"}
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
              <PostExposureCell
                views={post.views}
                publishedAt={post.publishedAt}
                observedAt={observedAt}
                unit={scope === "forum" ? "day" : "hour"}
              />
              <td>{formatAnalysisCount(post.replies)}</td>
              <td>{formatAnalysisCount(post.likes)}</td>
              <td>{formatAnalysisCount(post.shares)}</td>
              <td className="tieba-analysis-operation">
                {archived[post.id] ? (
                  <span className="muted">{archiveLabels[archived[post.id]]}</span>
                ) : (
                  <Button
                    size="compact"
                    disabled={importing !== undefined}
                    aria-label={importing === post.id ? "正在入库" : `入库 ${post.title}`}
                    onClick={() => void importPost(post.id)}
                  >
                    {importing === post.id ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}
                    入库
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
