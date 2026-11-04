import { useState } from "react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import {
  pipixRequestPolicy,
  type PipixRequestUsage,
} from "../../shared/pipix-acquisition";
import { useAppActions } from "../state";
import { Button, Field, LoadingState, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import "./request-policy.css";

function PolicyEditor({
  data,
  onSaved,
}: {
  data: PipixRequestUsage;
  onSaved(): void;
}) {
  const [value, setValue] = useState(data.policy),
    [terms, setTerms] = useState(data.policy.excludedCommentTerms.join("，")),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { notify } = useAppActions();
  const fields = [
    ["dailyRequests", "每日新请求上限", 0, 10000],
    ["requestsPerRun", "每轮新请求上限", 1, 100],
    ["listPagesPerRun", "每轮列表页上限", 0, 20],
    ["commentPagesPerItem", "每帖评论页上限", 0, 20],
    ["itemsPerRun", "每轮素材数", 1, 20],
  ] as const;
  const policy = {
    ...value,
    excludedCommentTerms: terms
      .split(/[,，、;；\n]+/)
      .map((term) => term.trim())
      .filter(Boolean),
  };
  return (
    <div className="pipix-request-policy">
      <p className="muted">
        今日已发出 {data.usedToday} 次，剩余 {data.remainingToday}{" "}
        次。缓存不计次数；失败、超时和未知结果占用已发出的请求。保存上限不启动采集。
      </p>
      <div className="fields field-pair">
        {fields.map(([key, label, min, max]) => (
          <Field label={label} key={key}>
            <input
              aria-label={label}
              type="number"
              min={min}
              max={max}
              value={value[key]}
              disabled={busy}
              onChange={(event) =>
                setValue((old) => ({
                  ...old,
                  [key]: Number(event.target.value),
                }))
              }
            />
          </Field>
        ))}
      </div>
      <Field
        label="评论使用过滤词 · 用逗号分开"
        hint="正文或作者称呼命中时整条排除；原始响应与索引保留。"
      >
        <input
          aria-label="评论使用过滤词"
          value={terms}
          disabled={busy}
          onChange={(event) => setTerms(event.target.value)}
        />
      </Field>
      {error ? <Notice danger>{error}</Notice> : null}
      <Button
        size="compact"
        disabled={
          busy || JSON.stringify(policy) === JSON.stringify(data.policy)
        }
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await ipc(
              "pipix.saveRequestPolicy",
              pipixRequestPolicy.parse(policy),
            );
            notify(
              "请求上限已保存，尚未发起采集；旧补料授权在下一请求前停止",
              "success",
            );
            onSaved();
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : "保存失败，请重试",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "保存中…" : "保存采集规则"}
      </Button>
      <Button
        size="compact"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const result = await ipc("pipix.checkConnection");
            notify(
              `数据源网络返回HTTP ${result.status}；本次未使用Key或计费接口`,
              result.status === 200 ? "success" : "warning",
            );
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "网络检查失败");
          } finally {
            setBusy(false);
          }
        }}
      >
        检查数据源网络 · 不计费
      </Button>
      <small>
        上限按接口次数控制，金额以服务商结算为准。每页完整归档；界面每页数量和编辑快照50条限制不截断入库。每日设为0可禁止新增请求。
      </small>
    </div>
  );
}
export function PipixRequestPolicySettings() {
  const query = useIpcQuery("pipix.requestPolicy", undefined, {
    keepPrevious: true,
  });
  return (
    <>
      <h3>采集请求上限</h3>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {query.data ? (
        <PolicyEditor
          key={JSON.stringify(query.data.policy)}
          data={query.data}
          onSaved={query.reload}
        />
      ) : !query.error ? (
        <LoadingState compact label="正在读取请求上限…" />
      ) : null}
    </>
  );
}
