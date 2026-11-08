import { z } from "zod";
import type { TiebaInsightsSnapshot } from "../../shared/tieba-insights";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { updateSelection } from "../lib/selection";
import { Button, Empty, LoadingState, Panel, Status } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { tiebaBackendError, useTiebaAction } from "./useTiebaAction";
import { tiebaTime } from "./view-model";
import {
  tiebaVisibilityLabel,
  tiebaVisibilityKind,
  tiebaSignedDelta,
  tiebaInsightsRefreshFeedback,
} from "./console-view";

export function TiebaInsights({
  workspace,
  refreshRevision = 0,
}: {
  workspace: string;
  refreshRevision?: number;
}) {
  const view = useLocalDraft(
    `tieba-insights-view:${workspace}`,
    {
      expanded: false,
      tab: "metrics" as "metrics" | "publications" | "recommendations",
      page: 1,
      targetIds: [] as string[],
      publicationIds: [] as string[],
    },
    (value) =>
      z
        .object({
          expanded: z.boolean(),
          tab: z.enum(["metrics", "publications", "recommendations"]),
          page: z.number().int().positive(),
          targetIds: z.array(z.string()).max(5),
          publicationIds: z.array(z.string()).max(5),
        })
        .parse(value),
  );
  const query = useIpcQuery("tieba.insights.snapshot", undefined, {
    enabled: view.value.expanded,
    keepPrevious: true,
    refreshInterval: 5000,
    invalidate: refreshRevision,
  });
  const automation = useIpcQuery("tieba.automation.snapshot", undefined, {
    enabled: view.value.expanded && view.value.tab === "recommendations",
    keepPrevious: true,
  });
  const action = useTiebaAction<TiebaInsightsSnapshot>(
    query.setData,
    query.reload,
  );
  const s = query.data,
    disabled = action.busy || !!s?.busy || !!query.error;
  const targets = s?.targets ?? [],
    publications = s?.publications ?? [];
  const ids =
    view.value.tab === "metrics"
      ? view.value.targetIds.filter((id) =>
          targets.some((target) => target.targetId === id),
        )
      : view.value.publicationIds.filter((id) =>
          publications.some((item) => item.id === id),
        );
  const records = view.value.tab === "metrics" ? targets : publications;
  const page = Math.min(
    view.value.page,
    Math.max(1, Math.ceil(records.length / 5)),
  );
  const refresh = () =>
    action.run(
      () =>
        ipc(
          "tieba.insights.refresh",
          view.value.tab === "metrics"
            ? { targetIds: ids }
            : { publicationIds: ids },
        ),
      tiebaInsightsRefreshFeedback,
    );
  return (
    <Panel
      title="运营复盘"
      className="tieba-console-panel"
      data-testid="tieba-insights"
      extra={
        <Button
          quiet
          size="compact"
          aria-expanded={view.value.expanded}
          onClick={() => view.update({ expanded: !view.value.expanded })}
          data-testid="tieba-insights-expand"
        >
          {view.value.expanded ? "收起" : "展开复盘"}
        </Button>
      }
    >
      {!view.value.expanded ? (
        <p className="tieba-console-description">
          查看官网等级、经验历史和发布可见性；策略建议保存为草稿预设。
        </p>
      ) : (
        <div className="tieba-console-content">
          <QueryError
            error={tiebaBackendError(action.error || query.error)}
            loading={query.loading}
            onRetry={() => {
              action.clearError();
              query.reload();
            }}
          />
          {!s && !query.error ? (
            <LoadingState label="正在读取本地复盘记录…" />
          ) : null}
          {s ? (
            <>
              <div className="tieba-console-toolbar">
                <Select
                  aria-label="复盘内容"
                  value={view.value.tab}
                  items={[
                    { value: "metrics", label: "等级与经验" },
                    { value: "publications", label: "发布可见性" },
                    { value: "recommendations", label: "策略建议" },
                  ]}
                  onValueChange={(tab) =>
                    view.update({ tab: tab as typeof view.value.tab, page: 1 })
                  }
                />
                {view.value.tab !== "recommendations" ? (
                  <>
                    <Button
                      disabled={disabled || !records.length}
                      data-testid="tieba-insights-select-first"
                      onClick={() =>
                        view.update(
                          view.value.tab === "metrics"
                            ? {
                                targetIds: targets
                                  .slice(0, 5)
                                  .map((target) => target.targetId),
                              }
                            : {
                                publicationIds: publications
                                  .slice(0, 5)
                                  .map((item) => item.id),
                              },
                        )
                      }
                    >
                      选择前5
                      {view.value.tab === "metrics" ? "个目标" : "条记录"}
                    </Button>
                    <Button
                      disabled={disabled || !ids.length}
                      onClick={() => void refresh()}
                      data-testid="tieba-insights-refresh"
                    >
                      读取所选官网进度（{ids.length}/5）
                    </Button>
                  </>
                ) : null}
                <label className="tieba-console-switch">
                  延后复查可见性
                  <Switch
                    aria-label="延后复查发布可见性"
                    checked={s.settings.autoReview}
                    disabled={disabled}
                    onCheckedChange={(autoReview) =>
                      void action.run(
                        () =>
                          ipc("tieba.insights.save", {
                            revision: s.settings.revision,
                            autoReview,
                          }),
                        autoReview
                          ? "已开启发布后的官网只读复查"
                          : "已关闭自动复查，已有历史保留",
                      )
                    }
                  />
                </label>
              </div>
              <p className="tieba-console-description">
                {view.value.tab === "metrics"
                  ? "仅记录官网实际读到的等级与经验；差值来自同一目标的历史记录。"
                  : view.value.tab === "publications"
                    ? "提交回执和官网可见性分别记录。未找到结果会保留未知状态；开启延后复查后，发布10分钟后只读检查。"
                    : "应用预设仅调整自动回帖草稿模式与每日数量；开关、目标和发布授权需单独明确设置。"}
              </p>
              {view.value.tab === "metrics" ? (
                targets.length ? (
                  <>
                    <div className="table-scroll">
                      <table
                        className="tieba-insights-table"
                        aria-label="贴吧等级与经验历史"
                      >
                        <thead>
                          <tr>
                            <th>选择</th>
                            <th>目标贴吧</th>
                            <th>等级 / 变化</th>
                            <th>经验 / 变化</th>
                            <th>官网读取时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {targets
                            .slice((page - 1) * 5, page * 5)
                            .map((target) => (
                              <tr key={target.targetId}>
                                <td>
                                  <CheckboxField
                                    label=""
                                    aria-label={`刷新进度 ${target.name}吧`}
                                    checked={ids.includes(target.targetId)}
                                    disabled={
                                      disabled ||
                                      (ids.length >= 5 &&
                                        !ids.includes(target.targetId))
                                    }
                                    onChange={(event) =>
                                      view.update({
                                        targetIds: updateSelection(
                                          view.value.targetIds,
                                          [target.targetId],
                                          event.target.checked,
                                          5,
                                        ),
                                      })
                                    }
                                  />
                                </td>
                                <td>
                                  <strong>{target.name}吧</strong>
                                  <details className="tieba-insights-history">
                                    <summary>
                                      历史记录 · {target.history.length} 条
                                    </summary>
                                    {target.history.length ? (
                                      <table
                                        aria-label={`${target.name}吧历史进度`}
                                      >
                                        <thead>
                                          <tr>
                                            <th>读取时间</th>
                                            <th>等级</th>
                                            <th>经验</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {target.history.map((row, index) => (
                                            <tr
                                              key={`${row.checkedAt}:${index}`}
                                            >
                                              <td>
                                                {tiebaTime(row.checkedAt)}
                                              </td>
                                              <td>
                                                {row.level === null
                                                  ? "未知"
                                                  : `Lv.${row.level}`}
                                              </td>
                                              <td>
                                                {row.experience === null
                                                  ? "未知"
                                                  : row.experience.toLocaleString(
                                                      "zh-CN",
                                                    )}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    ) : (
                                      <p>尚无官网历史记录</p>
                                    )}
                                  </details>
                                </td>
                                <td>
                                  {target.level === null
                                    ? "待获取"
                                    : `Lv.${target.level}`}
                                  <small>
                                    {tiebaSignedDelta(target.deltaLevel)}
                                  </small>
                                </td>
                                <td>
                                  {target.experience === null
                                    ? "待获取"
                                    : target.experience.toLocaleString("zh-CN")}
                                  <small>
                                    {tiebaSignedDelta(target.deltaExperience)}
                                  </small>
                                </td>
                                <td>{tiebaTime(target.checkedAt)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    <Pagination
                      page={page}
                      pageSize={5}
                      total={targets.length}
                      onPageChange={(page) => view.update({ page })}
                      label="等级经验分页"
                    />
                  </>
                ) : (
                  <Empty compact title="暂无目标进度">
                    添加贴吧后，选择目标手动读取官网进度。
                  </Empty>
                )
              ) : null}
              {view.value.tab === "publications" ? (
                publications.length ? (
                  <>
                    <div className="table-scroll">
                      <table
                        className="tieba-publication-table"
                        aria-label="贴吧发布回执与可见性"
                      >
                        <thead>
                          <tr>
                            <th>选择</th>
                            <th>发布内容</th>
                            <th>提交回执</th>
                            <th>官网可见性</th>
                            <th>检查情况</th>
                          </tr>
                        </thead>
                        <tbody>
                          {publications
                            .slice((page - 1) * 5, page * 5)
                            .map((item) => (
                              <tr key={item.id}>
                                <td>
                                  <CheckboxField
                                    label=""
                                    aria-label={`复查可见性 ${item.title}`}
                                    checked={ids.includes(item.id)}
                                    disabled={
                                      disabled ||
                                      (ids.length >= 5 &&
                                        !ids.includes(item.id))
                                    }
                                    onChange={(event) =>
                                      view.update({
                                        publicationIds: updateSelection(
                                          view.value.publicationIds,
                                          [item.id],
                                          event.target.checked,
                                          5,
                                        ),
                                      })
                                    }
                                  />
                                </td>
                                <td>
                                  <strong>{item.title}</strong>
                                  <small>
                                    {item.forumName}吧 ·{" "}
                                    {item.kind === "reply" ? "回复" : "主题"}
                                  </small>
                                  {item.url ? (
                                    <Button
                                      quiet
                                      size="compact"
                                      onClick={() =>
                                        void ipc("system.copyText", {
                                          text: item.url!,
                                        })
                                      }
                                    >
                                      复制官网链接
                                    </Button>
                                  ) : null}
                                </td>
                                <td>
                                  {(
                                    {
                                      verified: "官网已核实",
                                      uncertain: "提交结果未知",
                                      submitting: "正在提交",
                                      published: "已提交",
                                      pending_review: "官网提示审核中",
                                    } as Record<string, string>
                                  )[item.submissionStatus] ??
                                    item.submissionStatus}
                                  <small>{tiebaTime(item.submittedAt)}</small>
                                </td>
                                <td>
                                  <Status
                                    kind={tiebaVisibilityKind(item.visibility)}
                                  >
                                    {tiebaVisibilityLabel(item.visibility)}
                                  </Status>
                                </td>
                                <td>
                                  {item.message}
                                  <small>
                                    检查：{tiebaTime(item.checkedAt)}
                                    {item.nextCheckAt
                                      ? ` · 下次 ${tiebaTime(item.nextCheckAt)}`
                                      : ""}
                                  </small>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    <Pagination
                      page={page}
                      pageSize={5}
                      total={publications.length}
                      onPageChange={(page) => view.update({ page })}
                      label="发布可见性分页"
                    />
                  </>
                ) : (
                  <Empty compact title="暂无发布复盘记录">
                    实际提交的回复与主题会保留原回执，再单独核对官网可见性。
                  </Empty>
                )
              ) : null}
              {view.value.tab === "recommendations" ? (
                <>
                  <QueryError
                    error={tiebaBackendError(automation.error)}
                    loading={automation.loading}
                    onRetry={automation.reload}
                    title="暂无法读取预设版本"
                  />
                  {s.recommendations.length ? (
                    <ul className="tieba-recommendations">
                      {s.recommendations.map((item) => (
                        <li key={item.id}>
                          <div>
                            <strong>{item.title}</strong>
                            <p>{item.reason}</p>
                          </div>
                          {item.preset ? (
                            <Button
                              size="compact"
                              disabled={
                                disabled ||
                                !automation.data ||
                                !!automation.error
                              }
                              data-testid="tieba-insights-apply-preset"
                              onClick={() =>
                                void action.run(
                                  () =>
                                    ipc("tieba.insights.applyPreset", {
                                      preset: item.preset!,
                                      automationRevision:
                                        automation.data!.revision,
                                    }),
                                  "已应用草稿预设，请到自动回帖面板检查范围",
                                )
                              }
                            >
                              应用草稿预设
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty compact title="暂无策略建议">
                      读取真实目标进度和发布结果后，再根据记录调整预设。
                    </Empty>
                  )}
                </>
              ) : null}
              {s.logs.items.length ? (
                <details className="tieba-console-details">
                  <summary>复盘运行记录 · {s.logs.items.length} 条</summary>
                  <ul>
                    {s.logs.items.slice(0, 20).map((entry, index) => (
                      <li key={index}>{entry.message}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
