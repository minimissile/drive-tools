import { QueryError } from "../ui/QueryError";
import { ipc } from "../api/client";
import { useEffect, useState, useRef } from "react";
import { Button, Header, LoadingState, Notice, Panel } from "../ui/primitives";
import { ResourcePicker, ResourceRequired } from "../resources/components";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import { Copy, Database, Download, Link2, RefreshCw } from "lucide-react";
import { updateSelection } from "../lib/selection";
import SplitTree from "./SplitTree";
import type { SplitItem, SplitRun } from "../../shared/types";
export default function Split() {
  const { data } = useAppData(),
    { resource, copy, select } = useAppSelection(),
    { navigate, openSearch } = useAppNavigation(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const initialized = useRef("");
  const [readError, setReadError] = useState("");
  const [readRevision, setReadRevision] = useState(0);
  const [runId, setRunId] = useState(""),
    [run, setRun] = useState<SplitRun | null>(null),
    [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setRunId("");
    setRun(null);
    setSelectedIds(new Set());
    initialized.current = "";
  }, [copy?.id]);
  useEffect(() => {
    if (!copy) return;
    let alive = true;
    setReadError("");
    void ipc("split.list", { copyId: copy.id })
      .then((r) => {
        if (alive) {
          setRunId((old) =>
            old && r.some((i) => i.id === old) ? old : (r[0]?.id ?? ""),
          );
        }
      })
      .catch((e) => {
        if (alive) {
          setReadError(e.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [copy?.id, data?.jobs, readRevision]);
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    setReadError("");
    void ipc("split.get", { id: runId })
      .then((r) => {
        if (alive) {
          setRun(r);
          if (r.status === "ready" && initialized.current !== r.id) {
            initialized.current = r.id;
            setSelectedIds(new Set());
          }
        }
      })
      .catch((e) => {
        if (alive) {
          setReadError(e.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [runId, data?.jobs, readRevision]);
  const current = run?.copyId === copy?.id ? run : null,
    selected = current?.items.filter((i) => selectedIds.has(i.id)) ?? [],
    selectedRunning = selected.some((item) =>
      ["queued", "preflight", "verifying", "sharing", "archiving"].includes(
        item.stage ?? "",
      ),
    ),
    allReady =
      selected.length > 0 &&
      selected.every((i) => i.status === "ready" && i.verifiedAt);
  return (
    <>
      <Header
        title="展开目录，勾选你想单独分享的资源。"
        description="直接查看前三层文件与文件夹，支持独立建链，也可将选中项批量入库。"
      />
      <QueryError
        error={readError}
        onRetry={() => setReadRevision((n) => n + 1)}
      />
      <ResourceRequired>
        <Panel className="split-source">
          <div className="split-source-controls">
            <ResourcePicker />
            <Button
              primary
              disabled={
                copy?.status !== "ready" ||
                busy > 0 ||
                (!!current &&
                  ["pending", "inspecting"].includes(current.status))
              }
              onClick={async () => {
                const r = await command(
                  "split.preview",
                  { copyId: copy!.id, depth: 3, mode: "all" },
                  {
                    text: "正在读取三级目录，此步骤不创建分享。",
                    tone: "info",
                  },
                );
                if (r) {
                  setRunId(r.id);
                  setRun(r);
                  setSelectedIds(new Set());
                  initialized.current = "";
                }
              }}
            >
              <RefreshCw size={15} />
              {current ? "重新读取三级目录" : "读取三级目录"}
            </Button>
          </div>
          <small>
            最多展示三级、2000项资源。每个勾选项独立建链，每批最多100个。
          </small>
        </Panel>
        {copy?.status !== "ready" ? (
          <Notice warning>
            请先在资源库检查有效性，完成这份资源的文件归属核验后再拆分。
          </Notice>
        ) : null}
        {current ? (
          <Panel
            title="资源目录与独立链接"
            className="split-workspace-panel"
            extra={
              <small>
                已就绪{" "}
                {current.items.filter((i) => i.status === "ready").length} 项
              </small>
            }
          >
            {current.error ? (
              <Notice warning>
                {current.error}
                <Button
                  quiet
                  disabled={busy > 0}
                  onClick={() =>
                    void command("job.retry", { id: current.jobId })
                  }
                >
                  重新读取目录
                </Button>
              </Notice>
            ) : null}
            {["pending", "inspecting"].includes(current.status) ? (
              <LoadingState label="正在读取本人目录…" compact>
                预览成功后显示预计链接数，确认后才会创建分享。
              </LoadingState>
            ) : null}
            {current.status === "ready" &&
            (current.depth < 3 || current.mode !== "all") ? (
              <Notice>
                这是历史层级预览，父目录仅作路径展示。点击“重新读取三级目录”可勾选所有层级的资源。
              </Notice>
            ) : null}
            {current.items.length ? (
              <SplitTree
                key={current.id}
                run={current}
                title={resource?.title ?? "本人资料"}
                selectedIds={selectedIds}
                onSelect={(item, checked) => {
                  setSelectedIds((old) => {
                    return new Set(
                      updateSelection([...old], [item.id], checked, 100),
                    );
                  });
                }}
                onChange={(ids) => {
                  setSelectedIds(new Set(ids.slice(0, 100)));
                  if (ids.length > 100)
                    notify(
                      `本次选择包含${ids.length}项，已保留前100项，其余请分批处理。`,
                      "warning",
                    );
                }}
                renderDetails={(item) => (
                  <>
                    {item.archivedResourceId ? (
                      <Button
                        quiet
                        size="compact"
                        onClick={() => {
                          select(item.archivedResourceId!);
                          navigate("library");
                        }}
                      >
                        查看已入库资源
                      </Button>
                    ) : null}
                    {item.shareUrl ? (
                      <p className="break-word split-own-url">
                        {item.shareUrl}
                      </p>
                    ) : null}
                    {item.error ? (
                      <p className="danger-text break-word">{item.error}</p>
                    ) : null}
                    <div className="row compact">
                      <Button
                        quiet
                        disabled={item.status !== "ready" || busy > 0}
                        onClick={async () => {
                          const link = await command("split.link", {
                            itemId: item.id,
                          });
                          if (link)
                            await command(
                              "system.copyText",
                              { text: link.text },
                              "本人子链接已核验并复制。",
                            );
                        }}
                      >
                        核验并复制
                      </Button>
                      <Button
                        quiet
                        disabled={
                          item.status !== "ready" ||
                          !item.verifiedAt ||
                          busy > 0
                        }
                        onClick={() =>
                          openSearch({ copyId: copy!.id, splitItemId: item.id })
                        }
                      >
                        用于创作 →
                      </Button>
                      {[
                        "failed",
                        "needs_review",
                        "waiting_login",
                        "cancelled",
                      ].includes(item.stage ?? "") && item.jobId ? (
                        <Button
                          quiet
                          disabled={busy > 0}
                          onClick={() =>
                            void command("job.retry", { id: item.jobId! })
                          }
                        >
                          核对并恢复
                        </Button>
                      ) : null}
                    </div>
                    {item.status !== "ready" ? (
                      <RecoverSplit key={item.id} item={item} />
                    ) : null}
                  </>
                )}
              />
            ) : null}
            <div className="split-actions">
              <div className="split-actions-summary" aria-live="polite">
                <strong>已选 {selected.length} 项</strong>
                <span>
                  已入库{" "}
                  {selected.filter((item) => item.archivedResourceId).length} 项
                  · 复制与导出包含提取码
                </span>
              </div>
              <div className="actions">
                <Button
                  primary
                  disabled={
                    current.status !== "ready" ||
                    !selected.length ||
                    selected.every((item) => item.archivedResourceId) ||
                    selectedRunning ||
                    busy > 0
                  }
                  onClick={async () => {
                    const result = await command("split.archive", {
                      id: current.id,
                      itemIds: selected.map((item) => item.id),
                    });
                    if (result)
                      notify(
                        `已排队入库${result.created}项，已有记录${result.reused}项。可在目录中查看逐项结果。`,
                        "success",
                      );
                  }}
                >
                  <Database size={15} />
                  批量入库{selected.length ? `（${selected.length}）` : ""}
                </Button>
                <Button
                  disabled={
                    current.status !== "ready" ||
                    !selected.length ||
                    selected.length > 100 ||
                    selectedRunning ||
                    busy > 0
                  }
                  onClick={async () => {
                    const r = await command("split.start", {
                      id: current.id,
                      itemIds: selected.map((i) => i.id),
                      rightsConfirmed: true,
                    });
                    if (r)
                      notify(
                        `已排队${r.created}项，复用${r.reused}项；原文件与资料链接保持保留。`,
                        "success",
                      );
                  }}
                >
                  <Link2 size={15} />
                  仅生成链接
                </Button>
                <Button
                  disabled={!allReady || busy > 0}
                  onClick={async () => {
                    const text = await command("split.package", {
                      id: current.id,
                      itemIds: selected.map((i) => i.id),
                      includeCodes: true,
                    });
                    if (text)
                      await command(
                        "system.copyText",
                        { text: text.text },
                        "所选本人子链接已核验并复制。",
                      );
                  }}
                >
                  <Copy size={15} />
                  批量复制链接
                </Button>
                <Button
                  disabled={!allReady || busy > 0}
                  onClick={async () => {
                    const path = await command("split.export", {
                      id: current.id,
                      itemIds: selected.map((i) => i.id),
                      includeCodes: true,
                    });
                    if (path) notify(`本人链接清单已导出：${path}`, "success");
                  }}
                >
                  <Download size={15} />
                  导出CSV
                </Button>
                <Button
                  disabled={busy > 0}
                  onClick={() =>
                    void command(
                      "split.cancel",
                      { id: current.id },
                      "已停止本地等待，请核对远端结果。",
                    )
                  }
                >
                  停止本次等待
                </Button>
                <Button quiet onClick={() => navigate("tasks")}>
                  查看任务日志
                </Button>
              </div>
            </div>
          </Panel>
        ) : null}
      </ResourceRequired>
    </>
  );
}
function RecoverSplit({ item }: { item: SplitItem }) {
  const { command } = useAppActions(),
    { busy } = useAppActivity(),
    [text, setText] = useState("");
  return (
    <details>
      <summary>恢复本人子链接</summary>
      <textarea
        aria-label={`恢复子链接${item.path}`}
        value={text}
        maxLength={8000}
        placeholder="粘贴本人已创建的分享链接与提取码"
        onChange={(e) => setText(e.target.value)}
      />
      <Button
        disabled={!text.trim() || busy > 0}
        onClick={() =>
          void command(
            "split.recover",
            { itemId: item.id, text },
            "本人子链接恢复已核验。",
          )
        }
      >
        核验恢复链接
      </Button>
    </details>
  );
}
