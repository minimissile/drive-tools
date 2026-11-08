import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { X } from "lucide-react";
import { tiebaInitialForums } from "../../shared/tieba-forums";
import {
  tiebaForumKeywordSchema,
  type TiebaForumDiscoveryResult,
} from "../../shared/tieba-forum-discovery";
import type { TiebaAutocareSnapshot } from "../../shared/tieba-autocare";
import type { WebsiteAccount } from "../../shared/website-accounts";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions } from "../state";
import {
  Button,
  Empty,
  Field,
  Notice,
  Status,
  LoadingState,
} from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import type { FeedbackMessage } from "../lib/feedback";
import { tiebaForumKey } from "./observe-view";
import {
  tiebaAddPlan,
  tiebaAddRemaining,
  tiebaAdditionResult,
  tiebaFilterForums,
  tiebaLowReplyCandidate,
} from "./add-forums-view";
import { tiebaAccountNeedsVerification, tiebaTime } from "./view-model";
import { tiebaBackendError } from "./useTiebaAction";

export interface AddForumsProps {
  snapshot: TiebaAutocareSnapshot;
  workspace: string;
  busy: boolean;
  initialAccountId: string;
  receive(snapshot: TiebaAutocareSnapshot): void;
  reload(): void;
  purpose?: "observe" | "publishing";
}
const resultSchema = z.object({
  accountId: z.string(),
  keyword: z.string().max(80),
  checkedAt: z.string(),
  truncated: z.boolean(),
  message: z.string(),
  items: z
    .array(
      z.object({
        name: z.string().max(100),
        forumId: z.string().nullable(),
        url: z.string(),
        description: z.string(),
        memberCount: z.number().nullable(),
        postCount: z.number().nullable(),
        threadCount: z.number().nullable(),
        sampledThreads: z.number(),
        zeroReplyThreads: z.number(),
        latestActiveLabel: z.string().nullable(),
        checkedAt: z.string(),
        message: z.string().nullable().optional(),
      }),
    )
    .max(10),
});

export function AddForums({
  snapshot,
  workspace,
  busy,
  initialAccountId,
  receive,
  reload,
  purpose = "observe",
}: AddForumsProps) {
  const view = useLocalDraft(
    `tieba-add-view:${workspace}:${purpose}`,
    {
      open: false,
      accountId: initialAccountId || snapshot.accounts[0]?.id || "",
    },
    (value) =>
      z
        .object({ open: z.boolean(), accountId: z.string().max(150) })
        .parse(value),
  );
  const account = snapshot.accounts.find(
    (item) => item.id === view.value.accountId,
  );
  return (
    <>
      <Button
        disabled={busy || !snapshot.accounts.length}
        data-testid="tieba-add-open"
        onClick={() => view.update({ open: true })}
      >
        添加贴吧
      </Button>
      {view.value.open ? (
        <AddForumsDialog
          key={`${account?.id ?? "none"}:${account?.uid ?? ""}`}
          snapshot={snapshot}
          workspace={workspace}
          busy={busy}
          account={account}
          onAccount={(accountId) => view.update({ accountId })}
          close={() => view.update({ open: false })}
          receive={receive}
          reload={reload}
          purpose={purpose}
          viewError={view.error}
        />
      ) : null}
    </>
  );
}

