import { ArrowRight, CircleCheck, Keyboard, Send, Shuffle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  keyboardSkinsDefaultCount,
  keyboardSkinsMaxCount,
} from "../../shared/keyboard-skins";
import { tiebaPublishingResourceLimit } from "../../shared/tieba-publishing";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { providerName } from "../resources/labels";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { selectSavedTiebaDraft } from "../tieba-publishing/draft-selection";
import { publishingBackendPending } from "../tieba-publishing/view";
import { tiebaAccountLabel } from "../tieba/account-label";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import {
  Button,
  Empty,
  Field,
  Header,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { selectSavedWechatDraft } from "../wechat/draft-selection";
import "./keyboard-skins.css";

const formSchema = z.object({
  count: z.string().nullable(),
  channel: z.enum(["wechat", "tieba"]).default("wechat"),
  tiebaAccountId: z.string().default(""),
  tiebaTargetId: z.string().default(""),
  selection: z
    .object({
      items: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            provider: z.string(),
            coverUrl: z.string(),
          }),
        )
        .min(1)
        .max(keyboardSkinsMaxCount),
      title: z.string().max(64),
      requestId: z.uuid(),
      savedId: z.string().optional(),
      tiebaSavedId: z.string().optional(),
      tiebaTitle: z.string().max(30).optional(),
    })
    .nullable(),
});
type Form = z.infer<typeof formSchema>;
const emptyForm: Form = formSchema.parse({ count: null, selection: null });

