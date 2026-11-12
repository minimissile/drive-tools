import { useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
} from "lucide-react";
import { z } from "zod";
import type {
  TiebaAnalysisPage,
  TiebaAnalysisThread,
} from "../../shared/tieba-analysis";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import { Pagination } from "../ui/Pagination";
import { Button, Empty } from "../ui/primitives";
import {
  formatForumExposure,
  TiebaPotentialFormula,
} from "./TiebaPotentialFormula";
import {
  forumPerformanceMetrics,
  forumPerformanceRows,
  type ForumPerformanceOrder,
} from "./forum-performance";

const pageSize = 12;
const count = new Intl.NumberFormat("zh-CN");
const average = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const orderSchema = z.object({
  metric: z.enum(forumPerformanceMetrics),
  direction: z.enum(["asc", "desc"]),
});
const metricLabels = {
  posts: "发帖数",
  views: "总浏览量",
  average: "篇均浏览量",
  exposure: "曝光潜力",
};

export function ForumPerformance({
  workspace,
  threads,
  forums,
  loadMore,
}: {
  workspace: string;
  threads: readonly TiebaAnalysisThread[];
  forums?: TiebaAnalysisPage["forums"];
  loadMore: ReactNode;
}) {
  const { command } = useAppActions();
  const order = useLocalDraft<ForumPerformanceOrder>(
    `tieba-analysis-forum-order:${workspace}`,
    { metric: "views", direction: "desc" },
    orderSchema.parse,
  );
  const [page, setPage] = useState(1);
  const rows = forumPerformanceRows(threads, order.value, forums);
  const displayPage = Math.min(
    page,
    Math.max(1, Math.ceil(rows.length / pageSize)),
  );
  const hasMissingViews = rows.some((row) => row.measured < row.posts);

  if (!rows.length)
    return <Empty icon={BarChart3} title="暂无可统计的公开主题帖" compact />;

  return (
    <>
      <div className="tieba-analysis-toolbar">
        <small className="muted">
          已读取 {count.format(threads.length)} 篇帖子，涉及{" "}
          {count.format(rows.length)} 个贴吧
        </small>
        {loadMore}
      </div>
      {hasMissingViews ? (
        <p className="muted tieba-performance-note">
          浏览量缺失的帖子计入发帖数。总浏览量和篇均浏览量按有浏览量的帖子计算。
        </p>
      ) : null}
      <TiebaPotentialFormula />
      <div className="table-scroll">
        <table
          className="tieba-performance-table"
          aria-label="按贴吧统计发帖表现"
        >
          <thead>
            <tr>
              <th scope="col">贴吧</th>
              <th scope="col">吧内等级</th>
              {forumPerformanceMetrics.map((metric) => {
                const selected = order.value.metric === metric;
                const ascending = order.value.direction === "asc";
                const Icon = selected
                  ? ascending
                    ? ArrowUp
                    : ArrowDown
                  : ArrowDownUp;
                return (
                  <th
                    key={metric}
                    scope="col"
                    aria-sort={
                      selected
                        ? ascending
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <Button
                      quiet
                      size="compact"
                      onClick={() => {
                        order.update({
                          metric,
                          direction: selected && !ascending ? "asc" : "desc",
                        });
                        setPage(1);
                      }}
                    >
                      {metricLabels[metric]}
                      <Icon size={13} aria-hidden="true" />
                    </Button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows
              .slice((displayPage - 1) * pageSize, displayPage * pageSize)
              .map((row) => {
                const url = row.url;
                return (
                  <tr key={row.key}>
                    <td>
                      {url ? (
                        <Button
                          quiet
                          size="compact"
                          className="tieba-analysis-link"
                          onClick={() =>
                            void command("system.external", { url })
                          }
                        >
                          <span>{row.name}</span>
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </Button>
                      ) : (
                        row.name
                      )}
                    </td>
                    <td>{row.level ? `Lv.${row.level}` : "未知"}</td>
                    <td>{count.format(row.posts)}</td>
                    <td>
                      <strong>
                        {row.views === null ? "未知" : count.format(row.views)}
                      </strong>
                      {row.measured > 0 && row.measured < row.posts ? (
                        <small className="muted">
                          已知 {row.measured}/{row.posts} 篇
                        </small>
                      ) : null}
                    </td>
                    <td>
                      {row.average === null
                        ? "未知"
                        : average.format(row.average)}
                    </td>
                    <td>
                      <strong>{formatForumExposure(row.exposure)}</strong>
                      {row.exposure ? (
                        <small className="muted">
                          {row.exposure.sample} 篇样本
                        </small>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <Pagination
        page={displayPage}
        pageSize={pageSize}
        total={rows.length}
        onPageChange={setPage}
        label="贴吧表现分页"
      />
    </>
  );
}
