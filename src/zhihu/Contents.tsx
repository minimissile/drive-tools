import { windowStorage } from "../storage/window-storage";
import { useState } from "react";
import { z } from "zod";
import {
  zhihuContentInput,
  type ZhihuContent,
  type ZhihuContentInput,
  type ZhihuSnapshot,
} from "../../shared/zhihu";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { ipc } from "../api/client";
import { Button, Empty, Field, Notice, Panel, Status } from "../ui/primitives";
import { Select } from "../ui/Select";
import { CheckboxField } from "../ui/CheckboxField";
import { Pagination } from "../ui/Pagination";
import type { ZhihuAction } from "./Accounts";
import { readDraft, writeDraft } from "../storage/local-draft";

const empty: ZhihuContentInput = {
  kind: "article",
  purpose: "warming",
  category: "文案句子",
  title: "",
  body: "",
  questionUrl: "",
  aiAssisted: false,
};
const editorSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(["article", "answer"]),
  purpose: z.enum(["warming", "regular"]),
  category: z.string(),
  title: z.string(),
  body: z.string(),
  questionUrl: z.string(),
  aiAssisted: z.boolean(),
});
export function ZhihuContents({
  snapshot,
  workspace,
  busy,
  run,
}: {
  snapshot: ZhihuSnapshot;
  workspace: string;
  busy: boolean;
  run: ZhihuAction;
}) {
  const draft = useLocalDraft(
    `panxu-zhihu-content-v1:${workspace}`,
    empty,
    (raw) => editorSchema.parse(raw),
  );
  const [page, setPage] = useState(1),
    [importId, setImportId] = useState("");
  const current = snapshot.contents.find((c) => c.id === draft.value.id);
  const value = draft.value;
  const savedMatches =
    !!current &&
    [
      "kind",
      "purpose",
      "category",
      "title",
      "body",
      "questionUrl",
      "aiAssisted",
    ].every(
      (k) =>
        current[k as keyof ZhihuContent] ===
        value[k as keyof ZhihuContentInput],
    );
  const objectKey = (id: string) => `panxu-zhihu-edit-v1:${workspace}:${id}`;
  const [storageError, setStorageError] = useState("");
  let storage: Storage | undefined;
  try {
    storage = windowStorage;
  } catch {
    /* Keep the current editor recoverable. */
  }
  const stash = () => {
    const saved = writeDraft(storage, objectKey(value.id ?? "new"), value);
    setStorageError(saved ? "" : "无法暂存当前内容，请先保存素材再切换。");
    return saved;
  };
  const open = (c: ZhihuContent, restore = true) => {
    if (restore && !stash()) return;
    const local = restore
      ? readDraft(storage, objectKey(c.id), (raw) => editorSchema.parse(raw))
      : undefined;
    draft.update(
      local ?? {
        id: c.id,
        kind: c.kind,
        purpose: c.purpose,
        category: c.category,
        title: c.title,
        body: c.body,
        questionUrl: c.questionUrl,
        aiAssisted: c.aiAssisted,
      },
    );
  };
  const save = async () => {
    const c = await ipc("zhihu.content.save", value);
    writeDraft(storage, objectKey(c.id), { ...value, id: c.id });
    if (!value.id) {
      try {
        storage?.removeItem(objectKey("new"));
      } catch {
        /* Saved content remains in the database. */
      }
    }
    open(c, false);
    return c;
  };
  const actualPage = Math.min(
    page,
    Math.max(1, Math.ceil(snapshot.contents.length / 8)),
  );
  return (
    <div className="zhihu-content-layout">
      <Panel
        title="素材池"
        extra={
          <Button
            quiet
            disabled={busy}
            onClick={() => {
              if (!stash()) return;
              draft.update(
                readDraft(storage, objectKey("new"), (raw) =>
                  editorSchema.parse(raw),
                ) ?? { ...empty, id: undefined },
              );
            }}
          >
            新建素材
          </Button>
        }
      >
        <p className="muted">
          养号计划只使用已审核的无推广素材，每份素材分配一次。
        </p>
        {storageError ? <Notice danger>{storageError}</Notice> : null}
        {snapshot.drafts.length ? (
          <div className="row">
            <Select
              aria-label="导入知乎草稿"
              value={importId}
              items={[
                { value: "", label: "从内容工作室导入" },
                ...snapshot.drafts.map((d) => ({
                  value: d.id,
                  label: d.title,
                })),
              ]}
              onValueChange={setImportId}
            />
            <Button
              disabled={busy || !importId}
              onClick={() =>
                void run(
                  async () =>
                    open(
                      await ipc("zhihu.content.import", { draftId: importId }),
                    ),
                  "草稿已导入，请审核",
                )
              }
            >
              导入
            </Button>
          </div>
        ) : null}
        {snapshot.contents.length ? (
          <div className="zhihu-content-list">
            {snapshot.contents
              .slice((actualPage - 1) * 8, actualPage * 8)
              .map((c) => (
                <button
                  key={c.id}
                  className="zhihu-content-choice"
                  disabled={busy}
                  aria-pressed={c.id === value.id}
                  onClick={() => open(c)}
                >
                  <span>
                    <strong>{c.title}</strong>
                    <small>
                      {c.kind === "article" ? "文章" : "回答"} ·{" "}
                      {c.purpose === "warming" ? "养号素材" : "正常内容"} ·{" "}
                      {c.category} · {c.images.length} 图
                    </small>
                  </span>
                  <Status kind={c.reviewed ? "good" : "warning"}>
                    {c.reviewed ? "已审核" : "待审核"}
                  </Status>
                </button>
              ))}
          </div>
        ) : (
          <Empty title="添加第一份养号素材">
            可以准备文案、句子、知识分享，或添加本人有权使用的图片。
          </Empty>
        )}
        <Pagination
          page={actualPage}
          pageSize={8}
          total={snapshot.contents.length}
          onPageChange={setPage}
          label="知乎素材分页"
        />
      </Panel>
      <Panel
        title={value.id ? "编辑素材" : "新建素材"}
        extra={
          current ? (
            <Status
              kind={savedMatches && current.reviewed ? "good" : "warning"}
            >
              v{current.version} ·{" "}
              {savedMatches && current.reviewed ? "已审核" : "待保存 / 审核"}
            </Status>
          ) : undefined
        }
      >
        {draft.error ? <Notice danger>{draft.error}</Notice> : null}
        {current?.source ? <Notice>素材来源：皮皮虾 · {current.source.author}，含 {current.source.comments.length} 条评论。
          <Button size="compact" onClick={() => void ipc("system.external", { url: current.source!.url })}>查看原帖</Button>
        </Notice> : null}
        <div className="zhihu-fields">
          <Field label="内容形式">
            <Select
              disabled={busy}
              value={value.kind}
              items={[
                { value: "article", label: "知乎文章" },
                { value: "answer", label: "问题回答" },
              ]}
              onValueChange={(v) =>
                draft.update({ kind: v as "article" | "answer" })
              }
            />
          </Field>
          <Field label="内容用途">
            <Select
              disabled={busy}
              value={value.purpose}
              items={[
                { value: "warming", label: "养号素材（无推广）" },
                { value: "regular", label: "正常内容（达标后发布）" },
              ]}
              onValueChange={(v) =>
                draft.update({ purpose: v as "warming" | "regular" })
              }
            />
          </Field>
          <Field label="素材分类">
            <Select
              disabled={busy}
              value={value.category || "文案句子"}
              items={[
                "文案句子",
                "壁纸头像",
                "表情包",
                "知识分享",
                "已有草稿",
                "趣味图文",
              ].map((v) => ({ value: v, label: v }))}
              onValueChange={(v) => draft.update({ category: v })}
            />
          </Field>
        </div>
        <Field label="标题 / 任务名称">
          <input
            disabled={busy}
            value={value.title}
            maxLength={100}
            onChange={(e) => draft.update({ title: e.target.value })}
          />
        </Field>
        {value.kind === "answer" ? (
          <Field label="知乎问题链接">
            <input
              disabled={busy}
              value={value.questionUrl}
              onChange={(e) => draft.update({ questionUrl: e.target.value })}
              placeholder="https://www.zhihu.com/question/123456"
            />
          </Field>
        ) : null}
        <Field
          label="正文"
          hint="按段落填写，发布前请检查内容准确性与图片使用权"
        >
          <textarea
            disabled={busy}
            className="zhihu-body-input"
            value={value.body}
            maxLength={50000}
            onChange={(e) => draft.update({ body: e.target.value })}
          />
        </Field>
        <CheckboxField
          disabled={busy}
          label="内容包含 AI 辅助创作"
          checked={value.aiAssisted}
          onChange={(e) => draft.update({ aiAssisted: e.target.checked })}
        />
        <div className="row wrap">
          <Button
            primary
            disabled={busy || !zhihuContentInput.safeParse(value).success}
            onClick={() => void run(save, "素材已保存，请审核当前版本")}
          >
            保存素材
          </Button>
          <Button
            disabled={busy || !savedMatches}
            onClick={() =>
              void run(async () => {
                await ipc("zhihu.content.images", { id: current!.id });
              }, "配图已保存，请重新审核")
            }
          >
            选择 / 替换图片
          </Button>
          <Button
            disabled={busy || !savedMatches || current?.reviewed}
            onClick={() =>
              void run(
                () =>
                  ipc("zhihu.content.review", {
                    id: current!.id,
                    version: current!.version,
                    confirmed: true,
                  }),
                "当前版本已审核，可供调度使用",
              )
            }
          >
            审核此版本
          </Button>
        </div>
        {current?.images.length ? (
          <p className="muted">
            配图：{current.images.map((i) => i.name).join("、")}
          </p>
        ) : null}
        {current?.reviewed && savedMatches ? (
          <ScheduleContent
            content={current}
            snapshot={snapshot}
            busy={busy}
            run={run}
          />
        ) : null}
      </Panel>
    </div>
  );
}
function ScheduleContent({
  content,
  snapshot,
  busy,
  run,
}: {
  content: ZhihuContent;
  snapshot: ZhihuSnapshot;
  busy: boolean;
  run: ZhihuAction;
}) {
  const [accountId, setAccountId] = useState(""),
    [at, setAt] = useState("");
  return (
    <div className="zhihu-schedule-content">
      <h3>指定账号发布</h3>
      <p className="muted">
        养号素材也可由养号计划自动分配。应用需保持运行，关闭后需重新启动调度。
      </p>
      <div className="zhihu-fields">
        <Field label="发布账号">
          <Select
            value={accountId}
            onValueChange={setAccountId}
            items={[
              { value: "", label: "选择知乎账号" },
              ...snapshot.accounts.map((a) => ({
                value: a.id,
                label: a.alias,
              })),
            ]}
          />
        </Field>
        <Field label="本地执行时间（留空立即排队）">
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
        </Field>
      </div>
      <Button
        disabled={busy || !accountId}
        onClick={() =>
          void run(
            () =>
              ipc("zhihu.enqueue", {
                accountId,
                contentId: content.id,
                scheduledAt: at
                  ? new Date(at).toISOString()
                  : new Date().toISOString(),
                confirmed: true,
              }),
            "发布任务已排队",
          )
        }
      >
        加入发布队列
      </Button>
    </div>
  );
}