export default function KeyboardSkins() {
  const { data } = useAppData();
  const { navigate } = useAppNavigation();
  const { notify } = useAppActions();
  const workspace = data!.dataPath;
  const form = useLocalDraft(
    `panxu:wechat:${workspace}:keyboard-skins`,
    emptyForm,
    formSchema.parse,
  );
  const overview = useIpcQuery("wechat.keyboardSkinsOverview", undefined, {
    keepPrevious: true,
  });
  const tieba = form.value.channel === "tieba";
  const directory = useIpcQuery("tieba.publishing.snapshot", undefined, {
    enabled: tieba,
    keepPrevious: true,
  });
  const [busy, setBusy] = useState<"sample" | "save" | null>(null);
  const [error, setError] = useState<{
    action: "sample" | "save";
    message: string;
  } | null>(null);
  const lock = useRef(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const { selection } = form.value;
  const accounts =
    directory.data?.accounts.filter(({ status }) => status === "connected") ??
    [];
  const accountId =
    accounts.find(({ id }) => id === form.value.tiebaAccountId)?.id ??
    (accounts.length === 1 ? accounts[0].id : "");
  const targets =
    directory.data?.targets.filter(
      (target) => target.accountId === accountId && !target.paused,
    ) ?? [];
  const targetId =
    targets.find(({ id }) => id === form.value.tiebaTargetId)?.id ??
    (targets.length === 1 ? targets[0].id : "");
  const savedId = tieba ? selection?.tiebaSavedId : selection?.savedId;
  const title = tieba
    ? (selection?.tiebaTitle ??
      `手机键盘皮肤分享｜${selection?.items.length ?? 0} 款`)
    : (selection?.title ?? "");
  const titleValid = title.trim().length >= (tieba ? 3 : 1);
  const available = overview.data?.available;
  const limit = tieba ? tiebaPublishingResourceLimit : keyboardSkinsMaxCount;
  const max = Math.min(available ?? limit, limit);
  const tooManyForTieba =
    !!selection && selection.items.length > tiebaPublishingResourceLimit;
  const countValue =
    form.value.count ??
    String(
      Math.min(keyboardSkinsDefaultCount, max || keyboardSkinsDefaultCount),
    );
  const count = Number(countValue);
  const countValid = Number.isInteger(count) && count >= 1 && count <= max;

  const sample = async () => {
    if (lock.current || !available || !countValid) return;
    lock.current = true;
    setBusy("sample");
    setError(null);
    try {
      const result = await ipc("wechat.sampleKeyboardSkins", { count });
      if (alive.current) {
        form.update({
          selection: {
            items: result.items.map(({ id, title, provider, coverUrl }) => ({
              id,
              title,
              provider,
              coverUrl,
            })),
            title: result.title,
            requestId: crypto.randomUUID(),
          },
        });
      }
    } catch (cause) {
      if (alive.current) {
        setError({
          action: "sample",
          message:
            cause instanceof Error ? cause.message : "抽取失败，请重试。",
        });
        overview.reload();
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const save = async () => {
    if (
      lock.current ||
      !selection ||
      savedId ||
      !titleValid ||
      (tieba &&
        (!targetId || !accountId || tooManyForTieba || directory.data?.busy))
    )
      return;
    lock.current = true;
    setBusy("save");
    setError(null);
    try {
      const input = {
        resourceIds: selection.items.map(({ id }) => id),
        requestId: selection.requestId,
        title,
      };
      if (tieba) {
        const { id } = await ipc("tieba.publishing.saveKeyboardSkins", {
          ...input,
          accountId,
          targetId,
        });
        if (alive.current)
          form.update({ selection: { ...selection, tiebaSavedId: id } });
      } else {
        const { article } = await ipc("wechat.createKeyboardSkinsDraft", input);
        if (!alive.current) return;
        form.update({
          selection: {
            ...selection,
            title: article.title,
            savedId: article.id,
          },
        });
      }
    } catch (cause) {
      if (alive.current) {
        const message =
          cause instanceof Error ? cause.message : "保存草稿失败，请重试。";
        setError({
          action: "save",
          message:
            tieba && publishingBackendPending(message)
              ? "贴吧草稿功能等待后端更新。请点击顶部「应用更新并重启」后重试。"
              : message,
        });
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const openDraft = (id: string) => {
    const saved = tieba
      ? selectSavedTiebaDraft(workspace, id)
      : selectSavedWechatDraft(workspace, id);
    if (!saved) notify("草稿已保存，请在稿件列表中打开。", "warning");
    navigate(tieba ? "tieba-publishing" : "wechat-workflow");
  };

  return (
    <div className="keyboard-skins">
      <Header
        title="键盘皮肤分发"
        description="从资源库随机抽取手机键盘皮肤，整理成分发合辑。"
      />
      <Panel
        title="抽取资源"
        className="keyboard-skins-panel"
        extra={
          <div className="keyboard-skins-channel">
            <span>分发去向</span>
            <Select
              aria-label="分发去向"
              value={form.value.channel}
              disabled={!!busy}
              items={[
                { value: "wechat", label: "微信公众号" },
                { value: "tieba", label: "百度贴吧" },
              ]}
              onValueChange={(channel) => {
                form.update({
                  channel: channel === "tieba" ? "tieba" : "wechat",
                });
                setError(null);
              }}
            />
          </div>
        }
      >
        <QueryError
          error={overview.error}
          loading={overview.loading}
          onRetry={overview.reload}
        />
        {!overview.data && !overview.error ? (
          <LoadingState label="正在读取键盘皮肤…" compact />
        ) : available === 0 ? (
          <Empty title="暂无可分发的键盘皮肤" compact icon={Keyboard}>
            {overview.data?.total
              ? `「键盘皮肤」分类有 ${overview.data.total} 条资源，请先核对本人分享状态。`
              : "录入资源时选择「键盘皮肤」分类，并完成本人分享。"}
          </Empty>
        ) : overview.data ? (
          <form
            className="keyboard-skins-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void sample();
            }}
          >
            <Field label="抽取数量">
              <input
                type="number"
                min={1}
                max={max}
                step={1}
                inputMode="numeric"
                value={countValue}
                disabled={!!busy}
                aria-invalid={!countValid && !!countValue}
                aria-describedby="keyboard-skins-count-hint"
                onChange={(event) => {
                  form.update({ count: event.target.value });
                  if (error?.action === "sample") setError(null);
                }}
              />
            </Field>
            <Button
              type="submit"
              primary={!selection}
              disabled={!!busy || !countValid}
            >
              <Shuffle size={15} aria-hidden="true" />
              {busy === "sample"
                ? "正在抽取…"
                : selection
                  ? "重新抽取"
                  : "随机抽取"}
            </Button>
            <small
              id="keyboard-skins-count-hint"
              className={!countValid && countValue ? "danger-text" : "muted"}
            >
              {!countValid && countValue
                ? `请输入 1–${max} 之间的整数。`
                : `分类共 ${overview.data.total} 条 · 可用本人分享 ${overview.data.available} 条${overview.data.available > max ? ` · 每次最多 ${max} 条` : ""}`}
            </small>
          </form>
        ) : null}
        {error?.action === "sample" ? (
          <Notice danger>
            <span role="alert">{error.message}</span>
          </Notice>
        ) : null}
      </Panel>

      {form.error ? <Notice warning>{form.error}</Notice> : null}

      {selection ? (
        <Panel
          title="本次选中的皮肤"
          className="keyboard-skins-panel"
          extra={
            <div className="keyboard-skins-actions">
              {savedId ? (
                <>
                  <span className="keyboard-skins-saved" role="status">
                    <CircleCheck size={15} aria-hidden="true" />
                    {tieba ? "已存入贴吧发帖草稿" : "已存入公众号草稿箱"}
                  </span>
                  <Button primary onClick={() => openDraft(savedId)}>
                    打开草稿 <ArrowRight size={15} aria-hidden="true" />
                  </Button>
                </>
              ) : (
                <Button
                  primary
                  disabled={
                    !!busy ||
                    !titleValid ||
                    (tieba &&
                      (!targetId || tooManyForTieba || directory.data?.busy))
                  }
                  onClick={() => void save()}
                >
                  <Send size={15} aria-hidden="true" />
                  {busy === "save"
                    ? "正在保存…"
                    : tieba
                      ? "保存贴吧草稿"
                      : "推送到公众号草稿箱"}
                </Button>
              )}
            </div>
          }
        >
          {tieba ? (
            <>
              <QueryError
                error={directory.error}
                loading={directory.loading}
                onRetry={directory.reload}
              />
              {!directory.data && !directory.error ? (
                <LoadingState compact label="正在读取贴吧账号和目标…" />
              ) : null}
              {directory.data ? (
                <div className="field-pair keyboard-skins-tieba-fields">
                  <Field label="贴吧账号" as="div">
                    <Select
                      value={accountId}
                      disabled={!!busy || !!savedId || !accounts.length}
                      items={[
                        {
                          value: "",
                          label: "选择已核验的贴吧账号",
                          disabled: true,
                        },
                        ...accounts.map((account) => ({
                          value: account.id,
                          label: tiebaAccountLabel(account),
                        })),
                      ]}
                      onValueChange={(tiebaAccountId) => {
                        form.update({ tiebaAccountId, tiebaTargetId: "" });
                        setError(null);
                      }}
                    />
                  </Field>
                  <Field label="目标贴吧" as="div">
                    <Select
                      value={targetId}
                      disabled={!!busy || !!savedId || !targets.length}
                      items={[
                        { value: "", label: "选择目标贴吧", disabled: true },
                        ...targets.map((target) => ({
                          value: target.id,
                          label: target.name,
                        })),
                      ]}
                      onValueChange={(tiebaTargetId) => {
                        form.update({ tiebaTargetId });
                        setError(null);
                      }}
                    />
                  </Field>
                </div>
              ) : null}
              {directory.data &&
              (!accounts.length || (!!accountId && !targets.length)) ? (
                <Notice warning>
                  {accounts.length
                    ? "该账号还没有可用目标贴吧。"
                    : "请先核验贴吧账号。"}
                  <Button
                    quiet
                    size="compact"
                    onClick={() =>
                      navigate(
                        accounts.length
                          ? "tieba-publishing"
                          : "website-accounts",
                      )
                    }
                  >
                    {accounts.length ? "去添加目标" : "管理账号"}
                  </Button>
                </Notice>
              ) : null}
              {tooManyForTieba ? (
                <Notice warning>
                  每篇贴吧帖子最多 {tiebaPublishingResourceLimit}{" "}
                  款，请减少数量后重新抽取。
                </Notice>
              ) : null}
            </>
          ) : null}
          <div className="keyboard-skins-title">
            <Field
              label={tieba ? "帖子标题" : "文章标题"}
              hint={tieba ? "3–30 字" : undefined}
            >
              <input
                value={title}
                maxLength={tieba ? 30 : 64}
                disabled={!!busy}
                readOnly={!!savedId}
                onChange={(event) => {
                  const title = event.target.value;
                  form.update({
                    selection: tieba
                      ? { ...selection, tiebaTitle: title }
                      : { ...selection, title },
                  });
                  if (error?.action === "save") setError(null);
                }}
              />
            </Field>
          </div>
          {error?.action === "save" ? (
            <Notice danger>
              <span role="alert">{error.message}</span>
            </Notice>
          ) : null}
          <p className="muted keyboard-skins-total" role="status">
            共 {selection.items.length} 款，按下列顺序排入正文
          </p>
          <ol className="keyboard-skins-list" aria-label="本次选中的皮肤">
            {selection.items.map((item) => (
              <li key={item.id}>
                {item.coverUrl ? (
                  <img src={item.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span aria-hidden="true">
                    <Keyboard size={18} />
                  </span>
                )}
                <strong>{item.title}</strong>
                <small>{providerName(item.provider)}</small>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}
    </div>
  );
}
