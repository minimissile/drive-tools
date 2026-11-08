import { z } from "zod";
import type { TiebaAutocareSnapshot } from "../../shared/tieba-autocare";
import { Button, Empty, Panel, Status } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Pagination } from "../ui/Pagination";
import { useLocalDraft } from "../hooks/useLocalDraft";
import {
  tiebaTaskKind,
  tiebaTaskLabels,
  tiebaTaskSummary,
  tiebaTime,
} from "./view-model";

export function TiebaTasks({
  snapshot: s,
  workspace,
  busy,
  onReconcile,
}: {
  snapshot: TiebaAutocareSnapshot;
  workspace: string;
  busy: boolean;
  onReconcile(taskId: string): void;
}) {
  const filters = useLocalDraft(
    `tieba-autocare-task-view:${workspace}`,
    { history: false, page: 1 },
    (value) =>
      z
        .object({
          history: z.boolean(),
          page: z.number().int().min(1).max(100000),
        })
        .parse(value),
  );
  const { history, page } = filters.value;
  const tasks = history
    ? s.tasks
    : s.tasks
        .filter((task) => s.run && task.deadlineAt === s.run.deadlineAt)
        .toSorted((left, right) =>
          left.plannedAt.localeCompare(right.plannedAt),
        );
  const summary = tiebaTaskSummary(tasks);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(tasks.length / 8)));
  const accounts = new Map(
    s.accounts.map((account) => [
      account.id,
      account.alias || account.nickname || "贴吧账号",
    ]),
  );
  return (
    <Panel
      title={history ? "签到历史" : "本轮签到计划"}
      className="tieba-tasks"
      extra={
        <CheckboxField
          label="显示历史"
          checked={history}
          onChange={(event) => {
            filters.update({ history: event.target.checked, page: 1 });
          }}
        />
      }
    >
      {tasks.length ? (
        <>
          <div className="tieba-task-summary">
            <span>
              签到已核实 <strong>{summary.verified}</strong>
            </span>
            <span>
              原已签到 <strong>{summary.already}</strong>
            </span>
            <span>
              结果待核对 <strong>{summary.uncertain}</strong>
            </span>
            {!history && s.run ? (
              <span>
                本轮截止 <strong>{tiebaTime(s.run.deadlineAt)}</strong>
              </span>
            ) : null}
          </div>
          <div className="table-scroll">
            <table
              className="tieba-task-table"
              aria-label={history ? "签到历史记录" : "本轮签到任务"}
            >
              <thead>
                <tr>
                  <th scope="col">贴吧 / 账号</th>
                  <th scope="col">计划时间</th>
                  <th scope="col">结果</th>
                  <th scope="col">运行情况</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks
                  .slice((currentPage - 1) * 8, currentPage * 8)
                  .map((task) => (
                    <tr key={task.id}>
                      <td>
                        <strong>{task.forumName}吧</strong>
                        <small>
                          {accounts.get(task.accountId) ?? "历史账号"}
                        </small>
                      </td>
                      <td>
                        {tiebaTime(task.plannedAt)}
                        <small>
                          {task.checkedAt
                            ? `核对于 ${tiebaTime(task.checkedAt)}`
                            : task.submittedAt
                              ? `提交于 ${tiebaTime(task.submittedAt)}`
                              : "尚未提交"}
                        </small>
                      </td>
                      <td>
                        <Status kind={tiebaTaskKind(task.status)}>
                          {tiebaTaskLabels[task.status]}
                        </Status>
                      </td>
                      <td>{task.message}</td>
                      <td>
                        {task.status === "uncertain" ? (
                          <Button
                            quiet
                            size="compact"
                            disabled={busy}
                            onClick={() => onReconcile(task.id)}
                            data-testid="tieba-reconcile"
                          >
                            核对原结果
                          </Button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={currentPage}
            pageSize={8}
            total={tasks.length}
            onPageChange={(value) => filters.update({ page: value })}
            label="签到任务分页"
          />
          {history && s.tasks.length === 500 ? (
            <small className="muted">当前展示最近500项记录。</small>
          ) : null}
        </>
      ) : (
        <Empty compact title={history ? "暂无签到历史" : "尚未安排本轮任务"}>
          {history
            ? "执行记录会保留计划时间、提交与官网核验结果。"
            : "保存目标并开启自动签到后，具体安排会显示在这里。"}
        </Empty>
      )}
    </Panel>
  );
}
