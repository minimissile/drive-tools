import { AiIcon } from "../ui/AiIcon";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Save, ArrowRight } from "lucide-react";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions, useAppData } from "../state";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";
import { SearchSelect } from "../ui/SearchSelect";
import { QueryError } from "../ui/QueryError";
import { TextSuggestions } from "../ui/TextSuggestions";
import {
  weiboContentKinds,
  weiboIdeaInput,
  type WeiboIdea,
} from "../../shared/weibo-workspace";
import type { WebsiteAccountView } from "../../shared/website-accounts";

const schema = weiboIdeaInput.extend({
  id: z.string().default(""),
  title: z.string().max(200),
  resourceLabel: z.string().default(""),
});
export function IdeaEditor({
  initial,
  accountId,
  accounts,
  onDelivered,
  onChanged,
  onSaved,
}: {
  initial?: WeiboIdea;
  accountId: string;
  accounts: WebsiteAccountView[];
  onDelivered(
    target: NonNullable<WeiboIdea["target"]>,
    accountId: string,
  ): void;
  onChanged(): void;
  onSaved(id: string): void;
}) {
  const { data } = useAppData(),
    { command, notify } = useAppActions();
  const form = useLocalDraft(
    `weibo-idea-editor:${data!.dataPath}:${initial?.id ?? "new"}`,
    {
      ...schema.parse({
        ...initial,
        id: initial?.id ?? "",
        title: initial?.title ?? "",
        accountId: initial?.accountId ?? accountId,
        resourceLabel: "",
      }),
    },
    (raw) => schema.parse(raw),
  );
  const v = form.value;
  const [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  const lock = useRef(false),
    alive = useRef(true);
  const [resourceQuery, setResourceQuery] = useState("");
  const words = useIpcQuery(
    "weibo.words",
    { query: v.title.slice(0, 100) },
    { delay: 180 },
  );
  const source = words.data?.find((word) => word.id === v.sourceId);
  const keywordSuggestions = new Map(
    (words.data ?? []).map((word) => [word.word, word]),
  );
  // Parent's editor is keyed by object; no async completion navigates an abandoned editor.
  const resources = useIpcQuery(
    "weibo.matches",
    { keyword: (resourceQuery || v.title).slice(0, 100) },
    { delay: 200 },
  );
  const style = useIpcQuery(
    "weiboWorkspace.style",
    { accountId: v.accountId },
    { enabled: !!v.accountId, keepPrevious: false },
  );
  const [variantAccount, setVariantAccount] = useState("");
  const save = () =>
    command(
      "weiboWorkspace.save",
      { ...v, id: v.id || undefined },
      undefined,
      true,
    );
  const work = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (alive.current) setNotice((e as Error).message);
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  // Keep the lifecycle guard separate from persisted text.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const remember = (item: WeiboIdea) => {
    if (!alive.current) return;
    form.update({ ...item, resourceLabel: v.resourceLabel });
    if (!initial) form.clear();
    onChanged();
  };
  return (
    <div className="weibo-idea-layout">
      <Panel title="内容设置">
        <Field label="目标微博账号" hint="可先保存选题，交付发布前再选账号。">
          <Select
            aria-label="内容目标账号"
            value={v.accountId}
            disabled={pending}
            onValueChange={(accountId) => form.update({ accountId })}
            items={[
              { value: "", label: "稍后选择账号" },
              ...accounts.map((a) => ({
                value: a.id,
                label: `${a.nickname || a.alias}${a.status !== "connected" ? " · 待登录" : ""}`,
              })),
            ]}
          />
        </Field>
        <Field label="内容类型">
          <Select
            aria-label="微博内容类型"
            value={v.kind}
            disabled={pending}
            onValueChange={(kind) =>
              form.update({ kind: kind as typeof v.kind })
            }
            items={Object.entries(weiboContentKinds).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Field>
        <Field
          label="关联本人资料（可选）"
          hint="带网盘链接时使用已核验资料，并保留发布权限检查。"
        >
          <SearchSelect
            label="内容关联资料"
            value={{
              value: v.copyId,
              label:
                v.resourceLabel ||
                resources.data?.find((r) => r.copyId === v.copyId)?.title ||
                v.copyId ||
                "暂不关联资料",
            }}
            items={[
              { value: "", label: "暂不关联资料" },
              ...(resources.data ?? []).map((r) => ({
                value: r.copyId,
                label: r.title,
              })),
            ]}
            loading={resources.loading}
            error={resources.error}
            onRetry={resources.reload}
            onQueryChange={setResourceQuery}
            onChange={(copyId) =>
              form.update({
                copyId,
                resourceLabel:
                  resources.data?.find((r) => r.copyId === copyId)?.title ?? "",
              })
            }
          />
        </Field>
        <Field label="计划时间" hint="用于待办排序，到时仍需你审阅并确认发布。">
          <input
            aria-label="微博计划时间"
            type="datetime-local"
            disabled={pending}
            value={localTime(v.plannedAt)}
            onChange={(e) =>
              form.update({
                plannedAt:
                  e.target.value && Number.isFinite(Date.parse(e.target.value))
                    ? new Date(e.target.value).toISOString()
                    : null,
              })
            }
          />
        </Field>
        <Field label="适合人群（可选）">
          <input
            value={v.audience}
            maxLength={100}
            disabled={pending}
            onChange={(e) => form.update({ audience: e.target.value })}
          />
        </Field>
        <details>
          <summary>当前账号文风</summary>
          <p className="muted">
            {style.data?.instructions ??
              (v.accountId ? "正在读取账号文风…" : "选择账号后显示独立文风。")}
          </p>
          <QueryError
            error={style.error}
            loading={style.loading}
            onRetry={style.reload}
          />
        </details>
      </Panel>
      <Panel title={initial ? "编辑内容" : "新建内容"}>
        <Field label="选题 / 内容名称" required>
          <TextSuggestions
            aria-label="微博内容名称"
            value={v.title}
            maxLength={200}
            disabled={pending}
            placeholder="先记下想分享的资源或主题"
            items={[...keywordSuggestions.values()].map((word) => ({
              value: word.word,
              label: `${word.word} · ${word.source}`,
            }))}
            onValueChange={(title) =>
              form.update({
                title,
                sourceId: keywordSuggestions.get(title)?.id ?? "manual",
              })
            }
          />
          <small className="muted">
            来源：
            {source?.source ??
              (v.sourceId === "manual"
                ? "手工选题，可从本地词库建议中选择"
                : "已选本地记录")}
            ；微博搜索热度未接入。
          </small>
          <QueryError
            error={words.error}
            loading={words.loading}
            onRetry={words.reload}
          />
        </Field>
        <Field
          label="微博文案"
          hint={`${Array.from(v.text).length} / 2000 字符；可以留空，先保存选题。`}
        >
          <textarea
            aria-label="微博内容文案"
            rows={12}
            value={v.text}
            maxLength={2000}
            disabled={pending}
            placeholder="资源名称与已知规格\n\n链接由应用核验后附加\n\n简短介绍内容与用途"
            onChange={(e) => form.update({ text: e.target.value })}
          />
        </Field>
        <Field
          label="已核实内容依据"
          hint="保存选题时可留空。AI创作或关联资料交付时需至少10字；不猜年份、画质或文件大小。"
        >
          <textarea
            aria-label="微博内容依据"
            rows={3}
            value={v.evidence}
            maxLength={5000}
            disabled={pending}
            onChange={(e) => form.update({ evidence: e.target.value })}
          />
        </Field>
        {notice || form.error ? (
          <Notice danger>{notice || form.error}</Notice>
        ) : null}
        <div className="row weibo-editor-actions">
          <Button
            disabled={pending || !v.title.trim()}
            onClick={() =>
              void work(async () => {
                const item = await save();
                if (item && alive.current) {
                  remember(item);
                  setNotice("");
                  notify(
                    item.text.trim() ? "微博草稿已保存。" : "微博选题已保存。",
                    "success",
                  );
                  onSaved(item.id);
                }
              })
            }
          >
            <Save size={14} />
            保存{v.text.trim() ? "草稿" : "选题"}
          </Button>
          <Button
            disabled={
              pending ||
              !v.accountId ||
              v.evidence.trim().length < 10 ||
              !v.title.trim()
            }
            onClick={() =>
              void work(async () => {
                const saved = await save();
                if (!saved) return;
                remember(saved);
                try {
                  const next = await command(
                    "weiboWorkspace.generate",
                    { id: saved.id },
                    undefined,
                    true,
                  );
                  if (next) remember(next);
                } finally {
                  if (alive.current) onSaved(saved.id);
                }
              })
            }
          >
            <AiIcon size={14} />
            按账号文风生成
          </Button>
          <Button
            primary
            disabled={
              pending ||
              !v.accountId ||
              !v.title.trim() ||
              (!v.copyId && !v.text.trim())
            }
            onClick={() =>
              void work(async () => {
                const saved = await save();
                if (!saved) return;
                remember(saved);
                const target = await command(
                  "weiboWorkspace.deliver",
                  { id: saved.id },
                  undefined,
                  true,
                );
                if (target && alive.current) onDelivered(target, v.accountId);
              })
            }
          >
            继续审阅与发布
            <ArrowRight size={14} />
          </Button>
        </div>
        <p className="muted">
          生成按现有模型和预算计费，仅点击时执行；此处不会上传或发布。配图在发布编辑器中选择。
        </p>
        {v.id ? (
          <div className="weibo-variant-toolbar">
            <Select
              aria-label="另存版本目标账号"
              value={variantAccount}
              disabled={pending}
              onValueChange={setVariantAccount}
              items={[
                { value: "", label: "选择另一个账号" },
                ...accounts.map((a) => ({
                  value: a.id,
                  label: a.nickname || a.alias,
                })),
              ]}
            />
            <Button
              disabled={pending || !variantAccount}
              onClick={() =>
                void work(async () => {
                  const saved = await save();
                  if (!saved) return;
                  remember(saved);
                  const next = await command(
                    "weiboWorkspace.variant",
                    { id: saved.id, accountId: variantAccount },
                    undefined,
                    true,
                  );
                  if (next && alive.current) {
                    onChanged();
                    notify(
                      `已为${accounts.find((a) => a.id === variantAccount)?.nickname || "目标账号"}保存独立草稿，请返回内容列表打开。`,
                      "success",
                    );
                    onSaved(saved.id);
                  }
                })
              }
            >
              另存账号版本
            </Button>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
function localTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
