import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Upload,
  Send,
} from "lucide-react";
import {
  weiboContentIssue,
  weiboDeliveryOptions,
  weiboPostText,
  weiboReceiptUrl,
  type WeiboMarketingDetail,
} from "../../shared/weibo-marketing";
import { canUseLinkPosition } from "../../shared/publication";
import { hasVerifiedFormat } from "../../shared/channels";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useDraftDeliveryStatus } from "../publication/useDraftDeliveryStatus";
import { useIpcQuery } from "../api/useIpcQuery";
import { QueryError } from "../ui/QueryError";
import { formatTime } from "../lib/format";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";

export function WeiboDelivery({ detail }: { detail: WeiboMarketingDetail }) {
  const { run, draft, hasCover } = detail;
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity(),
    { navigate } = useAppNavigation();
  const accounts = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
    refreshInterval: 3000,
  });
  const weiboAccounts = (accounts.data ?? []).filter(
    (account) => account.provider === "weibo",
  );
  const bindings = data!.bindings.filter(
    (binding) => binding.platform === "weibo" && binding.websiteAccountId,
  );
  const form = useLocalDraft(
    `panxu-weibo-delivery-v1:${data!.dataPath}:${run.id}`,
    run.options ?? {
      accountId: "",
      bindingId: "",
      uid: "",
      includeLink: false,
      artwork: hasCover ? ("cover" as const) : ("creative" as const),
      visibility: "public" as const,
    },
    (raw) =>
      weiboDeliveryOptions.extend({ uid: z.string().max(20) }).parse(raw),
  );
  const options = form.value;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [failure, setFailure] = useState("");
  const working = useDraftDeliveryStatus(draft);
  const binding = bindings.find((item) => item.id === options.bindingId);
  const account = weiboAccounts.find((item) => item.id === options.accountId);
  const accountReady =
    !!account &&
    account.status === "connected" &&
    account.uid === options.uid &&
    !accounts.error &&
    !account.checking;
  const locked = [
    "filled",
    "submitting",
    "uncertain",
    "handoff",
    "submitted",
    "published",
  ].includes(run.stage);
  const dirty = JSON.stringify(options) !== JSON.stringify(run.options);
  const issue = weiboContentIssue(draft);
  const linkReady =
    !!binding && canUseLinkPosition("weibo", binding, "shortpost", "body");
  const prepare = async () => {
    const parsed = weiboDeliveryOptions.safeParse(options);
    if (!parsed.success) {
      setFailure(parsed.error.issues[0].message);
      return;
    }
    setFailure("");
    form.update(parsed.data);
    const saved = await command("weibo.configure", {
      id: run.id,
      options: parsed.data,
    });
    if (saved && alive.current) await command("weibo.prepare", { id: run.id });
  };
  return (
    <Panel
      title="准备图文与发布账号"
      extra={
        <Button quiet onClick={() => navigate("website-accounts")}>
          管理微博账号
        </Button>
      }
    >
      <div className="field-pair">
        <Field label="微博账号" as="div" required>
          <Select
            aria-label="微博发布账号"
            value={options.accountId}
            disabled={busy > 0 || locked}
            items={[
              {
                value: "",
                label:
                  accounts.loading && !accounts.data
                    ? "正在读取微博账号…"
                    : "选择其他账号中已登录的微博",
                disabled: true,
              },
              ...weiboAccounts.map((item) => ({
                value: item.id,
                label: `${item.nickname || item.alias}${item.uid ? ` · ${item.uid}` : ""}${item.status === "connected" ? "" : " · 需登录核实"}`,
                disabled: item.status !== "connected" || !!item.checking,
              })),
            ]}
            onValueChange={(accountId) => {
              const selected = weiboAccounts.find(
                (item) => item.id === accountId,
              );
              form.update({
                accountId,
                bindingId: selected?.publishing?.bindingId ?? "",
                uid: selected?.uid ?? "",
                includeLink: false,
              });
            }}
          />
        </Field>
        <Field
          label="已识别身份"
          as="div"
          hint="来自官方登录会话，交接前再次核对"
        >
          <div className="weibo-account-summary">
            {account
              ? `${account.nickname || account.alias} · UID ${account.uid || "待识别"}`
              : options.uid
                ? `原任务 UID ${options.uid} · 请关联其他账号`
                : "选择已登录账号后显示昵称和 UID"}
          </div>
        </Field>
      </div>
      <QueryError
        error={accounts.error}
        loading={accounts.loading}
        onRetry={accounts.reload}
        title="微博账号读取失败"
      />
      {accounts.data && !accounts.error && !weiboAccounts.length ? (
        <Notice warning>
          还没有微博账号。请到“账号管理 →
          其他账号”选择微博，完成官方扫码登录并核实发布能力。
        </Notice>
      ) : account && !accountReady && !accounts.error ? (
        <Notice warning>{account.message} 请到其他账号检查登录后继续。</Notice>
      ) : null}
      {account?.checkedAt ? (
        <small className="muted">
          上次身份核实：{formatTime(account.checkedAt)}
        </small>
      ) : null}
      <Field label="配图来源" as="div">
        <Select
          aria-label="微博配图来源"
          value={options.artwork}
          disabled={busy > 0 || locked}
          items={[
            {
              value: "cover",
              label: hasCover ? "使用资源封面" : "使用资源封面（尚未添加）",
            },
            { value: "creative", label: "使用当前稿件已生成的图片／组图" },
          ]}
          onValueChange={(artwork) =>
            form.update({ artwork: artwork as "cover" | "creative" })
          }
        />
      </Field>
      <Field label="微博可见范围" as="div">
        <Select
          aria-label="图文微博可见范围"
          value={options.visibility ?? "public"}
          disabled={busy > 0 || locked}
          items={[
            { value: "public", label: "公开" },
            { value: "self", label: "仅自己可见" },
          ]}
          onValueChange={(visibility) =>
            form.update({ visibility: visibility as "public" | "self" })
          }
        />
      </Field>
      <label className="checkbox weibo-option">
        <input
          type="checkbox"
          checked={options.includeLink}
          disabled={busy > 0 || locked || (!linkReady && !options.includeLink)}
          onChange={(event) =>
            form.update({ includeLink: event.target.checked })
          }
        />
        在正文附加本人分享链接与提取码
      </label>
      {!linkReady ? (
        <p className="muted">
          此账号尚未核实正文网盘链接权限，或核实记录已过期。需要链接时，在其他账号的“发布能力”中核实。
        </p>
      ) : null}
      {!binding || !hasVerifiedFormat(binding, "shortpost") ? (
        <Notice warning>
          请选择微博账号，并在其他账号的“发布能力”中核实图文发布能力。
        </Notice>
      ) : null}
      {!locked && (issue || working.blocked || !draft.reviewed) ? (
        <p className="weibo-readiness">
          {issue ??
            (working.error
              ? `编辑暂存读取失败：${working.error}`
              : working.blocked
                ? "当前修改尚未保存，请先保存并重新审阅。"
                : "完成当前文案和图片的人工审阅后，再准备图文包。")}
        </p>
      ) : null}
      {form.error || failure ? (
        <Notice warning>{form.error || failure}</Notice>
      ) : null}
      {!locked ? (
        <div className="row weibo-actions">
          <Button
            primary
            disabled={
              busy > 0 ||
              working.blocked ||
              !!issue ||
              !draft.reviewed ||
              !binding ||
              !accountReady ||
              !hasVerifiedFormat(binding, "shortpost")
            }
            onClick={() => void prepare()}
          >
            <Download size={15} />
            核验并导出图文包
          </Button>
          <small>选择保存目录，导出文案、1–9 张图片及清单。</small>
        </div>
      ) : null}
      {run.prepared ? (
        <div className="weibo-prepared" aria-label="已准备的微博图文">
          <div className="row spread">
            <strong>已准备 {run.prepared.images.length} 张图片</strong>
            <small>
              {Array.from(run.prepared.text).length} 字符 · 实际交付版本
            </small>
          </div>
          <div
            className="weibo-post-preview"
            role="region"
            aria-label="实际交付微博文案"
            tabIndex={0}
          >
            {run.prepared.text}
          </div>
          <p className="muted">图片：{run.prepared.images.join("、")}</p>
          <div className="row">
            <Button
              disabled={busy > 0}
              onClick={() => void command("weibo.openFolder", { id: run.id })}
            >
              <FolderOpen size={15} />
              打开图片目录
            </Button>
            {["ready", "filled"].includes(run.stage) ? (
              <Button
                primary
                disabled={
                  busy > 0 ||
                  (run.stage === "ready" && dirty) ||
                  working.blocked ||
                  !accountReady
                }
                onClick={() => void command("weibo.fill", { id: run.id })}
              >
                <Upload size={15} />
                {run.stage === "filled"
                  ? "检查已填写的图文"
                  : "自动填写并上传图片"}
              </Button>
            ) : null}
            {["ready", "handoff"].includes(run.stage) ? (
              <Button
                primary
                disabled={
                  busy > 0 ||
                  (run.stage === "ready" && dirty) ||
                  working.blocked ||
                  !accountReady
                }
                onClick={() => void command("weibo.handoff", { id: run.id })}
              >
                <Copy size={15} />
                <ExternalLink size={15} />
                {run.stage === "handoff"
                  ? "重新复制并打开窗口"
                  : "复制文案并打开微博"}
              </Button>
            ) : null}
          </div>
          {run.stage === "filled" ? (
            <Button
              primary
              disabled={
                busy > 0 || !accountReady || working.blocked || !draft.reviewed
              }
              onClick={() => {
                void command("weibo.submit", { id: run.id, confirmed: true });
              }}
            >
              <Send size={15} />
              发布到微博
            </Button>
          ) : null}
          {run.stage === "ready" && dirty ? (
            <Notice warning>发布设置已有修改，请重新准备后再交接。</Notice>
          ) : null}
          <p className="weibo-handoff-note">
            自动填写会使用该账号的官方发布器上传图片；核对后点击“发布到微博”，提交回执与单条链接会自动保存。遇到安全验证请在官方窗口完成；回执不明时先核对结果，避免重复发布。也可继续使用复制文案的人工交接方式。
          </p>
        </div>
      ) : (
        <details className="weibo-local-preview">
          <summary>查看已保存文案预览</summary>
          <div className="weibo-post-preview">{weiboPostText(draft)}</div>
          <small>此处尚未附加分享链接；准备后显示实际交付文案。</small>
        </details>
      )}
    </Panel>
  );
}

