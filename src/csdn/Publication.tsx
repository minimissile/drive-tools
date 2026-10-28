import { useEffect, useState } from "react";
import { ExternalLink, Send } from "lucide-react";
import {
  csdnPublicationOptions,
  csdnPublicationIssue,
  type CsdnWorkflowDetail,
} from "../../shared/csdn-workflow";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useDraftDeliveryStatus } from "../publication/useDraftDeliveryStatus";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";
import { hasVerifiedFormat } from "../../shared/channels";
import { csdnHandoff } from "../../shared/csdn";

export function CsdnPublication({ detail }: { detail: CsdnWorkflowDetail }) {
  const { run, draft } = detail;
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity(),
    { openSettings } = useAppNavigation();
  const bindings = data!.bindings.filter(
    (binding) => binding.platform === "csdn",
  );
  const defaults = run.options ?? {
    bindingId: bindings[0]?.id ?? "",
    author: "",
    summary: draft ? csdnHandoff(draft).summary : "",
    includeLink: false,
  };
  const form = useLocalDraft(
    `panxu-csdn-publication-v1:${data!.dataPath}:${run.id}`,
    defaults,
    (raw) => csdnPublicationOptions.parse(raw),
  );
  const value = form.value;
  const optionsKey = JSON.stringify(value),
    storedKey = JSON.stringify(run.options);
  const dirty = optionsKey !== storedKey;
  const working = useDraftDeliveryStatus(draft ?? undefined);
  const [optionError, setOptionError] = useState("");
  const final = ["submitted", "published", "uncertain"].includes(run.stage);
  const binding = bindings.find((binding) => binding.id === value.bindingId);
  const issue = draft ? csdnPublicationIssue(draft) : null;
  const disabled = busy > 0 || final;
  const prepare = async () => {
    const result = csdnPublicationOptions.safeParse(value);
    if (!result.success) {
      setOptionError(result.error.issues[0].message);
      return;
    }
    setOptionError("");
    const saved = await command("csdn.configure", {
      id: run.id,
      options: result.data,
    });
    if (saved) await command("csdn.prepare", { id: run.id });
  };
  return (
    <Panel
      title="自动填写与提交"
      extra={
        <Button quiet onClick={() => openSettings("bindings")}>
          配置发布窗口
        </Button>
      }
    >
      {run.stage === "attention" ? (
        <div role="status">
          <Notice warning>{run.message}</Notice>
        </div>
      ) : null}
      <div className="field-pair">
        <Field label="CSDN 发布窗口" as="div" required>
          <Select
            aria-label="CSDN 发布窗口"
            disabled={disabled}
            value={value.bindingId}
            items={[
              { value: "", label: "请选择 CSDN 窗口", disabled: true },
              ...bindings.map((binding) => ({
                value: binding.id,
                label: binding.alias,
              })),
            ]}
            onValueChange={(bindingId) => form.update({ bindingId })}
          />
        </Field>
        <Field
          label="CSDN 用户名"
          required
          hint="个人主页地址中 blog.csdn.net/ 后的一段"
        >
          <input
            aria-label="CSDN 用户名"
            value={value.author}
            maxLength={100}
            disabled={disabled}
            onChange={(e) => form.update({ author: e.target.value })}
            placeholder="例如：missile_web3；不是昵称"
          />
        </Field>
      </div>
      <Field label="文章摘要" hint="最多200字；留空时从当前正文提取">
        <textarea
          aria-label="CSDN 文章摘要"
          value={value.summary}
          maxLength={200}
          disabled={disabled}
          onChange={(e) => form.update({ summary: e.target.value })}
        />
      </Field>
      <label className="checkbox csdn-option">
        <input
          type="checkbox"
          checked={value.includeLink}
          disabled={disabled}
          onChange={(e) => form.update({ includeLink: e.target.checked })}
        />
        在已核实允许的正文位置附加本人分享与提取码
      </label>
      <p className="muted">
        正文已有本人链接时可不附加。会复核资料、当前稿件和窗口账号，设置为原创、全部可见，并按稿件来源填写
        AI 辅助声明。
      </p>
      {!binding || !hasVerifiedFormat(binding, "article") ? (
        <Notice warning>
          请先在发布窗口设置中核实该账号的文章发布能力与链接使用场景。
        </Notice>
      ) : null}
      {issue || working.blocked || !draft?.reviewed ? (
        <Notice warning>
          {issue ??
            (working.error
              ? `暂存读取失败：${working.error}`
              : working.blocked
                ? "请先保存当前编辑，或在编辑区恢复已保存版本。"
                : "请先完成人工审阅，再自动填写。")}
        </Notice>
      ) : null}
      {form.error || optionError ? (
        <Notice warning>{form.error || optionError}</Notice>
      ) : null}
      <div className="row csdn-actions">
        <Button
          primary
          disabled={
            disabled ||
            !draft?.reviewed ||
            working.blocked ||
            !!issue ||
            !binding
          }
          onClick={() => void prepare()}
        >
          {run.stage === "ready" ? "重新核验并填写" : "核验并自动填写"}
        </Button>
        <Button
          disabled={busy > 0 || !run.options}
          onClick={() => void command("csdn.inspect", { id: run.id })}
        >
          <ExternalLink size={14} />
          打开任务窗口
        </Button>
      </div>
      {run.stage === "ready" && !dirty ? (
        <div className="csdn-submit-area">
          <Button
            primary
            disabled={busy > 0 || working.blocked || !draft?.reviewed}
            onClick={() => {
              void command("csdn.submit", { id: run.id, confirmed: true });
            }}
          >
            <Send size={15} />
            提交当前文章到 CSDN
          </Button>
          <small>扫码或验证码需要本人完成；结果不明时暂停核对。</small>
        </div>
      ) : run.stage === "ready" && dirty ? (
        <Notice warning>发布设置有修改，请重新核验并填写后再提交。</Notice>
      ) : null}
    </Panel>
  );
}

