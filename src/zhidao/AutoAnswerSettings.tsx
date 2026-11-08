import type { z } from "zod";
import { useId } from "react";
import type { ZhidaoAccount } from "../../shared/zhidao";
import {
  zhidaoAccountLabel,
  zhidaoAnswerAccountLimit,
} from "../../shared/zhidao";
import { Button, Empty, Field, Status } from "../ui/primitives";
import { ShieldCheck, Shuffle, UserRound } from "lucide-react";
import { Select } from "../ui/Select";
import { answerCategories, answerDraftSchema } from "./answer-draft";

type Draft = z.infer<typeof answerDraftSchema>;
export function AutoAnswerSettings({
  value,
  update,
  accounts,
  busy,
  onCheck,
  onLogin,
  onQuota,
  onAccounts,
  runningAccounts,
}: {
  value: Draft;
  update(patch: Partial<Draft>): void;
  accounts: ZhidaoAccount[] | null;
  busy: boolean;
  onCheck(id: string): void;
  onLogin(id: string): void;
  onQuota(id: string): void;
  onAccounts(): void;
  runningAccounts: Set<string>;
}) {
  const selectedAccounts = (accounts ?? []).filter((a) =>
    value.accountIds.includes(a.id),
  );
  const id = useId();
  const invalidCount =
    !Number.isInteger(value.count) || value.count < 1 || value.count > 200;
  const invalidInterval =
    !Number.isInteger(value.intervalSeconds) ||
    value.intervalSeconds < 18 ||
    value.intervalSeconds > 600;
  return (
    <>
      <div className="answer-section-heading">
        <h3>账号与取题</h3>
        <p>按所选分类随机翻页，跳过历史已答题。</p>
      </div>
      {accounts?.length === 0 ? (
        <Empty
          title="先连接百度知道账号"
          icon={UserRound}
          compact
          action={<Button onClick={onAccounts}>去登录账号</Button>}
        >
          在官方弹窗完成登录并检查身份，即可使用同一会话自动答题。
        </Empty>
      ) : null}
      <Field
        label="回答账号"
        hint={`可多选 · 已选${value.accountIds.length}个账号`}
      >
        <Select
          multiple
          placeholder="选择百度知道账号"
          maxSelected={zhidaoAnswerAccountLimit}
          value={value.accountIds}
          disabled={!accounts || busy}
          onValueChange={(accountIds) =>
            update({ accountIds, accountId: accountIds[0] ?? "" })
          }
          items={[
            ...value.accountIds
              .filter((id) => !accounts?.some((a) => a.id === id))
              .map((id) => ({
                value: id,
                label: accounts
                  ? "原账号已移除，请取消选择"
                  : "已选账号（待读取）",
              })),
            ...(accounts ?? []).map((a) => ({
              value: a.id,
              label: `${zhidaoAccountLabel(a)}${runningAccounts.has(a.id) ? " · 回答中" : a.status === "connected" ? "" : " · 需登录检查"}`,
            })),
          ]}
        />
      </Field>
      <div className="answer-selected-accounts">
        {selectedAccounts.map((account) => (
          <div className="answer-account-state" key={account.id}>
            <div>
              <Status
                kind={account.status === "connected" ? "good" : "warning"}
              >
                {runningAccounts.has(account.id)
                  ? "回答中"
                  : account.status === "connected"
                    ? "已检查登录"
                    : "需要登录检查"}
              </Status>
              <span title={account.nickname || account.alias}>
                {zhidaoAccountLabel(account)}
              </span>
            </div>
            <div className="answer-account-actions">
              <Button
                quiet
                size="compact"
                disabled={busy || runningAccounts.has(account.id)}
                onClick={() => onCheck(account.id)}
              >
                检查登录
              </Button>
              <Button
                quiet
                size="compact"
                disabled={busy || runningAccounts.has(account.id)}
                onClick={() => onLogin(account.id)}
              >
                打开账号窗口
              </Button>
              <Button
                quiet
                size="compact"
                disabled={busy || runningAccounts.has(account.id)}
                onClick={() => onQuota(account.id)}
              >
                查看发布权益
              </Button>
            </div>
            {account.status !== "connected" ? <p>{account.message}</p> : null}
          </div>
        ))}
      </div>
      <div className="answer-quantity-grid">
        <Field label="每个账号回答数">
          <input
            aria-label="每个账号回答数"
            type="number"
            min={1}
            max={200}
            value={value.count === 0 ? "" : value.count}
            aria-invalid={invalidCount || undefined}
            aria-describedby={invalidCount ? `${id}-count` : undefined}
            onChange={(e) => update({ count: Number(e.target.value) })}
          />
          <small className="answer-field-help">1–200条，默认30条</small>
          {invalidCount ? (
            <p className="danger-text" id={`${id}-count`} role="alert">
              请输入1–200之间的整数。
            </p>
          ) : null}
        </Field>
        <Field label="提交间隔（秒）">
          <input
            aria-label="提交间隔（秒）"
            type="number"
            min={18}
            max={600}
            value={value.intervalSeconds === 0 ? "" : value.intervalSeconds}
            aria-invalid={invalidInterval || undefined}
            aria-describedby={invalidInterval ? `${id}-interval` : undefined}
            onChange={(e) =>
              update({ intervalSeconds: Number(e.target.value) })
            }
          />
          <small className="answer-field-help">
            18–600秒，每15条至少休息60秒
          </small>
          {invalidInterval ? (
            <p className="danger-text" id={`${id}-interval`} role="alert">
              请输入18–600之间的整数秒数。
            </p>
          ) : null}
        </Field>
      </div>
      <Field label="答题分类" hint="每次只回答一种类型的问题">
        <Select
          value={value.categories[0] ?? "emotion"}
          disabled={busy}
          onValueChange={(category) =>
            update({ categories: [category as Draft["categories"][number]] })
          }
          items={[...answerCategories]}
        />
      </Field>
      <div className="answer-sampling-note">
        <span>
          <Shuffle size={14} aria-hidden="true" />
          多页采集，打乱抽题
        </span>
        <span>
          <ShieldCheck size={14} aria-hidden="true" />
          历史已答，提交前复核
        </span>
        <p>
          跳过本工作空间历史记录与平台标记已答的题目。答题无需预先开通快捷答题资格。
        </p>
      </div>
    </>
  );
}