export function WeiboReceipt({ detail }: { detail: WeiboMarketingDetail }) {
  const { run, draft } = detail;
  const { command } = useAppActions(),
    { busy } = useAppActivity(),
    { openSearch, openDraft } = useAppNavigation();
  const [url, setUrl] = useState(run.url ?? "");
  useEffect(() => {
    setUrl(run.url ?? "");
  }, [run.id, run.url, run.stage]);
  if (
    !["filled", "uncertain", "handoff", "submitted", "published"].includes(
      run.stage,
    )
  )
    return null;
  let urlIssue = "";
  if (url.trim()) {
    try {
      weiboReceiptUrl(url.trim(), run.prepared!.uid);
    } catch (error) {
      urlIssue = (error as Error).message;
    }
  }
  const resolve = (result: "submitted" | "published" | "not_submitted") => {
    void command("weibo.resolve", {
      id: run.id,
      result,
      url: url.trim(),
      confirmed: true,
    });
  };
  return (
    <Panel
      title="回填发布结果"
      extra={
        <small>{run.stage === "handoff" ? "尚无发布回执" : "回执已保存"}</small>
      }
    >
      <p className="muted">
        从单条微博发布时间进入详情，复制桌面版链接。作者 UID 必须为{" "}
        {run.prepared!.uid}；主页链接不能作为发布回执。
      </p>
      <Field label="单条微博链接">
        <input
          aria-label="微博发布回执链接"
          type="url"
          value={url}
          maxLength={2000}
          disabled={busy > 0 || !!run.url}
          placeholder={`https://weibo.com/${run.prepared!.uid}/微博ID`}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      {urlIssue ? (
        <p role="alert" className="weibo-readiness">
          {urlIssue}
        </p>
      ) : null}
      {run.url ? (
        <Button
          quiet
          onClick={() => void command("weibo.openReceipt", { id: run.id })}
        >
          <ExternalLink size={14} />
          查看这条微博
        </Button>
      ) : null}
      <div className="row weibo-actions">
        {run.stage !== "published" ? (
          <Button
            disabled={busy > 0 || !url.trim() || !!urlIssue}
            onClick={() => resolve("submitted")}
          >
            登记已提交 · 待核对
          </Button>
        ) : null}
        {run.options?.visibility !== "self" ? (
          <Button
            primary
            disabled={busy > 0 || !url.trim() || !!urlIssue}
            onClick={() => resolve("published")}
          >
            {run.stage === "published"
              ? "重新同步公开回执"
              : "确认已公开并同步记录"}
          </Button>
        ) : null}
        {["filled", "uncertain", "handoff"].includes(run.stage) ? (
          <Button
            quiet
            disabled={busy > 0 || !!url.trim()}
            onClick={() => resolve("not_submitted")}
          >
            确认尚未发布，返回编辑
          </Button>
        ) : null}
      </div>
      <div className="row weibo-actions">
        <Button quiet onClick={() => openSearch({ topicId: run.topicId })}>
          查看选题与效果
        </Button>
        <Button quiet onClick={() => openDraft(draft, "publish")}>
          查看发布记录与资料入口验收
        </Button>
      </div>
    </Panel>
  );
}