export function CsdnReceipt({ detail }: { detail: CsdnWorkflowDetail }) {
  const { run, draft } = detail;
  const { command } = useAppActions(),
    { busy } = useAppActivity(),
    { openDraft, openSearch } = useAppNavigation();
  const [url, setUrl] = useState(run.url ?? "");
  useEffect(() => {
    setUrl(run.url ?? "");
  }, [run.id, run.url, run.stage]);
  if (!["submitted", "published", "uncertain"].includes(run.stage)) return null;
  const resolve = (result: "submitted" | "published" | "not_submitted") => {
    void command("csdn.resolve", {
      id: run.id,
      result,
      url: url.trim(),
      confirmed: true,
    });
  };
  return (
    <Panel
      title="发布回执与结果核对"
      extra={
        <small>
          {run.stage === "uncertain" ? "自动重发已阻止" : "回执已保存"}
        </small>
      }
    >
      <Notice warning={run.stage !== "published"}>
        {run.stage === "uncertain"
          ? "提交可能已生效，请先在原 CSDN 窗口或文章管理中核对。明确没有提交后，才可重新填写并提交。"
          : run.stage === "published"
            ? "文章已确认公开。资料是否可获取，请继续在发布记录中验收。"
            : "已取得文章地址并记录待审核。请以 CSDN 后台及文章公开状态为准。"}
      </Notice>
      <Field label="实际文章地址">
        <input
          aria-label="CSDN 回执地址"
          type="url"
          value={url}
          maxLength={2000}
          disabled={!!run.url || busy > 0}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://blog.csdn.net/用户名/article/details/文章ID"
        />
      </Field>
      {url ? (
        <Button quiet onClick={() => void command("system.external", { url })}>
          <ExternalLink size={14} />
          查看文章
        </Button>
      ) : null}
      {run.stage !== "published" ? (
        <>
          <div className="row">
            <Button
              disabled={!url.trim() || busy > 0}
              onClick={() => resolve("submitted")}
            >
              {run.stage === "uncertain"
                ? "登记已提交 · 待审核"
                : "同步待审核回执"}
            </Button>
            <Button
              disabled={!url.trim() || busy > 0}
              onClick={() => resolve("published")}
            >
              确认文章已公开
            </Button>
            {run.stage === "uncertain" ? (
              <Button
                disabled={!!url.trim() || busy > 0}
                onClick={() => resolve("not_submitted")}
              >
                确认未提交，允许重新准备
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      <div className="row csdn-actions">
        <Button quiet onClick={() => openSearch({ topicId: run.topicId })}>
          查看选题与效果
        </Button>
        {draft ? (
          <Button quiet onClick={() => openDraft(draft, "publish")}>
            查看发布记录与资源入口验收
          </Button>
        ) : null}
      </div>
    </Panel>
  );
}
