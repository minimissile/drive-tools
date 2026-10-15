import { useEffect, useState } from "react";
import {
  Button,
  Field,
  Header,
  Notice,
  Panel,
  SearchField,
  Status,
  accountLabel,
  formatTime,
  stageName,
} from "../components";
import { useApp } from "../state";
import type { TransferBatch } from "../../shared/types";
type CandidatePage = {
  total: number;
  page: number;
  pageSize: number;
  items: {
    copyId: string;
    accountId: string;
    title: string;
    provider: string;
    category: string;
  }[];
};
export default function Batch() {
  const { data, command, busy, notify, navigate } = useApp();
  const [query, setQuery] = useState(""),
    [account, setAccount] = useState("all"),
    [page, setPage] = useState(1),
    [candidates, setCandidates] = useState<CandidatePage | null>(null),
    [copies, setCopies] = useState<string[]>(() => {
      try {
        return JSON.parse(localStorage.getItem("panxu-batch-seed") ?? "[]");
      } catch {
        return [];
      }
    }),
    [batchId, setBatchId] = useState(
      () => localStorage.getItem("panxu-batch-id") ?? "",
    ),
    [batch, setBatch] = useState<TransferBatch | null>(null),
    [history, setHistory] = useState<
      { id: string; createdAt: string; count: number }[]
    >([]),
    [excluded, setExcluded] = useState<string[]>([]),
    [rights, setRights] = useState(false);
  useEffect(() => {
    localStorage.removeItem("panxu-batch-seed");
  }, []);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void window.panxu
        .invoke<CandidatePage>("batch.candidates", {
          query,
          accountId: account,
          page,
        })
        .then((r) => {
          if (alive) setCandidates(r);
        })
        .catch((e) => notify(e.message, true));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, account, page, data?.jobs, data?.resources, notify]);
  useEffect(() => {
    let alive = true;
    void window.panxu
      .invoke<typeof history>("batch.list")
      .then((r) => {
        if (alive) setHistory(r);
      })
      .catch((e) => notify(e.message, true));
    return () => {
      alive = false;
    };
  }, [data?.jobs, notify]);
  useEffect(() => {
    if (!batchId) {
      setBatch(null);
      return;
    }
    let alive = true;
    localStorage.setItem("panxu-batch-id", batchId);
    void window.panxu
      .invoke<TransferBatch>("batch.get", { id: batchId })
      .then((r) => {
        if (alive) setBatch(r);
      })
      .catch((e) => notify(e.message, true));
    return () => {
      alive = false;
    };
  }, [batchId, data?.jobs, notify]);
  const ready =
      batch?.items.filter(
        (i) => i.state === "ready" && !excluded.includes(i.id),
      ) ?? [],
    reading = batch?.items.some(
      (i) => ["queued", "preflight"].includes(i.stage) && !i.transferJobId,
    );
  return (
    <>
      <Header
        title="一次预检，按账号逐份转存。"
        description="先读取分享并选择文件，再统一确认；同账号串行、不同账号最多并行两个任务。"
      />
      <Notice>
        每批最多100份资料。未选择过文件的草稿默认读取分享根目录；目录整体转存，不递归打散原文件。单份根目录超过100项时，请先在录入页面选择文件。
      </Notice>
      <Panel
        title="选择待转存草稿"
        extra={
          <Button quiet onClick={() => navigate("bulk")}>
            批量录入CSV
          </Button>
        }
      >
        <div className="toolbar">
          <SearchField
            value={query}
            onChange={(v) => {
              setQuery(v);
              setPage(1);
            }}
          />
          <select
            aria-label="批量转存账号筛选"
            value={account}
            onChange={(e) => {
              setAccount(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">全部账号</option>
            {data!.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.alias}
              </option>
            ))}
          </select>
          <small>已选 {copies.length} / 100 份</small>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>选择</th>
                <th>资料</th>
                <th>目标账号</th>
                <th>分类</th>
              </tr>
            </thead>
            <tbody>
              {candidates?.items.map((i) => (
                <tr key={i.copyId}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`批量选择${i.title}`}
                      checked={copies.includes(i.copyId)}
                      disabled={
                        !copies.includes(i.copyId) && copies.length >= 100
                      }
                      onChange={(e) =>
                        setCopies((old) =>
                          e.target.checked
                            ? [...old, i.copyId]
                            : old.filter((id) => id !== i.copyId),
                        )
                      }
                    />
                  </td>
                  <td>{i.title}</td>
                  <td>{accountLabel(data!.accounts, i.accountId)}</td>
                  <td>{i.category}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {candidates?.total === 0 ? (
          <p className="muted">
            没有符合条件的草稿。已有转存任务的资料请从“转存任务”恢复。
          </p>
        ) : null}
        <div className="row spread pagination">
          <Button
            disabled={!candidates || candidates.page <= 1}
            onClick={() => setPage((candidates?.page ?? 1) - 1)}
          >
            上一批草稿
          </Button>
          <small>
            共 {candidates?.total ?? 0} 份 · 第 {candidates?.page ?? 1} 页
          </small>
          <Button
            disabled={
              !candidates ||
              candidates.page * candidates.pageSize >= candidates.total
            }
            onClick={() => setPage((candidates?.page ?? 1) + 1)}
          >
            下一批草稿
          </Button>
        </div>
        <div className="actions">
          <Button
            primary
            disabled={!copies.length || busy > 0}
            onClick={async () => {
              const r = await command<TransferBatch>(
                "batch.preview",
                { copyIds: copies },
                "预检已排队，完成后再确认转存。",
              );
              if (r) {
                setBatchId(r.id);
                setBatch(r);
                setExcluded([]);
                setRights(false);
                setCopies([]);
              }
            }}
          >
            读取并预检所选资料
          </Button>
          <Button quiet disabled={!copies.length} onClick={() => setCopies([])}>
            清空选择
          </Button>
        </div>
      </Panel>
      {history.length ? (
        <Field label="批次记录">
          <select
            aria-label="批量转存批次"
            value={batchId}
            onChange={(e) => {
              setBatchId(e.target.value);
              setExcluded([]);
              setRights(false);
            }}
          >
            <option value="">选择批次</option>
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {formatTime(h.createdAt)} · {h.count}份
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {batch ? (
        <Panel
          title="批次预检与执行结果"
          extra={<small>{formatTime(batch.createdAt)}</small>}
        >
          <div className="stat-strip">
            <div>
              本批资料<strong>{batch.items.length}</strong>
            </div>
            <div>
              已完成转存
              <strong>
                {
                  batch.items.filter(
                    (i) => i.transferJobId && i.stage === "completed",
                  ).length
                }
              </strong>
            </div>
            <div>
              等待确认
              <strong>
                {batch.items.filter((i) => i.state === "ready").length}
              </strong>
            </div>
          </div>
          {batch.items.map((i) => (
            <div className="operation-item" key={i.id}>
              <div className="row spread">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    aria-label={`确认转存${i.title}`}
                    checked={
                      i.state === "started" ||
                      (i.state === "ready" && !excluded.includes(i.id))
                    }
                    disabled={i.state !== "ready" || busy > 0}
                    onChange={(e) =>
                      setExcluded((old) =>
                        e.target.checked
                          ? old.filter((id) => id !== i.id)
                          : [...old, i.id],
                      )
                    }
                  />
                  <strong>{i.title}</strong>
                </label>
                <Status
                  kind={
                    i.transferJobId && i.stage === "completed"
                      ? "good"
                      : [
                            "failed",
                            "needs_review",
                            "waiting_login",
                            "cancelled",
                          ].includes(i.stage)
                        ? "warning"
                        : "normal"
                  }
                >
                  {i.state === "ready"
                    ? "预检通过，待确认"
                    : stageName(i.stage)}
                </Status>
              </div>
              <small>
                {accountLabel(data!.accounts, i.accountId)} ·{" "}
                {i.selectedIds.length} / {i.files.length} 项
              </small>
              {i.error ? <Notice warning>{i.error}</Notice> : null}
              {i.files.length ? (
                <details>
                  <summary>查看文件选择</summary>
                  <div className="file-check-list">
                    {i.files.map((f) => (
                      <label className="checkbox" key={f.id}>
                        <input
                          type="checkbox"
                          aria-label={`批次文件${i.id}-${f.name}`}
                          checked={i.selectedIds.includes(f.id)}
                          disabled={i.state !== "ready" || busy > 0}
                          onChange={(e) =>
                            void command("batch.selection", {
                              itemId: i.id,
                              fileIds: e.target.checked
                                ? [...i.selectedIds, f.id]
                                : i.selectedIds.filter((id) => id !== f.id),
                            })
                          }
                        />
                        {f.isDirectory ? "文件夹" : "文件"} · {f.name}
                      </label>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          ))}
          {reading ? (
            <Notice>
              正在逐份读取分享。可以离开此页，预检进度会保存在任务记录中。
            </Notice>
          ) : null}
          <label className="checkbox">
            <input
              type="checkbox"
              aria-label="批量转存权利确认"
              checked={rights}
              onChange={(e) => setRights(e.target.checked)}
            />
            我确认所选资料均有权保存和再分享，目标账号与文件选择正确。
          </label>
          <div className="actions">
            <Button
              primary
              disabled={
                reading ||
                !rights ||
                !ready.length ||
                ready.some((i) => !i.selectedIds.length) ||
                busy > 0
              }
              onClick={async () => {
                const r = await command<{
                  created: number;
                  reused: number;
                  skipped: number;
                }>("batch.start", {
                  id: batch.id,
                  itemIds: ready.map((i) => i.id),
                  rightsConfirmed: true,
                });
                if (r)
                  notify(
                    `已创建${r.created}个转存任务，复用${r.reused}个，跳过${r.skipped}个。`,
                  );
              }}
            >
              开始批量转存（{ready.length}份）
            </Button>
            <Button
              disabled={busy > 0}
              onClick={() =>
                void command(
                  "batch.cancel",
                  { id: batch.id },
                  "已停止本批本地等待；远端操作请核对结果。",
                )
              }
            >
              停止本批等待
            </Button>
            <Button
              disabled={busy > 0}
              onClick={() =>
                void command(
                  "batch.retry",
                  { id: batch.id },
                  "异常任务已进入核对和恢复队列。",
                )
              }
            >
              恢复异常项
            </Button>
            <Button quiet onClick={() => navigate("tasks")}>
              查看任务日志
            </Button>
          </div>
        </Panel>
      ) : null}
    </>
  );
}
