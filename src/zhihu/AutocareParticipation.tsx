import { useRef, useState } from "react";
import type { AutocareSnapshot } from "../../shared/zhihu-autocare";
import type { ZhihuParticipationActivity } from "../../shared/zhihu-participation";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import { Button, Empty, Notice, Panel, Status } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { formatTime } from "../lib/format";
import { ParticipationContext } from "./ParticipationContext";
import "./participation.css";

export function AutocareParticipation({
  snapshot: s,
  reload,
}: {
  snapshot: AutocareSnapshot;
  reload(): void;
}) {
  const [selected, setSelected] = useState(""),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    { notify } = useAppActions();
  // A successful remote action remains visible if the subsequent refresh fails.
  const [received, setReceived] = useState<
    Record<string, ZhihuParticipationActivity>
  >({});
  const activities = s.participation.activities
    .filter((a) => ["like", "follow"].includes(a.kind))
    .map((a) =>
      (received[a.id]?.version ?? 0) > a.version ? received[a.id] : a,
    )
    .reverse();
  const current = activities.find((a) => a.id === selected);
  const names = new Map(s.accounts.map((a) => [a.id, a.nickname || a.alias]));
  const result = (a: ZhihuParticipationActivity) => {
    const attempt = a.attempts?.at(-1);
    return attempt?.receipt?.outcome === "already_present"
      ? "原有状态 · 未重复操作"
      : a.status === "succeeded"
        ? "官方已核实"
        : a.status === "attention"
          ? "需要核对"
          : a.status === "failed"
            ? "未完成"
            : a.resolution
              ? "已跳过"
              : "待本人确认";
  };
  const open = (url: string) => {
    void ipc("system.external", { url }).catch((e) =>
      notify(e instanceof Error ? e.message : "无法打开原文", "error"),
    );
  };
  const run = async (
    a: ZhihuParticipationActivity,
    operation: "execute" | "reconcile" | "refresh" = "execute",
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const text = a.context?.text;
      if (
        operation === "execute" &&
        (!text || text.length < 8 || a.context?.truncated)
      )
        throw new Error("完整上下文不足，请先重新读取");
      const updated =
        operation === "refresh"
          ? await ipc("zhihu.autocare.refreshInteraction", {
              id: a.id,
              version: a.version,
            })
          : operation === "reconcile"
            ? await ipc("zhihu.autocare.reconcile", {
                id: a.id,
                version: a.version,
              })
            : await ipc("zhihu.autocare.interact", {
                id: a.id,
                version: a.version,
                revision: s.revision,
                confirmed: true,
                quote: text!.slice(0, 120),
                basis: `本人在运营面板查看所示准确目标后，确认对《${a.context!.title.slice(0, 300)}》执行${a.kind === "like" ? "赞同" : "关注"}。这是本人单项选择，未使用AI相关性评分。`,
              });
      const actual = updated.participation.activities.find(
        (item) => item.id === a.id,
      );
      if (actual) setReceived((old) => ({ ...old, [a.id]: actual }));
      notify(
        operation === "refresh"
          ? "上下文已更新，未执行互动"
          : actual?.attempts?.at(-1)?.receipt?.summary ||
              "已保留原执行记录，请查看处理结果",
        actual?.status === "succeeded" || operation === "refresh"
          ? "success"
          : "warning",
      );
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "本次操作未完成，原记录保留");
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };
  return (
    <Panel
      title="点赞与关注待办"
      extra={
        <small className="muted">
          {
            activities.filter((a) => !a.attempts?.length && !a.resolution)
              .length
          }{" "}
          项待确认
        </small>
      }
    >
      <p className="muted autocare-help">
        从已读内容发现具体文章和作者。查看上下文后确认，系统核对账号、间隔及官方结果；已有状态不重复点击。
      </p>
      {error ? <Notice danger>{error}</Notice> : null}
      {activities.length ? (
        <>
          <div className="table-wrap">
            <table className="autocare-participation-table">
              <thead>
                <tr>
                  <th>账号 / 操作</th>
                  <th>目标</th>
                  <th>状态</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {activities.slice((page - 1) * 6, page * 6).map((a) => (
                  <tr key={a.id}>
                    <td>
                      {names.get(a.accountId)}
                      <small>{a.kind === "like" ? "点赞" : "关注作者"}</small>
                    </td>
                    <td>
                      <span>{a.context?.title || "原上下文待读取"}</span>
                      <small>{formatTime(a.createdAt)}</small>
                    </td>
                    <td>
                      <Status
                        kind={
                          a.status === "succeeded"
                            ? "good"
                            : a.status === "attention" || a.status === "failed"
                              ? "warning"
                              : "normal"
                        }
                      >
                        {result(a)}
                      </Status>
                    </td>
                    <td>
                      <Button
                        quiet
                        size="compact"
                        disabled={busy}
                        onClick={() =>
                          setSelected(selected === a.id ? "" : a.id)
                        }
                      >
                        {selected === a.id ? "收起" : "查看内容"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={6}
            total={activities.length}
            onPageChange={setPage}
            label="运营互动待办分页"
          />
        </>
      ) : (
        <Empty compact title="尚无互动待办">
          开启“准备点赞”或“发现作者与关注”，系统会在运营时段按读取上限准备真实目标。
        </Empty>
      )}
      {current?.context ? (
        <section
          className="autocare-interaction-detail"
          aria-label="当前互动目标"
        >
          <div className="row between">
            <h3>
              {current.kind === "like" ? "确认赞同的内容" : "确认关注的作者"} ·{" "}
              {names.get(current.accountId)}
            </h3>
            <Button
              quiet
              size="compact"
              onClick={() => open(current.context!.url)}
            >
              打开官方原文
            </Button>
          </div>
          <ParticipationContext
            document={current.context}
            open={open}
            busy={busy}
          />
          <div className="row compact">
            {!current.attempts?.length && !current.resolution ? (
              <Button
                primary
                size="compact"
                disabled={
                  !s.enabled ||
                  s.busy ||
                  busy ||
                  !(current.kind === "like"
                    ? s.config.likeCandidates
                    : s.config.followCandidates)
                }
                onClick={() => void run(current)}
              >
                {current.kind === "like" ? "确认赞同此内容" : "确认关注此作者"}
              </Button>
            ) : null}
            {!current.attempts?.length && !current.resolution ? (
              <Button
                size="compact"
                disabled={s.busy || busy}
                onClick={() => void run(current, "refresh")}
              >
                更新上下文
              </Button>
            ) : null}
            {current.attempts?.at(-1)?.submittedAt &&
            current.status === "attention" ? (
              <Button
                size="compact"
                disabled={s.busy || busy}
                onClick={() => void run(current, "reconcile")}
              >
                只读核对原结果
              </Button>
            ) : null}
            <small className="muted">
              {s.enabled
                ? "确认后执行这一项，仍受每日互动上限与至少60分钟间隔约束。"
                : "总开关已关闭，可查看记录与核对原提交结果。"}
            </small>
          </div>
          {current.attempts?.at(-1) ? (
            <p className="autocare-wrap muted">
              {current.attempts.at(-1)?.receipt?.summary ||
                current.attempts.at(-1)?.error}{" "}
              · 尝试 {formatTime(current.attempts.at(-1)!.startedAt)}
              {current.attempts.at(-1)?.submittedAt
                ? ` · 提交 ${formatTime(current.attempts.at(-1)!.submittedAt!)}`
                : " · 未记录提交"}
            </p>
          ) : null}
        </section>
      ) : null}
    </Panel>
  );
}
