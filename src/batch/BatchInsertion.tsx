import { useEffect, useState } from "react";
import { z } from "zod";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppData } from "../state";
import { Button, Field, Notice, Panel, Empty } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { updateSelection } from "../lib/selection";
import {
  insertionTargetInput,
  type InsertionRun,
  type InsertionTarget,
  type InsertionState,
} from "../../shared/insertion";
import { InsertionMaterials } from "./InsertionMaterials";
import { DirectoryPicker } from "./DirectoryPicker";
import "./batch.css";
const parseDraft = (v: unknown) =>
  z
    .object({
      materialIds: z.array(z.string()).max(10),
      targets: z.array(insertionTargetInput).max(100),
      runId: z.string(),
    })
    .parse(v);
const stateNames: Record<InsertionState, string> = {
  pending: "待插入",
  writing: "写入中",
  success: "已插入",
  skipped: "已跳过",
  uncertain: "待核对",
  failed: "失败",
  cancelled: "已取消",
};
export function BatchInsertion() {
  const { data } = useAppData(),
    { command, notify } = useAppActions();
  const draft = useLocalDraft(
    "panxu-insertion:" + data!.dataPath,
    {
      materialIds: [] as string[],
      targets: [] as InsertionTarget[],
      runId: "",
    },
    parseDraft,
  );
  const { materialIds, targets, runId } = draft.value;
  const [accountId, setAccountId] = useState(""),
    [source, setSource] = useState("managed"),
    [query, setQuery] = useState(""),
    [revision, setRevision] = useState(0),
    [run, setRun] = useState<InsertionRun | null>(null),
    [working, setWorking] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [page, setPage] = useState(1);
  const materials = useIpcQuery("insertion.materials", undefined, { revision });
  const candidates = useIpcQuery(
    "insertion.candidates",
    { query },
    { revision, delay: 180 },
  );
  const history = useIpcQuery("insertion.list", undefined, { revision });
  const running = run?.state === "running";
  const runQuery = useIpcQuery(
    "insertion.get",
    { id: runId },
    {
      enabled: !!runId,
      revision,
      keepPrevious: true,
      refreshInterval: running ? 1500 : 0,
    },
  );
  useEffect(() => {
    if (runQuery.data) setRun(runQuery.data);
  }, [runQuery.data]);
  useEffect(() => {
    setConfirmed(false);
    setPage(1);
  }, [runId]);
  const mutateTargets = (target: InsertionTarget, checked: boolean) => {
    const filtered = targets.filter(
      (t) =>
        !(t.accountId === target.accountId && t.folderId === target.folderId),
    );
    if (checked && filtered.length >= 100) {
      notify("每批最多选择 100 个目录。", "warning");
      return;
    }
    draft.update({ targets: checked ? [...filtered, target] : filtered });
    setConfirmed(false);
  };
  const preview = async () => {
    setWorking(true);
    setConfirmed(false);
    try {
      const r = await command("insertion.preview", { targets, materialIds });
      if (r) {
        setRun(r);
        draft.update({ runId: r.id });
        setRevision((n) => n + 1);
      }
    } finally {
      setWorking(false);
    }
  };
  const chooseRun = (id: string) => {
    draft.update({ runId: id });
    setRun(null);
    setConfirmed(false);
  };
  const account = data!.accounts.find((a) => a.id === accountId);
  const busy = working || running;
  const pages = Math.max(1, Math.ceil((run?.items.length ?? 0) / 25)),
    safePage = Math.min(page, pages);
  return (
    <div className="batch-insertion">
      <Notice>
        只向选定的本人目录插入素材，不扩散到子目录。同名项跳过；不会覆盖、删除、自动建链或发布。已有分享若按文件列表创建，新插入素材需要重新纳入分享。
      </Notice>
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
      <QueryError error={materials.error} onRetry={materials.reload} />
      <InsertionMaterials
        workspace={data!.dataPath}
        materials={materials.data ?? []}
        libraryState={
          materials.error
            ? "error"
            : materials.loading && !materials.data
              ? "loading"
              : "ready"
        }
        selected={materialIds}
        disabled={!!busy}
        onChanged={() => setRevision((n) => n + 1)}
        onSelect={(id, checked) => {
          draft.update({
            materialIds: updateSelection(materialIds, [id], checked).slice(
              0,
              10,
            ),
          });
          setConfirmed(false);
        }}
      />
      <Panel
        title="2 · 选择目标目录"
        extra={<small>已选 {targets.length} / 100 个目录</small>}
      >
        <div className="field-pair">
          <Field label="目标来源">
            <Select
              aria-label="插入目标来源"
              value={source}
              onValueChange={setSource}
              items={[
                { value: "managed", label: "项目已转存资料" },
                { value: "drive", label: "浏览本人网盘" },
              ]}
            />
          </Field>
          {source === "managed" ? (
            <Field label="查找已转存资料">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="按资料标题筛选，最多显示最近 200 份"
              />
            </Field>
          ) : (
            <Field label="网盘账号">
              <Select
                aria-label="浏览插入账号"
                value={accountId}
                onValueChange={setAccountId}
                items={[
                  { value: "", label: "选择已核验的本人账号" },
                  ...data!.accounts
                    .filter(
                      (a) => a.enabled && a.uid && a.status === "connected",
                    )
                    .map((a) => ({ value: a.id, label: a.alias })),
                ]}
              />
            </Field>
          )}
        </div>
        {source === "managed" ? (
          <>
            <QueryError error={candidates.error} onRetry={candidates.reload} />
            {candidates.loading && !candidates.data ? (
              <p>正在读取已转存资料…</p>
            ) : candidates.data?.length === 0 ? (
              <Empty title="暂无可显示内容">
                {query
                  ? "没有匹配的资料"
                  : "暂无已转存资料，可切换到浏览本人网盘。"}
              </Empty>
            ) : null}
            <div className="insertion-target-list">
              {candidates.data?.map((c) => (
                <label key={c.copyId}>
                  <input
                    type="checkbox"
                    disabled={!!busy}
                    checked={targets.some(
                      (t) =>
                        t.accountId === c.accountId &&
                        t.folderId === c.folderId,
                    )}
                    onChange={(e) => mutateTargets(c, e.target.checked)}
                  />
                  <span>
                    {c.title}
                    <small>
                      {c.account} · {c.path}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : account ? (
          <DirectoryPicker
            accountId={account.id}
            baidu={account.provider === "baidu"}
            targets={targets}
            onToggle={(t, c) => {
              if (!busy) mutateTargets(t, c);
            }}
          />
        ) : (
          <Empty title="暂无可显示内容">
            选择账号后，展开目录并勾选插入位置。
          </Empty>
        )}
        {targets.length ? (
          <div className="insertion-selected">
            <strong>已选择的插入位置</strong>
            {targets.map((t) => (
              <div key={t.accountId + ":" + t.folderId}>
                <span>
                  {data!.accounts.find((a) => a.id === t.accountId)?.alias ??
                    "账号已移除"}{" "}
                  · {t.path}
                </span>
                <Button
                  quiet
                  disabled={!!busy}
                  onClick={() => mutateTargets(t, false)}
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="actions">
          <Button
            primary
            disabled={
              !!busy ||
              !targets.length ||
              !materialIds.length ||
              !!materials.error
            }
            onClick={() => void preview()}
          >
            {working ? "正在核对账号与目录…" : "预检插入明细"}
          </Button>
          <small>
            预检只读取目录，不创建文件。每个素材会插入每个选定目录。
          </small>
        </div>
      </Panel>
      <Panel
        title="3 · 确认与执行"
        extra={
          <Select
            aria-label="插入处理记录"
            value={runId}
            onValueChange={chooseRun}
            items={[
              { value: "", label: "选择历史记录" },
              ...(history.data ?? []).map((r) => ({
                value: r.id,
                label: `${new Date(r.createdAt).toLocaleString()} · ${r.count} 项`,
              })),
            ]}
          />
        }
      >
        <QueryError error={history.error} onRetry={history.reload} />
        <QueryError
          error={runQuery.error}
          onRetry={() => setRevision((n) => n + 1)}
        />
        {run ? (
          <>
            <div className="insertion-summary">
              <strong>
                {run.state === "preview"
                  ? "待确认预览"
                  : run.state === "running"
                    ? "正在执行"
                    : run.state === "interrupted"
                      ? "已中断 · 请核对"
                      : "处理已结束"}
              </strong>
              <span>
                共 {run.items.length} 项 · 已插入{" "}
                {run.items.filter((i) => i.state === "success").length} · 跳过{" "}
                {run.items.filter((i) => i.state === "skipped").length} · 待核对{" "}
                {run.items.filter((i) => i.state === "uncertain").length}
              </span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>账号与目录</th>
                    <th>插入素材</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {run.items
                    .slice((safePage - 1) * 25, safePage * 25)
                    .map((i) => (
                      <tr key={i.id}>
                        <td>
                          <strong>{i.account}</strong>
                          <small className="table-note">{i.target.path}</small>
                        </td>
                        <td>
                          {i.material.name}
                          <small className="table-note">
                            {i.material.kind === "folder"
                              ? "文件夹"
                              : i.material.kind === "txt"
                                ? "TXT"
                                : "图片"}
                          </small>
                        </td>
                        <td>
                          <strong
                            className={
                              i.state === "uncertain" || i.state === "failed"
                                ? "insertion-result-warning"
                                : ""
                            }
                          >
                            {stateNames[i.state]}
                          </strong>
                          <small className="table-note">{i.message}</small>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={safePage}
              pageSize={25}
              total={run.items.length}
              onPageChange={setPage}
              label="插入明细分页"
            />
            {run.state === "preview" ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已核对上方目录和素材，确认有权向这些本人目录插入内容。
              </label>
            ) : null}
            <div className="actions">
              {run.state === "preview" ? (
                <Button
                  primary
                  disabled={
                    !confirmed ||
                    working ||
                    !!runQuery.error ||
                    !run.items.some((i) => i.state === "pending")
                  }
                  onClick={async () => {
                    setWorking(true);
                    setConfirmed(false);
                    try {
                      const r = await command(
                        "insertion.start",
                        { id: run.id, confirmed: true },
                        "插入任务已启动",
                      );
                      if (r) {
                        setRun(r);
                        setRevision((n) => n + 1);
                      }
                    } finally {
                      setWorking(false);
                    }
                  }}
                >
                  开始插入{" "}
                  {run.items.filter((i) => i.state === "pending").length} 项
                </Button>
              ) : null}
              {run.state === "preview" || running ? (
                <Button
                  disabled={working}
                  onClick={async () => {
                    if (
                      await command(
                        "insertion.cancel",
                        { id: run.id },
                        "已停止后续项，已提交项仍需等待结果",
                      )
                    )
                      setRevision((n) => n + 1);
                  }}
                >
                  停止后续项
                </Button>
              ) : null}
              {run.items.some((i) => i.state === "uncertain") && !running ? (
                <Button
                  disabled={working}
                  onClick={async () => {
                    setWorking(true);
                    try {
                      const r = await command("insertion.recheck", {
                        id: run.id,
                      });
                      if (r) {
                        setRun(r);
                        notify("已读取远端目录核对，未重复写入。", "info");
                      }
                    } finally {
                      setWorking(false);
                    }
                  }}
                >
                  只读核对待确认项
                </Button>
              ) : null}
              <Button
                disabled={working}
                onClick={() => void command("insertion.export", { id: run.id })}
              >
                导出结果 CSV
              </Button>
            </div>
            {run.items.some((i) => i.state === "uncertain") ? (
              <Notice warning>
                待核对项不会自动重试。请先在网盘官方页面核对内容，再决定是否重新创建批次。
              </Notice>
            ) : null}
          </>
        ) : (
          <Empty title="暂无可显示内容">
            完成预检后，在这里确认插入位置和素材。
          </Empty>
        )}
      </Panel>
    </div>
  );
}
