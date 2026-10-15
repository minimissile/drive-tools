import { useEffect, useState, useRef } from "react";
import {
  Button,
  Field,
  Header,
  Notice,
  Panel,
  ResourcePicker,
  ResourceRequired,
  formatTime,
} from "../components";
import { useApp } from "../state";
import { FolderTree, RefreshCw } from "lucide-react";
import SplitTree from "./SplitTree";
import type { SplitItem, SplitRun } from "../../shared/types";
export default function Split() {
  const { data, resource, copy, command, busy, notify, navigate } = useApp();
  const initialized = useRef("");
  const [runId, setRunId] = useState(""),
    [run, setRun] = useState<SplitRun | null>(null),
    [history, setHistory] = useState<
      {
        id: string;
        depth: number;
        mode: string;
        status: string;
        createdAt: string;
      }[]
    >([]),
    [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set()),
    [rights, setRights] = useState(false),
    [exportCodes, setExportCodes] = useState(false);
  useEffect(() => {
    setRunId("");
    setRun(null);
    setSelectedIds(new Set());
    setRights(false);
    initialized.current = "";
  }, [copy?.id]);
  useEffect(() => {
    if (!copy) return;
    let alive = true;
    void window.panxu
      .invoke<typeof history>("split.list", { copyId: copy.id })
      .then((r) => {
        if (alive) {
          setHistory(r);
          setRunId((old) =>
            old && r.some((i) => i.id === old) ? old : (r[0]?.id ?? ""),
          );
        }
      })
      .catch((e) => notify(e.message, true));
    return () => {
      alive = false;
    };
  }, [copy?.id, data?.jobs, notify]);
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    void window.panxu
      .invoke<SplitRun>("split.get", { id: runId })
      .then((r) => {
        if (alive) {
          setRun(r);
          if (r.status === "ready" && initialized.current !== r.id) {
            initialized.current = r.id;
            setSelectedIds(new Set());
          }
        }
      })
      .catch((e) => notify(e.message, true));
    return () => {
      alive = false;
    };
  }, [runId, data?.jobs, notify]);
  const current = run?.copyId === copy?.id ? run : null,
    selected = current?.items.filter((i) => selectedIds.has(i.id)) ?? [],
    allReady =
      selected.length > 0 &&
      selected.every((i) => i.status === "ready" && i.verifiedAt);
  return (
    <>
      <Header
        title="展开目录，勾选你想单独分享的资源。"
        description="直接查看前三层文件与文件夹，每个勾选项生成一个独立的本人链接。"
      />
      <ResourceRequired>
        <ResourcePicker />
        <Panel className="split-intro">
          <div className="split-intro-copy">
            <span className="split-intro-icon">
              <FolderTree size={24} />
            </span>
            <div>
              <h2>先看目录，再选资源</h2>
              <p>
                一次展示最多三级目录，可自由勾选，也可按层快捷选择。读取目录最多2000项，每批生成最多100个链接。
              </p>
            </div>
          </div>
          <Button
            primary
            disabled={
              copy?.status !== "ready" ||
              busy > 0 ||
              (!!current && ["pending", "inspecting"].includes(current.status))
            }
            onClick={async () => {
              const r = await command<SplitRun>(
                "split.preview",
                { copyId: copy!.id, depth: 3, mode: "all" },
                "正在读取三级目录，此步骤不创建分享。",
              );
              if (r) {
                setRunId(r.id);
                setRun(r);
                setSelectedIds(new Set());
                initialized.current = "";
                setRights(false);
              }
            }}
          >
            <RefreshCw size={15} />
            {current ? "重新读取三级目录" : "读取三级目录"}
          </Button>
        </Panel>
        {copy?.status !== "ready" ? (
          <Notice warning>请先完成这份资料的本人转存与文件归属核验。</Notice>
        ) : null}
        {history.length ? (
          <Field label="拆分记录">
            <select
              aria-label="拆分记录"
              value={runId}
              onChange={(e) => {
                setRunId(e.target.value);
                setSelectedIds(new Set());
                initialized.current = "";
                setRights(false);
              }}
            >
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  {formatTime(h.createdAt)} · 第{h.depth}层 ·{" "}
                  {h.mode === "all" ? "逐层" : "按层级"}
                </option>
              ))}
            </select>
          </Field>
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
              <Notice>
                正在读取本人目录。预览成功后显示预计链接数，确认后才会创建分享。
              </Notice>
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
                  setRights(false);
                  setSelectedIds((old) => {
                    const next = new Set(old);
                    if (checked && next.size < 100) next.add(item.id);
                    else if (!checked) next.delete(item.id);
                    return next;
                  });
                }}
                onChange={(ids) => {
                  setRights(false);
                  setSelectedIds(new Set(ids.slice(0, 100)));
                  if (ids.length > 100)
                    notify(
                      `本层有${ids.length}项，已选择前100项，其余可分批勾选。`,
                    );
                }}
                renderDetails={(item) => (
                  <>
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
                          const link = await command<{ text: string }>(
                            "split.link",
                            { itemId: item.id },
                          );
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
                            void command("job.retry", { id: item.jobId })
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
            <div className="split-confirmation">
              <label className="checkbox">
                <input
                  type="checkbox"
                  aria-label="拆分分享权利确认"
                  checked={rights}
                  onChange={(e) => setRights(e.target.checked)}
                />
                我有权分享所选文件或文件夹，已核对独立链接清单。
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={exportCodes}
                  onChange={(e) => setExportCodes(e.target.checked)}
                />
                导出清单或批量复制时附本人分享提取码
              </label>
              <div className="actions">
                <Button
                  primary
                  disabled={
                    current.status !== "ready" ||
                    !selected.length ||
                    selected.length > 100 ||
                    !rights ||
                    busy > 0
                  }
                  onClick={async () => {
                    const r = await command<{
                      created: number;
                      reused: number;
                    }>("split.start", {
                      id: current.id,
                      itemIds: selected.map((i) => i.id),
                      rightsConfirmed: true,
                    });
                    if (r)
                      notify(
                        `已排队${r.created}项，复用${r.reused}项；原文件与资料链接保持保留。`,
                      );
                  }}
                >
                  生成所选{selected.length}个本人链接
                </Button>
                <Button
                  disabled={!allReady || busy > 0}
                  onClick={async () => {
                    const text = await command<{ text: string }>(
                      "split.package",
                      {
                        id: current.id,
                        itemIds: selected.map((i) => i.id),
                        includeCodes: exportCodes,
                      },
                    );
                    if (text)
                      await command(
                        "system.copyText",
                        { text: text.text },
                        "所选本人子链接已核验并复制。",
                      );
                  }}
                >
                  批量核验并复制
                </Button>
                <Button
                  disabled={!allReady || busy > 0}
                  onClick={async () => {
                    const path = await command<string | null>("split.export", {
                      id: current.id,
                      itemIds: selected.map((i) => i.id),
                      includeCodes: exportCodes,
                    });
                    if (path) notify(`本人链接清单已导出：${path}`);
                  }}
                >
                  导出本人链接CSV
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
  const { command, busy } = useApp(),
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
