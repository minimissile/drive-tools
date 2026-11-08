import { AiIcon } from "../ui/AiIcon";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Pause, RefreshCw, RotateCcw } from "lucide-react";
import {
  catalogAiStartSchema,
  type CatalogAiJob,
  type CatalogSaveInput,
} from "../../shared/resource-catalog";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Dialog } from "../ui/Dialog";
import { Button, Field, Loading, Notice, Status } from "../ui/primitives";
import { Select } from "../ui/Select";

interface Props {
  workspace: string;
  categories: string[];
  onClose(): void;
  onGenerated(input: CatalogSaveInput, requestId: string): void;
}
interface Inputs {
  prompt: string;
  category: string;
  maxItems: string;
  requestId: string;
  attempted: boolean;
}
type Issue = { text: string; kind: "error" | "warning" } | null;
const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/** A workspace change remounts the session so late IPC cannot replace another form. */
export function CatalogAiDialog(props: Props) {
  return <CatalogAiSession key={props.workspace} {...props} />;
}

function CatalogAiSession({
  workspace,
  categories,
  onClose,
  onGenerated,
}: Props) {
  const [defaults] = useState<Inputs>(() => ({
    prompt: "",
    category: "all",
    maxItems: "50",
    requestId: crypto.randomUUID(),
    attempted: false,
  }));
  const draft = useLocalDraft<Inputs>(
    `panxu-catalog-ai:${workspace}`,
    defaults,
    (value) => {
      if (!value || typeof value !== "object") return defaults;
      const saved = value as Partial<Inputs>;
      const request = catalogAiStartSchema.shape.requestId.safeParse(
        saved.requestId,
      );
      return {
        prompt:
          typeof saved.prompt === "string" ? saved.prompt.slice(0, 2000) : "",
        category:
          typeof saved.category === "string" && saved.category.trim()
            ? saved.category.slice(0, 60)
            : "all",
        maxItems:
          typeof saved.maxItems === "string"
            ? saved.maxItems.slice(0, 8)
            : "50",
        requestId: request.success ? request.data : defaults.requestId,
        // This restores a reference for GET only, never permission to resume a paid call.
        attempted: request.success && saved.attempted === true,
      };
    },
  );
  const form = draft.value;
  const formRef = useRef(form);
  formRef.current = form;
  const [job, setJob] = useState<CatalogAiJob | null>(null);
  const jobRef = useRef<CatalogAiJob | null>(null);
  const [pending, setPending] = useState<"" | "reading" | "generating">("");
  const [issue, setIssue] = useState<Issue>(null);
  const [paused, setPaused] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const mounted = useRef(true),
    stop = useRef(true),
    lock = useRef(false);
  const sequence = useRef(0),
    handedOff = useRef(false);
  const current = useCallback(
    (id: string, token: number) =>
      mounted.current &&
      formRef.current.requestId === id &&
      sequence.current === token,
    [],
  );
  const adopt = useCallback((next: CatalogAiJob) => {
    if (next.id !== formRef.current.requestId)
      throw new Error("返回的检索记录与当前需求不匹配，请重新读取进度。");
    jobRef.current = next;
    setJob(next);
  }, []);

  const readProgress = useCallback(async () => {
    if (lock.current) return;
    const id = formRef.current.requestId,
      token = ++sequence.current;
    lock.current = true;
    setPending("reading");
    setIssue(null);
    try {
      const result = await ipc("resourceCatalog.aiGet", { id });
      if (!current(id, token)) return;
      const before = jobRef.current;
      adopt(result);
      if (
        result.stage === "completed" ||
        (before && result.scanned > before.scanned) ||
        (before && result.stage !== before.stage)
      )
        setUnconfirmed(false);
    } catch (cause) {
      if (current(id, token))
        setIssue({
          kind: "error",
          text: message(cause, "检索进度读取失败，请重试读取。"),
        });
    } finally {
      lock.current = false;
      if (current(id, token)) setPending("");
    }
  }, [adopt, current]);

  useEffect(() => {
    mounted.current = true;
    if (formRef.current.attempted) void readProgress();
    return () => {
      mounted.current = false;
      stop.current = true;
    };
  }, [readProgress]);

  const close = () => {
    stop.current = true;
    onClose();
  };
  const pause = () => {
    stop.current = true;
    setPaused(true);
  };
  const reset = () => {
    if (lock.current || jobRef.current?.busy) return;
    stop.current = true;
    sequence.current++;
    jobRef.current = null;
    setJob(null);
    setIssue(null);
    setPaused(false);
    setUnconfirmed(false);
    handedOff.current = false;
    draft.update({ requestId: crypto.randomUUID(), attempted: false });
  };

  const generate = async (retryUncertain = false) => {
    if (lock.current) return;
    const values = formRef.current,
      id = values.requestId;
    const parsed = catalogAiStartSchema.safeParse({
      ...values,
      maxItems: Number(values.maxItems),
    });
    if (!jobRef.current && !parsed.success) {
      setIssue({
        kind: "error",
        text: parsed.error.issues[0]?.message ?? "请检查检索需求和数量。",
      });
      return;
    }
    const token = ++sequence.current;
    lock.current = true;
    stop.current = false;
    setPending("generating");
    setPaused(false);
    setIssue(null);
    let latest = jobRef.current,
      stepIssued = false;
    try {
      if (latest) latest = await ipc("resourceCatalog.aiGet", { id });
      else {
        if (!parsed.success) return;
        // Persist the ID before dispatch, including when start's response is lost.
        draft.update({ attempted: true });
        latest = await ipc("resourceCatalog.aiStart", parsed.data);
      }
      if (!current(id, token)) return;
      adopt(latest);
      if (latest.busy || latest.stage === "completed") return;
      if ((latest.uncertain || latest.error || unconfirmed) && !retryUncertain)
        return;
      setUnconfirmed(false);
      let retry = retryUncertain;
      // The loop is entered only by an explicit button; effects and GET never spend budget.
      while (
        current(id, token) &&
        !stop.current &&
        latest.stage !== "completed"
      ) {
        stepIssued = true;
        const before = latest;
        latest = await ipc("resourceCatalog.aiStep", {
          id,
          ...(retry ? { retryUncertain: true as const } : {}),
        });
        if (!current(id, token)) return;
        adopt(latest);
        retry = false;
        if (latest.error || latest.uncertain || latest.busy) break;
        if (latest.stage === before.stage && latest.scanned <= before.scanned) {
          setIssue({
            kind: "warning",
            text: "本批次未返回新的进度，已停止后续调用。请先读取进度核对，再决定是否重试。",
          });
          setUnconfirmed(true);
          break;
        }
      }
    } catch (cause) {
      if (!current(id, token)) return;
      setIssue({
        kind: "error",
        text: message(cause, "生成暂时中断，已保留检索记录。"),
      });
      // Recover a possibly committed batch using GET; never repeat a paid step here.
      try {
        const recovered = await ipc("resourceCatalog.aiGet", { id });
        if (!current(id, token)) return;
        const advanced =
          latest &&
          (recovered.scanned > latest.scanned ||
            recovered.stage !== latest.stage);
        adopt(recovered);
        if (recovered.stage === "completed") {
          setIssue(null);
          setUnconfirmed(false);
        } else if (advanced) {
          setIssue({
            kind: "warning",
            text: "已读取到最近保存的进度，后续批次尚未继续。可点击继续生成。",
          });
          setUnconfirmed(false);
        } else setUnconfirmed(stepIssued || recovered.uncertain);
      } catch {
        if (current(id, token)) setUnconfirmed(stepIssued);
      }
    } finally {
      lock.current = false;
      if (current(id, token)) {
        setPending("");
        stop.current = true;
      }
    }
  };

  const editResult = () => {
    if (
      !mounted.current ||
      lock.current ||
      handedOff.current ||
      !job?.draft ||
      job.stage !== "completed"
    )
      return;
    handedOff.current = true;
    stop.current = true;
    try {
      onGenerated(structuredClone(job.draft), job.id);
    } catch (cause) {
      handedOff.current = false;
      if (mounted.current)
        setIssue({
          kind: "error",
          text: message(cause, "未能打开清单编辑，请重试。"),
        });
    }
  };
  const busy = !!pending;
  const inputsLocked = busy || form.attempted;
  const completed = job?.stage === "completed";
  const retry = unconfirmed || !!job?.uncertain || !!job?.error;
  const shownIssue: Issue =
    issue ??
    (job?.error
      ? { text: job.error, kind: job.uncertain ? "warning" : "error" }
      : null);
  const options = [
    ...new Set([
      ...categories,
      ...(form.category !== "all" ? [form.category] : []),
    ]),
  ].filter((c) => c && c !== "all");
  return (
    <Dialog
      title="AI生成资源清单"
      className="catalog-editor"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>稍后继续</Button>
          {pending === "generating" ? (
            <Button disabled={paused} onClick={pause}>
              <Pause size={15} />
              {paused ? "等待当前批次结束…" : "暂停后续批次"}
            </Button>
          ) : pending === "reading" ? (
            <Button disabled>正在读取进度…</Button>
          ) : job?.busy ? (
            <Button onClick={() => void readProgress()}>
              <RefreshCw size={15} />
              读取进度
            </Button>
          ) : completed ? (
            job.draft ? (
              <Button primary onClick={editResult}>
                <ArrowRight size={15} />
                编辑并保存清单
              </Button>
            ) : (
              <Button primary onClick={reset}>
                修改需求
              </Button>
            )
          ) : (
            <Button
              primary
              disabled={!job && form.prompt.trim().length < 2}
              onClick={() => void generate(retry)}
            >
              <AiIcon size={15} />
              {retry
                ? "重试（可能再次计费）"
                : job || form.attempted
                  ? "继续生成"
                  : "AI生成清单"}
            </Button>
          )}
        </>
      }
    >
      <p className="muted">
        描述你需要的资料，AI会检索所选范围的本地资源库，生成可编辑的清单草稿。
      </p>
      <Notice>
        将调用全局“资源分析”模型，可能分多次请求并按全局AI预算计费。会发送你的需求及脱敏后的资源名称、分类、标签和说明（每项最多2000字），不读取文件正文。
      </Notice>
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      <div className="fields">
        <Field
          label="需要哪些资源"
          required
          hint="可写主题、受众，以及要包含或排除的内容"
        >
          <textarea
            value={form.prompt}
            maxLength={2000}
            rows={4}
            disabled={inputsLocked}
            placeholder="例如：适合刚入职的数据分析师使用的简历、项目复盘和办公模板，排除编程课程。"
            onChange={(e) => draft.update({ prompt: e.target.value })}
          />
        </Field>
        <div className="field-pair">
          <Field label="检索范围">
            <Select
              value={form.category}
              disabled={inputsLocked}
              onValueChange={(category) => draft.update({ category })}
              items={[
                { value: "all", label: "全部分类" },
                ...options.map((value) => ({ value, label: value })),
              ]}
            />
          </Field>
          <Field label="最多选入" hint="1–2000项">
            <input
              type="number"
              min={1}
              max={2000}
              step={1}
              inputMode="numeric"
              value={form.maxItems}
              disabled={inputsLocked}
              onChange={(e) => draft.update({ maxItems: e.target.value })}
            />
          </Field>
        </div>
      </div>
      {shownIssue ? (
        <div role="alert">
          <Notice
            danger={shownIssue.kind === "error"}
            warning={shownIssue.kind === "warning"}
          >
            {shownIssue.text}
          </Notice>
        </div>
      ) : null}
      {pending && !job ? (
        <Loading
          label={
            pending === "reading"
              ? "正在恢复上次检索进度…"
              : "正在读取本地资源并开始生成…"
          }
        />
      ) : null}
      {job ? (
        <section className="catalog-site-status" aria-label="AI检索进度">
          <div className="catalog-title-line">
            <Status
              kind={
                completed
                  ? job.draft
                    ? "good"
                    : "normal"
                  : retry
                    ? "warning"
                    : "normal"
              }
            >
              {completed
                ? job.draft
                  ? "草稿已生成"
                  : "未找到匹配资源"
                : retry
                  ? "生成待处理"
                  : pending === "generating" || job.busy
                    ? "生成中"
                    : "已暂停"}
            </Status>
            <span>
              已检查 {job.scanned} / {job.total} 项 · 匹配 {job.matched} 项
            </span>
          </div>
          {completed ? (
            <p className="muted">
              {job.draft
                ? `草稿选入 ${job.draft.entries?.length ?? 0} 项资源，可继续编辑标题、说明和具体条目。`
                : "当前需求没有匹配到资源。可以调整需求或检索分类，再开始一次新的检索。"}
            </p>
          ) : pending === "generating" || job.busy ? (
            <Loading
              label={
                paused
                  ? "暂停已请求，当前批次仍会完成并保存进度。"
                  : job.stage === "writing"
                    ? "正在生成清单标题与介绍…"
                    : "正在分批匹配资源…"
              }
            />
          ) : (
            <p className="muted">
              {job.uncertain || unconfirmed
                ? "上次调用的结果尚未确认。重试当前批次可能再次计费。"
                : job.stage === "writing"
                  ? "资源匹配已完成，继续生成清单标题与介绍。"
                  : "已保存批次进度，继续生成会处理尚未完成的资源。"}
            </p>
          )}
          <div className="catalog-publish-actions">
            <Button
              size="compact"
              disabled={busy}
              onClick={() => void readProgress()}
            >
              <RefreshCw size={14} />
              读取进度
            </Button>
            <Button size="compact" disabled={busy || job.busy} onClick={reset}>
              <RotateCcw size={14} />
              调整需求重新检索
            </Button>
          </div>
        </section>
      ) : form.attempted && !busy ? (
        <div className="catalog-publish-actions">
          <Button size="compact" onClick={() => void readProgress()}>
            <RefreshCw size={14} />
            读取上次进度
          </Button>
          <Button size="compact" onClick={reset}>
            <RotateCcw size={14} />
            调整需求
          </Button>
        </div>
      ) : null}
      {job?.draft && completed ? (
        <section
          className="catalog-site-publishing"
          aria-label="生成的清单草稿"
        >
          <strong>{job.draft.title}</strong>
          <p>{job.draft.introduction || "可在下一步补充清单介绍。"}</p>
        </section>
      ) : null}
      <p className="muted">
        暂停或关闭只停止后续批次，在途调用仍会完成。需求与检索记录会按工作空间和窗口暂存；生成后由你编辑保存，不会自动发布。
      </p>
    </Dialog>
  );
}
