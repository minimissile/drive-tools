import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ImagePlus, Send, Upload } from "lucide-react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData } from "../state";
import { Dialog } from "../ui/Dialog";
import { Button, Field, LoadingState, Notice } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import type { OtherAccount } from "./useOtherAccounts";
import type { WeiboPost } from "../../shared/weibo-posts";
import { WeiboStatistics } from "../weibo/Statistics";

const schema = z.object({
  id: z.string(),
  text: z.string().max(2000),
  visibility: z.enum(["public", "self"]),
});
const empty = { id: "", text: "", visibility: "self" as const };
export function WeiboComposer({
  account,
  onClose,
  initialPostId,
}: {
  account: OtherAccount;
  onClose(): void;
  initialPostId?: string;
}) {
  const { data } = useAppData();
  const form = useLocalDraft(
    `weibo-composer:${data!.dataPath}:${account.id}${initialPostId ? `:post:${initialPostId}` : ""}`,
    empty,
    (raw) => schema.parse(raw),
  );
  const history = useIpcQuery(
    "weiboPosts.list",
    { accountId: account.id },
    { keepPrevious: true },
  );
  const [post, setPost] = useState<WeiboPost | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [initialError, setInitialError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState("");
  const lock = useRef(false);
  const initialLoaded = useRef(false);
  useEffect(() => {
    if (!initialPostId || initialLoaded.current || !history.data) return;
    const selected = history.data.find(v => v.id === initialPostId);
    if (!selected) { setInitialError("此微博草稿暂未找到，请重新读取；如已删除，请返回采集页检查去向记录。"); return; }
    initialLoaded.current = true;
    setInitialError("");
    setPost(selected);
    if (!form.restored || form.value.id !== initialPostId)
      form.update({ id:selected.id, text:selected.text, visibility:selected.visibility });
  }, [initialPostId, history.data, form.restored, form.value.id, form.update]);
  const current =
    post ?? history.data?.find((item) => item.id === form.value.id) ?? null;
  const initializing = !!initialPostId && !initialLoaded.current;
  const locked = initializing || (!!current && !["editing", "attention"].includes(current.stage));
  const busy = !!pending;
  useEffect(() => {
    setConfirmed(false);
  }, [current?.stage]);
  const work = async (label: string, action: () => Promise<WeiboPost>) => {
    if (lock.current) return;
    lock.current = true;
    setPending(label);
    setError("");
    try {
      const result = await action();
      setPost(result);
      form.update({
        id: result.id,
        text: result.text,
        visibility: result.visibility,
      });
      setConfirmed(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "微博操作失败，请重试。",
      );
    } finally {
      lock.current = false;
      setPending("");
      history.reload();
    }
  };
  const save = () =>
    ipc("weiboPosts.save", {
      id: form.value.id || undefined,
      accountId: account.id,
      text: form.value.text,
      visibility: form.value.visibility,
    });
  const upload = () =>
    work("正在填写和上传…", async () => {
      const saved = locked && current ? current : await save();
      // Keep the id even if the subsequent operation is interrupted.
      setPost(saved);
      form.update({ id: saved.id });
      return ipc("weiboPosts.fill", { id: saved.id, confirmed: true });
    });
  return (
    <Dialog
      title="发布微博"
      onClose={onClose}
      busy={busy}
      className="weibo-composer-dialog"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            关闭
          </Button>
          {!locked ? <Button disabled={busy || history.loading || !!history.error || !form.value.text.trim()} onClick={()=>void work("正在保存草稿…", async()=>save())}>保存本地草稿</Button> : null}
          {current?.stage === "filled" ? (
            <Button disabled={busy} onClick={() => void upload()}>
              重新检查并填写
            </Button>
          ) : null}
          {current?.stage === "filled" ? (
            <Button
              primary
              disabled={busy || !confirmed}
              onClick={() =>
                void work("正在提交微博…", () =>
                  ipc("weiboPosts.submit", { id: current.id, confirmed: true }),
                )
              }
            >
              <Send size={15} />
              确认发布到微博
            </Button>
          ) : !locked ? (
            <Button
              primary
              disabled={
                busy ||
                !confirmed ||
                !form.value.text.trim() ||
                history.loading ||
                !!history.error
              }
              onClick={() => void upload()}
            >
              <Upload size={15} />
              自动填写并上传
            </Button>
          ) : null}
        </>
      }
    >
      <p>
        <strong>{account.nickname || account.alias}</strong> · UID {account.uid}
      </p>
      <p className="muted">
        直接使用已登录的官方网页，支持手写文案和 0–9 张本地图片，无需模型或付费
        API。网盘推广请从“微博图文营销”关联本人资料。
      </p>
      {current?.source ? <Notice>来源：皮皮虾 · {current.source.author}，包含 {current.source.comments.length} 条评论。<Button size="compact" onClick={()=>void ipc("system.external", {url:current.source!.url})}>查看原帖</Button></Notice> : null}
      <QueryError
        error={history.error || initialError}
        loading={history.loading}
        onRetry={() => {setInitialError(""); history.reload();}}
      />
      {initializing && history.loading ? <LoadingState compact label="正在定位指定微博草稿…" /> : null}
      {history.data?.length && !initialPostId ? (
        <Field label="本地微博草稿与回执" as="div">
          <Select
            aria-label="微博草稿与回执"
            disabled={busy}
            value={current?.id ?? ""}
            items={[
              { value: "", label: "新建微博" },
              ...history.data.map((item) => ({
                value: item.id,
                label: `${item.text.slice(0, 24)} · ${item.url ? "已提交" : item.stage === "filled" ? "已上传" : item.stage === "uncertain" ? "待核对" : "草稿"}`,
              })),
            ]}
            onValueChange={(id) => {
              const selected = history.data?.find((item) => item.id === id);
              setPost(selected ?? null);
              form.update(
                selected
                  ? {
                      id: selected.id,
                      text: selected.text,
                      visibility: selected.visibility,
                    }
                  : empty,
              );
              setConfirmed(false);
              setError("");
              setReceipt("");
            }}
          />
        </Field>
      ) : null}
      <Field
        label="微博文案"
        required
        hint={`${Array.from(form.value.text).length} / 2000 字符`}
      >
        <textarea
          aria-label="直接发布微博文案"
          rows={6}
          maxLength={2000}
          value={form.value.text}
          disabled={busy || locked}
          onChange={(event) => {
            form.update({ text: event.target.value });
            setConfirmed(false);
          }}
        />
      </Field>
      <Field label="可见范围" as="div">
        <Select
          aria-label="微博可见范围"
          value={form.value.visibility}
          disabled={busy || locked}
          items={[
            { value: "self", label: "仅自己可见（适合流程验证）" },
            { value: "public", label: "公开" },
          ]}
          onValueChange={(visibility) => {
            form.update({ visibility: visibility as "self" | "public" });
            setConfirmed(false);
          }}
        />
      </Field>
      <div className="row">
        <Button
          disabled={busy || locked || !form.value.text.trim()}
          onClick={() =>
            void work("正在选择图片…", async () => {
              const saved = await save();
              setPost(saved);
              form.update({ id: saved.id });
              return ipc("weiboPosts.images", { id: saved.id });
            })
          }
        >
          <ImagePlus size={15} />
          选择本地图片
        </Button>
        <small>
          {current?.images.length
            ? `${current.images.length} 张图片 · 再次选择可替换`
            : "未选择图片，可发布纯文字"}
        </small>
      </div>
      {current?.images.length ? (
        <p className="muted">
          {current.images
            .map((image) => image.name.split("/").pop())
            .join("、")}
        </p>
      ) : null}
      {current?.message ? (
        <Notice warning={["attention", "uncertain"].includes(current.stage)}>
          {current.message}
        </Notice>
      ) : null}
      {pending ? <p role="status">{pending}</p> : null}
      {error || form.error ? (
        <Notice danger>{error || form.error}</Notice>
      ) : null}
      {!locked || current?.stage === "filled" ? (
        <CheckboxField
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
          label={
            current?.stage === "filled"
              ? `我已核对官方窗口，确认以${form.value.visibility === "self" ? "仅自己可见" : "公开"}方式发布这条微博`
              : "我已核对文案、图片和可见范围，可以填写并上传到此微博账号"
          }
        />
      ) : null}
      {current?.url ? (
        <Button
          disabled={busy}
          onClick={() =>
            void work("正在打开微博回执…", async () => {
              await ipc("weiboPosts.open", { id: current.id });
              return current;
            })
          }
        >
          查看已提交的微博
        </Button>
      ) : null}
      {current?.url ? <section aria-label="已发布微博数据"><h3>数据统计</h3><WeiboStatistics accountId={account.id} url={current.url} /></section> : null}
      {current && ["filled", "uncertain"].includes(current.stage) ? (
        <details>
          <summary>核对提交结果或返回编辑</summary>
          <Field label="实际单条微博链接">
            <input
              value={receipt}
              onChange={(event) => {
                setReceipt(event.target.value);
                setConfirmed(false);
              }}
              placeholder={`https://weibo.com/${current.uid}/微博ID`}
            />
          </Field>
          {current.stage === "uncertain" ? (
            <CheckboxField
              label="我已在官方窗口核对实际发布结果"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
          ) : null}
          <div className="row">
            <Button
              disabled={busy || !confirmed}
              onClick={() =>
                void work("正在登记结果…", () =>
                  ipc("weiboPosts.resolve", {
                    id: current.id,
                    url: receipt.trim(),
                    confirmed: true,
                  }),
                )
              }
            >
              {receipt.trim() ? "登记实际微博链接" : "确认尚未发布，返回编辑"}
            </Button>
          </div>
        </details>
      ) : null}
    </Dialog>
  );
}