function AddForumsDialog({
  snapshot,
  workspace,
  busy,
  account,
  onAccount,
  close,
  receive,
  reload,
  purpose,
  viewError,
}: {
  snapshot: TiebaAutocareSnapshot;
  workspace: string;
  busy: boolean;
  account: WebsiteAccount | undefined;
  onAccount(accountId: string): void;
  close(): void;
  receive(snapshot: TiebaAutocareSnapshot): void;
  reload(): void;
  purpose: "observe" | "publishing";
  viewError: string;
}) {
  const draft = useLocalDraft(
    `tieba-add-input:${workspace}:${purpose}:${account?.id ?? "none"}`,
    {
      selectedNames: [] as string[],
      customText: "",
      mode: "find" as "find" | "manual",
      keyword: "",
      memberMax: "",
      postMax: "",
      lowReplies: false,
      result: null as TiebaForumDiscoveryResult | null,
      legacyRecovered: false,
    },
    (value) =>
      z
        .object({
          selectedNames: z.array(z.string().max(100)).max(5),
          customText: z.string().max(12000),
          mode: z.enum(["find", "manual"]),
          keyword: z.string().max(80),
          memberMax: z.string().max(20),
          postMax: z.string().max(20),
          lowReplies: z.boolean(),
          result: resultSchema.nullable(),
          legacyRecovered: z.boolean().default(false),
        })
        .parse(value),
  );
  const legacy = useLocalDraft(
    `tieba-observe-input:${workspace}:${account?.id ?? "none"}`,
    { selectedNames: [] as string[], customText: "" },
    (value) =>
      z
        .object({
          selectedNames: z.array(z.string().max(100)).max(5),
          customText: z.string().max(12000),
        })
        .parse(value),
  );
  const [adding, setAdding] = useState(false),
    [searching, setSearching] = useState(false),
    [error, setError] = useState("");
  const [feedback, setFeedback] = useState<FeedbackMessage | null>(null),
    [failures, setFailures] = useState<
      { name: string; status: "failed" | "uncertain"; message: string }[]
    >([]);
  const mounted = useRef(true),
    addLock = useRef(false),
    searchLock = useRef(false),
    searchSequence = useRef(0),
    keywordRef = useRef(draft.value.keyword);
  keywordRef.current = draft.value.keyword;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      searchSequence.current++;
    };
  }, []);
  const { notify } = useAppActions();
  const plan = tiebaAddPlan(
    draft.value,
    account?.id ?? "",
    account?.uid,
    snapshot.targets,
  );
  const selectedKeys = new Set(plan.forumNames.map(tiebaForumKey));
  const existing = new Map(
    snapshot.targets
      .filter(
        (target) =>
          target.accountId === account?.id && target.uid === account?.uid,
      )
      .map((target) => [tiebaForumKey(target.name), target]),
  );
  const result =
    draft.value.result?.accountId === account?.id ? draft.value.result : null;
  const filtered = tiebaFilterForums(result?.items ?? [], draft.value);
  const disabled = busy || adding;
  const clearFeedback = () => {
    setError("");
    setFeedback(null);
    setFailures([]);
  };
  const toggle = (name: string, checked: boolean) => {
    clearFeedback();
    if (!checked) draft.update(tiebaAddRemaining(draft.value, [name]));
    else if (!selectedKeys.has(tiebaForumKey(name)))
      draft.update({
        selectedNames: [...draft.value.selectedNames, name].slice(0, 5),
      });
  };
  const find = async () => {
    if (searchLock.current || disabled || !account?.uid) return;
    const parsed = tiebaForumKeywordSchema.safeParse(draft.value.keyword);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请填写查找词。");
      return;
    }
    const request = ++searchSequence.current,
      submittedKeyword = draft.value.keyword;
    searchLock.current = true;
    setSearching(true);
    setError("");
    try {
      const found = await ipc("tieba.autocare.findForums", {
        accountId: account.id,
        keyword: parsed.data,
      });
      if (
        !mounted.current ||
        request !== searchSequence.current ||
        keywordRef.current !== submittedKeyword
      )
        return;
      if (found.accountId !== account.id || found.keyword !== parsed.data)
        throw new Error("查找结果与当前账号或关键词不一致，原结果已保留。");
      draft.update({ result: found });
    } catch (cause) {
      if (
        mounted.current &&
        request === searchSequence.current &&
        keywordRef.current === submittedKeyword
      )
        setError(
          tiebaBackendError(
            cause instanceof Error
              ? cause.message
              : "查找未完成，原结果已保留。",
          ),
        );
    } finally {
      searchLock.current = false;
      if (mounted.current) setSearching(false);
    }
  };
  const add = async () => {
    if (
      addLock.current ||
      disabled ||
      !account?.uid ||
      plan.issue ||
      !plan.forumNames.length
    )
      return;
    addLock.current = true;
    setAdding(true);
    clearFeedback();
    const submitted = draft.value;
    try {
      const value = await ipc("tieba.autocare.add", {
        accountId: account.id,
        forumNames: plan.forumNames,
        revision: snapshot.revision,
        confirmed: true,
      });
      receive(value);
      if (!mounted.current) return;
      const outcome = tiebaAdditionResult(
        plan.forumNames,
        account.id,
        value.addition,
      );
      draft.update(tiebaAddRemaining(submitted, outcome.followed));
      setFailures(outcome.remaining);
      const uncertain = outcome.remaining.filter(
          (item) => item.status === "uncertain",
        ).length,
        failed = outcome.remaining.length - uncertain;
      const message: FeedbackMessage = {
        text: `已添加并核实关注${outcome.followed.length}个贴吧${uncertain ? `；${uncertain}个关注结果待核对` : ""}${failed ? `；${failed}个未完成` : ""}。${outcome.remaining.length ? "未完成输入已保留；待核对项再次添加只会核对原关注。" : "尚未选择自动签到或开启发言。"}`,
        tone: outcome.remaining.length
          ? outcome.followed.length || uncertain
            ? "warning"
            : "error"
          : "success",
      };
      setFeedback(message);
      notify(message.text, message.tone);
    } catch (cause) {
      if (mounted.current) {
        setError(
          tiebaBackendError(
            cause instanceof Error
              ? cause.message
              : "添加未完成，输入已保留，请先检查原目标结果。",
          ),
        );
        reload();
      }
    } finally {
      addLock.current = false;
      if (mounted.current) setAdding(false);
    }
  };
  const candidate = (name: string, hint: string) => {
    const key = tiebaForumKey(name),
      target = existing.get(key),
      checked =
        selectedKeys.has(key) ||
        draft.value.selectedNames.some((item) => tiebaForumKey(item) === key);
    return (
      <CheckboxField
        key={key}
        label={`${name}吧${target ? " · 已在列表" : ""}`}
        hint={hint}
        data-testid="tieba-forum-candidate"
        data-forum-name={name}
        checked={checked}
        disabled={
          disabled || !account || (!checked && plan.forumNames.length >= 5)
        }
        onChange={(event) => toggle(name, event.target.checked)}
      />
    );
  };
  return (
    <Dialog
      title="添加贴吧"
      className="tieba-add-dialog"
      onClose={close}
      focus="container"
      footer={
        <>
          <span className="tieba-add-scope">
            本次 {plan.forumNames.length}/5 个；添加会关注，不自动签到或发言。
            {plan.forumNames.length ? (
              <small>已选：{plan.forumNames.join("、")}</small>
            ) : null}
          </span>
          <Button onClick={close}>关闭</Button>
          <Button
            primary
            disabled={
              disabled ||
              searching ||
              !account?.uid ||
              !!plan.issue ||
              !plan.forumNames.length
            }
            onClick={() => void add()}
            data-testid="tieba-add-submit"
          >
            {adding ? "正在添加…" : "添加并关注"}
          </Button>
        </>
      }
    >
      <p className="tieba-add-intro">
        {purpose === "publishing"
          ? "添加的贴吧可用于主题发布目标。"
          : "添加的贴吧可用于帖子回复与主题创作。"}
        查找只读官网；“添加并关注”会在所选账号执行关注，结果不明时仅核对原操作。
      </p>
      {error ? <Notice danger>{error}</Notice> : null}
      {viewError || draft.error ? (
        <Notice warning>{viewError || draft.error}</Notice>
      ) : null}
      {legacy.restored &&
      !draft.value.legacyRecovered &&
      (legacy.value.selectedNames.length || legacy.value.customText.trim()) ? (
        <details className="tieba-add-legacy">
          <summary>发现原添加草稿，可恢复未提交选择</summary>
          <p className="tieba-add-note">
            恢复会替换当前选择，不会直接添加或关注；之后仍需明确点击“添加并关注”。
          </p>
          <Button
            size="compact"
            disabled={disabled}
            onClick={() => {
              draft.update({ ...legacy.value, legacyRecovered: true });
              clearFeedback();
            }}
          >
            恢复原添加草稿
          </Button>
        </details>
      ) : null}
      {feedback ? (
        <Notice
          danger={feedback.tone === "error"}
          warning={feedback.tone === "warning"}
        >
          {feedback.text}
        </Notice>
      ) : null}
      {failures.length ? (
        <ul className="tieba-add-failures">
          {failures.map((item) => (
            <li key={item.name}>
              <strong>
                {item.name}吧 ·{" "}
                {item.status === "uncertain" ? "待核对" : "未完成"}：
              </strong>
              {item.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="tieba-add-top">
        <Field label="贴吧账号">
          <Select
            aria-label="添加贴吧使用账号"
            value={account?.id ?? ""}
            disabled={busy}
            items={[
              { value: "", label: "选择一个贴吧账号" },
              ...snapshot.accounts.map((item) => ({
                value: item.id,
                label: `${item.alias || item.nickname || "贴吧账号"}${!item.uid || tiebaAccountNeedsVerification(item) ? " · 待核验" : ""}`,
              })),
            ]}
            onValueChange={onAccount}
          />
        </Field>
        <Field label="添加方式">
          <Select
            aria-label="贴吧添加方式"
            value={draft.value.mode}
            disabled={disabled}
            items={[
              { value: "find", label: "查找贴吧" },
              { value: "manual", label: "手动添加" },
            ]}
            onValueChange={(mode) =>
              draft.update({ mode: mode as "find" | "manual" })
            }
          />
        </Field>
      </div>
      <div className="tieba-add-selection">
        <span>
          已选择 {plan.forumNames.length}/5 个
          {!plan.forumNames.length ? "；请选择候选或手动输入" : ""}
        </span>
        {plan.forumNames.length ? (
          <Button
            quiet
            size="compact"
            disabled={disabled}
            onClick={() => {
              draft.update({ selectedNames: [], customText: "" });
              clearFeedback();
            }}
          >
            清空选择
          </Button>
        ) : null}
      </div>
      {plan.forumNames.length ? (
        <div className="tieba-add-selected-forums">
          {plan.forumNames.map((name) => (
            <Button
              quiet
              size="compact"
              key={tiebaForumKey(name)}
              disabled={disabled}
              aria-label={`移除已选 ${name}吧`}
              onClick={() => toggle(name, false)}
            >
              {name}吧<X size={13} aria-hidden="true" />
            </Button>
          ))}
        </div>
      ) : null}
      {draft.value.mode === "find" ? (
        <>
          <div className="tieba-add-search">
            <Field label="查找关键词">
              <input
                aria-label="贴吧查找关键词"
                maxLength={80}
                value={draft.value.keyword}
                disabled={disabled || !account}
                placeholder="例如：电子书、学习资料、office"
                onChange={(event) => {
                  searchSequence.current++;
                  draft.update({ keyword: event.target.value });
                  setError("");
                }}
                data-testid="tieba-forum-keyword"
              />
            </Field>
            <Button
              disabled={
                disabled ||
                searching ||
                !account?.uid ||
                !draft.value.keyword.trim()
              }
              onClick={() => void find()}
              data-testid="tieba-forum-find"
            >
              {searching ? "正在查找…" : "查找贴吧"}
            </Button>
          </div>
          {result ? (
            <div className="tieba-add-filters">
              <Field label="关注人数上限">
                <input
                  aria-label="贴吧关注人数上限"
                  inputMode="numeric"
                  maxLength={20}
                  value={draft.value.memberMax}
                  onChange={(event) =>
                    draft.update({ memberMax: event.target.value })
                  }
                  placeholder="不限"
                />
              </Field>
              <Field label="帖子数上限">
                <input
                  aria-label="贴吧帖子数上限"
                  inputMode="numeric"
                  maxLength={20}
                  value={draft.value.postMax}
                  onChange={(event) =>
                    draft.update({ postMax: event.target.value })
                  }
                  placeholder="不限"
                />
              </Field>
              <CheckboxField
                label="仅低回复候选"
                hint="样本≥3，零回复主题至少一半"
                checked={draft.value.lowReplies}
                onChange={(event) =>
                  draft.update({ lowReplies: event.target.checked })
                }
              />
            </div>
          ) : null}
          <p className="tieba-add-note">
            {result
              ? "仅筛选本次已读取候选；设置上限后，未知读数不参与该项筛选。低回复只描述本次首页样本，不代表整个贴吧的活跃度。"
              : "查找后可按本次候选的官网人数、帖子数和首页回复样本筛选。"}
          </p>
          {filtered.issue ? <Notice warning>{filtered.issue}</Notice> : null}
          {result ? (
            <>
              <p className="tieba-add-note">
                上次查找“{result.keyword}” · {tiebaTime(result.checkedAt)} ·{" "}
                {result.message}
                {result.truncated ? "；结果已截断" : ""}
              </p>
              {filtered.items.length ? (
                <div className="tieba-add-results">
                  {filtered.items.map((item) => (
                    <div
                      className="tieba-add-result"
                      key={tiebaForumKey(item.name)}
                    >
                      {candidate(
                        item.name,
                        item.description || "官网未提供简介",
                      )}
                      <div className="tieba-add-result-meta">
                        <span>
                          关注人数{" "}
                          {item.memberCount === null
                            ? "未知"
                            : item.memberCount.toLocaleString("zh-CN")}
                        </span>
                        <span>
                          帖子{" "}
                          {item.postCount === null
                            ? "未知"
                            : item.postCount.toLocaleString("zh-CN")}
                        </span>
                        <span>
                          主题{" "}
                          {item.threadCount === null
                            ? "未知"
                            : item.threadCount.toLocaleString("zh-CN")}
                        </span>
                        <span>
                          {item.sampledThreads
                            ? `首页样本 ${item.sampledThreads} 条，零回复 ${item.zeroReplyThreads} 条`
                            : "首页回复样本未知"}
                        </span>
                        <Status
                          kind={
                            tiebaLowReplyCandidate(item) ? "normal" : "warning"
                          }
                        >
                          {tiebaLowReplyCandidate(item)
                            ? "低回复候选"
                            : item.sampledThreads >= 3
                              ? "未达到低回复条件"
                              : "样本不足"}
                        </Status>
                        {item.latestActiveLabel ? (
                          <span>官网时间 {item.latestActiveLabel}</span>
                        ) : null}
                        {item.message ? <span>{item.message}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty compact title="当前筛选下没有候选">
                  放宽筛选或换一个关键词重新查找；已勾选的贴吧仍保留。
                </Empty>
              )}
            </>
          ) : searching ? (
            <LoadingState label="正在读取官网候选和首页样本…" />
          ) : (
            <p className="tieba-add-note">
              尚未查询官网。可先勾选下方推荐，也可输入关键词后明确查找。
            </p>
          )}
        </>
      ) : (
        <Field
          label="贴吧名称或官方首页链接"
          hint="每行一个；支持 https://tieba.baidu.com/f?kw=吧名，与候选勾选合计最多5个。"
        >
          <textarea
            aria-label="添加贴吧名称或官网链接"
            rows={4}
            maxLength={12000}
            disabled={disabled || !account}
            value={draft.value.customText}
            onChange={(event) => {
              draft.update({ customText: event.target.value });
              clearFeedback();
            }}
            data-testid="tieba-add-input"
          />
        </Field>
      )}
      <fieldset className="tieba-add-presets" disabled={disabled || !account}>
        <legend>
          首批推荐 <small>来自先前资料主题筛选，未承诺当前活跃度</small>
        </legend>
        <div className="tieba-add-preset-heading">
          <p className="tieba-add-note">
            推荐不默认勾选。已选项跨查找和模式切换保留。
          </p>
          <Button
            size="compact"
            quiet
            disabled={disabled || !account || !!draft.value.customText.trim()}
            onClick={() => {
              draft.update({
                selectedNames: tiebaInitialForums.map((item) => item.name),
              });
              clearFeedback();
            }}
          >
            选择这5个推荐
          </Button>
        </div>
        <div className="tieba-add-preset-list">
          {tiebaInitialForums.map((item) => candidate(item.name, item.topic))}
        </div>
      </fieldset>
      {plan.issue ? (
        <Notice warning>
          {plan.issue.replace("最多读取5个", "最多添加5个")}
        </Notice>
      ) : null}
      {plan.existingNames.length ? (
        <p className="tieba-add-note">
          已在当前账号列表：{plan.existingNames.join("、")}
          。本次会核实官网关注；原结果待核对时不重复关注。
        </p>
      ) : null}
    </Dialog>
  );
}
