import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { PipixSource } from "../../shared/pipix";
import {
  sourceMaterialBody,
  type ContentSourceExport,
} from "../../shared/content-sources";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppNavigation } from "../state";
import { Button, Field, LoadingState, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";

export function PipixExport({
  source,
  workspace,
  busy,
  onBusy,
  reload,
  title,
  onTitle,
  imageIds,
  commentIds,
  unavailable,
  storageError,
  onOpenWeibo,
}: {
  source: PipixSource;
  workspace: string;
  busy: boolean;
  onBusy(busy: boolean): void;
  reload(): void;
  title: string;
  onTitle(title: string): void;
  imageIds: string[];
  commentIds: string[];
  unavailable: boolean;
  storageError: string;
  onOpenWeibo(account: WebsiteAccountView, postId: string): void;
}) {
  const { notify } = useAppActions(),
    { navigate } = useAppNavigation();
  const target = useLocalDraft(
    `panxu-pipix-target-v1:${workspace}:${source.id}`,
    { channel: "zhihu" as "zhihu" | "weibo", accountId: "" },
    (raw) =>
      z
        .object({ channel: z.enum(["zhihu", "weibo"]), accountId: z.string() })
        .parse(raw),
  );
  const accounts = useIpcQuery("websiteAccounts.list", undefined, {
    enabled: target.value.channel === "weibo",
    keepPrevious: true,
  });
  const [error, setError] = useState(""),
    [localExports, setLocalExports] = useState<ContentSourceExport[]>([]);
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const channel = target.value.channel,
    accountId = channel === "weibo" ? target.value.accountId : "";
  const account = accounts.data?.find(
    (v) => v.id === accountId && v.provider === "weibo",
  );
  const deliveries = [
    ...source.exports,
    ...localExports.filter((v) => !source.exports.some((s) => s.id === v.id)),
  ];
  const existing = deliveries.find(
    (v) => v.channel === channel && v.accountId === accountId,
  );
  const body = sourceMaterialBody(
    source.text,
    source.author,
    source.comments.filter((v) => commentIds.includes(v.id)),
  );
  const textTooLong = channel === "weibo" && body.length > 2000;
  const open = (delivery: ContentSourceExport) => {
    if (delivery.channel === "zhihu") navigate("zhihu-operations");
    else {
      const owner = accounts.data?.find((v) => v.id === delivery.accountId);
      if (owner) onOpenWeibo(owner, delivery.targetId);
    }
  };
  const deliver = async () => {
    if (lock.current) return;
    lock.current = true;
    onBusy(true);
    setError("");
    try {
      const result = await ipc("pipix.export", {
        id: source.id,
        title,
        imageIds,
        commentIds,
        channel,
        accountId: accountId || undefined,
      });
      if (alive.current) {
        setLocalExports((v) => [
          ...v.filter((s) => s.id !== result.delivery.id),
          result.delivery,
        ]);
        reload();
      }
      notify(
        result.existing
          ? "已保留原有渠道草稿，可继续编辑"
          : channel === "zhihu"
            ? "已送入知乎待审核素材池"
            : "微博本地草稿已创建，尚未上传或发布",
        "success",
      );
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "未能创建渠道草稿，请重试。");
    } finally {
      lock.current = false;
      if (alive.current) onBusy(false);
    }
  };
  return (
    <div className="pipix-import-actions">
      <h3>用于渠道草稿</h3>
      <div className="pipix-target-fields">
        <Field label="目标渠道">
          <Select
            aria-label="目标渠道"
            disabled={busy}
            value={channel}
            items={[
              { value: "zhihu", label: "知乎素材池" },
              { value: "weibo", label: "微博草稿" },
            ]}
            onValueChange={(v) => {
              target.update({ channel: v as "zhihu" | "weibo" });
              setError("");
            }}
          />
        </Field>
        {channel === "weibo" ? (
          <Field label="微博账号">
            <Select
              aria-label="微博账号"
              disabled={busy || !accounts.data}
              value={accountId}
              items={[
                { value: "", label: "请选择微博账号" },
                ...(accounts.data ?? [])
                  .filter((v) => v.provider === "weibo")
                  .map((v) => ({
                    value: v.id,
                    label: `${v.nickname || v.alias}${v.status !== "connected" ? " · 需检查登录" : ""}`,
                  })),
              ]}
              onValueChange={(accountId) => {
                target.update({ accountId });
                setError("");
              }}
            />
          </Field>
        ) : null}
      </div>
      {channel === "weibo" ? (
        <>
          <QueryError
            error={accounts.error}
            loading={accounts.loading}
            onRetry={accounts.reload}
          />
          {!accounts.data && !accounts.error ? (
            <LoadingState compact label="正在读取微博账号…" />
          ) : null}
          {accounts.data &&
          !accounts.data.some((v) => v.provider === "weibo") ? (
            <Notice>
              还没有微博账号。
              <Button
                size="compact"
                onClick={() => navigate("website-accounts")}
              >
                管理账号
              </Button>
            </Notice>
          ) : null}
        </>
      ) : null}
      <Field label="素材标题">
        <input
          aria-label="素材标题"
          value={title}
          maxLength={100}
          disabled={busy}
          onChange={(e) => onTitle(e.target.value)}
        />
      </Field>
      <small>
        原帖文案 + {imageIds.length} 张图片 + {commentIds.length} 条评论。
        {channel === "weibo"
          ? `微博正文 ${body.length} / 2000 字符，默认仅自己可见。`
          : "进入知乎待审核素材池。"}{" "}
        保存草稿不会上传或发布。
      </small>
      {storageError || target.error ? (
        <Notice danger>{storageError || target.error}</Notice>
      ) : null}
      {unavailable ? (
        <Notice>选中的图片尚未采集成功，请重新采集或取消选择失败图片。</Notice>
      ) : null}
      {textTooLong ? (
        <Notice warning>
          所选文案与评论超过微博 2000 字符上限，请减少评论后再创建草稿。
        </Notice>
      ) : null}
      {error ? (
        <div role="alert">
          <Notice danger>{error} 选择已保留，可修正后重试。</Notice>
        </div>
      ) : null}
      {existing ? (
        <>
          <Notice>该去向已有草稿，重复操作会打开原草稿，保留后续编辑。</Notice>
          <Button
            primary
            disabled={busy || (channel === "weibo" && !account)}
            onClick={() => open(existing)}
          >
            打开{channel === "zhihu" ? "知乎运营" : "微博草稿"}
          </Button>
        </>
      ) : (
        <Button
          primary
          disabled={
            busy ||
            !title.trim() ||
            unavailable ||
            textTooLong ||
            (channel === "weibo" &&
              (!account || account.status !== "connected" || !!accounts.error))
          }
          onClick={() => void deliver()}
        >
          {busy
            ? "正在创建草稿…"
            : channel === "zhihu"
              ? "送入知乎素材池"
              : "创建微博草稿"}
        </Button>
      )}
      {deliveries.length ? (
        <div className="pipix-deliveries">
          <h3>已使用的去向</h3>
          {deliveries.map((v) => (
            <p key={v.id}>
              <strong>
                {v.channel === "zhihu" ? "知乎素材池" : "微博草稿"}
              </strong>
              {v.accountId
                ? ` · ${v.accountLabel || accounts.data?.find((a) => a.id === v.accountId)?.alias || `账号 ${v.accountId}`}`
                : ""}
              <span>{v.title}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
