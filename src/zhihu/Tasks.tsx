import { useState } from "react";
import type { ZhihuTask } from "../../shared/zhihu";
import { ipc } from "../api/client";
import { Button, Empty, Field, Panel, Status } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { Pagination } from "../ui/Pagination";
import { formatTime } from "../lib/format";
import type { ZhihuAction } from "./Accounts";
const labels = {
  queued: "排队中",
  running: "填写中",
  submitting: "提交中",
  published: "已发布",
  attention: "待核对",
  cancelled: "已取消",
};
export function ZhihuTasks({
  tasks,
  accounts,
  busy,
  run,
}: {
  tasks: ZhihuTask[];
  accounts: { id: string; alias: string }[];
  busy: boolean;
  run: ZhihuAction;
}) {
  const [page, setPage] = useState(1),
    [resolving, setResolving] = useState<ZhihuTask | null>(null),
    [url, setUrl] = useState("");
  const actualPage = Math.min(page, Math.max(1, Math.ceil(tasks.length / 10)));
  return (
    <Panel title="发布队列与历史">
      {tasks.length ? (
        <div className="zhihu-task-list">
          {tasks.slice((actualPage - 1) * 10, actualPage * 10).map((t) => (
            <article key={t.id} className="zhihu-task-row">
              <div>
                <strong>{t.title}</strong>
                <small>
                  {accounts.find((a) => a.id === t.accountId)?.alias ||
                    "账号已移除"}{" "}
                  · {t.kind === "article" ? "文章" : "回答"} · v
                  {t.contentVersion} · 计划 {formatTime(t.scheduledAt)}
                </small>
                <p>{t.message}</p>
                {t.url ? (
                  <a
                    href={t.url}
                    onClick={(e) => {
                      e.preventDefault();
                      void ipc("system.external", { url: t.url! });
                    }}
                  >
                    查看知乎发布链接
                  </a>
                ) : null}
              </div>
              <Status
                kind={
                  t.status === "published"
                    ? "good"
                    : t.status === "attention"
                      ? "warning"
                      : "normal"
                }
              >
                {labels[t.status]}
              </Status>
              <div>
                {t.status === "queued" ? (
                  <Button
                    quiet
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => ipc("zhihu.task.cancel", { id: t.id }),
                        "尚未执行的任务已取消",
                      )
                    }
                  >
                    取消排队
                  </Button>
                ) : t.status === "attention" ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setResolving(t);
                      setUrl("");
                    }}
                  >
                    核对结果
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty title="还没有发布任务">
          启用养号计划，或在已审核素材中指定账号加入队列。
        </Empty>
      )}
      <Pagination
        page={actualPage}
        pageSize={10}
        total={tasks.length}
        onPageChange={setPage}
        label="知乎任务分页"
      />
      {resolving ? (
        <Dialog
          title="核对知乎发布结果"
          busy={busy}
          onClose={() => setResolving(null)}
        >
          <p>
            请先在此账号的官方页面检查“{resolving.title}
            ”。结果未知的任务不会自动重发。
          </p>
          <Field label="已发布的知乎官方链接">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://zhuanlan.zhihu.com/p/…"
            />
          </Field>
          <div className="row wrap">
            <Button
              primary
              disabled={busy || !url.trim()}
              onClick={() =>
                void run(
                  () =>
                    ipc("zhihu.task.resolve", {
                      id: resolving.id,
                      outcome: "published",
                      url,
                      confirmed: true,
                    }),
                  "已登记本人核对的发布结果",
                ).then((ok) => {
                  if (ok) setResolving(null);
                })
              }
            >
              登记已发布链接
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    ipc("zhihu.task.resolve", {
                      id: resolving.id,
                      outcome: "not_published",
                      confirmed: true,
                    }),
                  "已确认未发布，素材可重新安排",
                ).then((ok) => {
                  if (ok) setResolving(null);
                })
              }
            >
              我已核实未发布
            </Button>
          </div>
        </Dialog>
      ) : null}
    </Panel>
  );
}
