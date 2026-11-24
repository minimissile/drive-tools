import { useEffect, useId, useRef, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleX,
  Copy,
  AppWindow,
  LoaderCircle,
  Search,
  ShieldCheck,
} from "lucide-react";
import { z } from "zod";
import {
  normalizeResourceKeywords,
  parseImportedResourceKeywords,
  parseResourceKeywordSeeds,
  parseResourceKeywordText,
  resourceKeywordLimit,
  resourceKeywordsSchema,
  resourceSeedLimit,
  type KeywordLookup,
  type KeywordSourcesCheck,
} from "../../shared/resource-keywords";
import { ipc } from "../api/client";
import { useKeywordAccount } from "./useKeywordAccount";
import { useAppActions, useAppNavigation } from "../state";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import "./intake-keywords.css";

const seedInputSchema = z.string().max(1000);
export const intakeKeywordDraftSchema = z.union([
  z.object({ seeds: seedInputSchema, text: z.string() }),
  z
    .object({ seeds: seedInputSchema, selected: resourceKeywordsSchema })
    .transform(({ seeds, selected }) => ({ seeds, text: selected.join("\n") })),
]);
export type IntakeKeywordDraft = z.infer<typeof intakeKeywordDraftSchema>;
export const initialIntakeKeywords = (
  words: string[] = [],
): IntakeKeywordDraft => ({
  seeds: "",
  text: words.join("\n"),
});

const sourceLabels = {
  "baidu-marketing": "百度营销",
  baidu: "百度搜索",
  "5118": "5118",
};
const sourceChannels = ["baidu-marketing", "baidu", "5118"] as const;
const statusIcons = {
  ready: CircleCheck,
  idle: CircleHelp,
  checking: LoaderCircle,
  warning: CircleAlert,
  error: CircleX,
  empty: CircleMinus,
};

export function IntakeKeywords({
  title,
  value,
  onChange,
  wordCount,
  locked,
  running,
  onRunningChange,
  lookupLocked = false,
  layout = "stacked",
}: {
  title: string;
  value: IntakeKeywordDraft;
  onChange(value: IntakeKeywordDraft): void;
  wordCount: number;
  locked: boolean;
  running: boolean;
  onRunningChange(running: boolean): void;
  lookupLocked?: boolean;
  layout?: "stacked" | "columns";
}) {
  const active = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (inFlight.current) onRunningChange(false);
    };
  }, [onRunningChange]);
  const helpId = useId();
  const [error, setError] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [result, setResult] = useState<KeywordLookup | null>(null);
  const [sourceCheck, setSourceCheck] = useState<KeywordSourcesCheck | null>(
    null,
  );
  const [checkingSources, setCheckingSources] = useState(false);
  const issues = result?.issues ?? [];
  const noResults = result && !result.candidates.length && !issues.length;
  const { navigate } = useAppNavigation();
  const { notify } = useAppActions();
  const {
    accounts,
    choices,
    account,
    setAccountId,
    accountAvailable,
    checkingAccount,
  } = useKeywordAccount();
  const seeds = parseResourceKeywordSeeds(value.seeds);
  const seedIssue =
    seeds.length > resourceSeedLimit
      ? `一次最多检索 ${resourceSeedLimit} 个搜索词。`
      : normalizeResourceKeywords(seeds).length !== seeds.length
        ? "请输入100字以内的搜索词，链接无法用于检索。"
        : "";
  const marketingIssue = issues.find(
    ({ channel }) => channel === "baidu-marketing",
  );
  const sourceStatuses = sourceChannels.map((channel) => {
    const failures = issues.filter((issue) => issue.channel === channel);
    const checked = sourceCheck?.sources[channel];
    const hasWords = result?.candidates.some(({ sources }) =>
      channel === "baidu"
        ? sources.some((source) =>
            ["suggest", "people", "related"].includes(source),
          )
        : sources.includes(channel),
    );
    let state: keyof typeof statusIcons = "idle";
    let label = "待检查";
    if (checkingSources) {
      state = "checking";
      label = "检查中";
    } else if (channel === "baidu-marketing" && checkingAccount) {
      state = "checking";
      label = "检查中";
    } else if (channel === "baidu-marketing" && accounts.error) {
      state = "error";
      label = "检查失败";
    } else if (channel === "baidu-marketing" && !accountAvailable) {
      state = "warning";
      label = account ? "需登录" : "未接入";
    } else if (checked) {
      state =
        checked.status === "ready"
          ? "ready"
          : checked.status === "login_required"
            ? "warning"
            : "error";
      label = {
        ready: "可用",
        login_required: "需登录",
        unavailable: "暂不可用",
        unconfigured: "未接入",
      }[checked.status];
    } else if (running) {
      state = "checking";
      label = "检索中";
    } else if (lookupError) {
      state = "error";
      label = "检索失败";
    } else if (failures.length) {
      const loginRequired = failures.some(
        ({ code }) => code === "login_required",
      );
      state = hasWords || loginRequired ? "warning" : "error";
      label = hasWords ? "部分可用" : loginRequired ? "需登录" : "暂不可用";
    } else if (result) {
      state = hasWords ? "ready" : "empty";
      label = hasWords ? "可用" : "无结果";
    } else if (channel === "baidu-marketing" && accountAvailable) {
      state = "ready";
      label = "可用";
    }
    const detail = [
      channel === "baidu-marketing" ? account?.alias : "",
      checked?.message,
      ...failures.map(({ message }) => message),
    ]
      .filter(Boolean)
      .join(" · ");
    return { channel, state, label, detail };
  });
  const disabled = running || locked;
  const updateText = (text: string) => onChange({ ...value, text });

  const search = async () => {
    if (
      inFlight.current ||
      disabled ||
      lookupLocked ||
      checkingAccount ||
      !seeds.length ||
      seedIssue
    )
      return;
    inFlight.current = true;
    onRunningChange(true);
    updateText("");
    setError("");
    setLookupError("");
    setResult(null);
    setSourceCheck(null);
    try {
      const result = await ipc("resource.keywordLookup", {
        seeds,
        ...(accountAvailable ? { baiduAccountId: account.id } : {}),
      });
      if (!active.current) return;
      const text = result.candidates.map(({ word }) => word).join("\n");
      updateText(parseResourceKeywordText(text).join("\n"));
      setResult(result);
      if (
        result.issues.some(
          ({ channel, code }) =>
            channel === "baidu-marketing" && code === "login_required",
        )
      )
        accounts.reload();
    } catch (cause) {
      if (active.current)
        setLookupError(
          cause instanceof Error ? cause.message : "检索失败，请重试。",
        );
    } finally {
      inFlight.current = false;
      if (active.current) onRunningChange(false);
    }
  };
  const open5118 = async () => {
    setError("");
    try {
      await ipc("resource.keywordOpen5118");
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "打开网页失败。");
    }
  };
  const checkSources = async () => {
    if (inFlight.current || disabled || lookupLocked || checkingAccount) return;
    inFlight.current = true;
    setCheckingSources(true);
    onRunningChange(true);
    setError("");
    setLookupError("");
    setResult(null);
    setSourceCheck(null);
    try {
      const checked = await ipc("resource.keywordCheckSources", {
        ...(account ? { baiduAccountId: account.id } : {}),
      });
      if (active.current) {
        setSourceCheck(checked);
        accounts.reload();
      }
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error ? cause.message : "来源检查失败，请重试。",
        );
    } finally {
      inFlight.current = false;
      if (active.current) {
        setCheckingSources(false);
        onRunningChange(false);
      }
    }
  };
  const copyTitle = async () => {
    try {
      await ipc("system.copyText", { text: title });
      if (active.current) notify("资源标题已复制", "success");
    } catch (cause) {
      if (active.current)
        notify(
          cause instanceof Error ? cause.message : "复制标题失败。",
          "error",
        );
    }
  };

  return (
    <div className="intake-keywords" data-layout={layout}>
      <Panel
        className="intake-keyword-search"
        title="检索流量词"
        extra={
          <div
            className="intake-keyword-sources"
            role="status"
            aria-live="polite"
            aria-label="检索来源状态"
          >
            {sourceStatuses.map(({ channel, state, label, detail }) => {
              const Icon = statusIcons[state];
              return (
                <span
                  key={channel}
                  className="intake-keyword-source"
                  data-state={state}
                  title={detail || undefined}
                >
                  <Icon
                    size={14}
                    className={state === "checking" ? "spin" : undefined}
                    aria-hidden="true"
                  />
                  {sourceLabels[channel]} · {label}
                </span>
              );
            })}
          </div>
        }
      >
        <div className="intake-keyword-resource">
          <span className="muted">资源标题</span>
          <span className="intake-keyword-resource-title">{title}</span>
          <Button
            size="compact"
            quiet
            aria-label="复制资源标题"
            title="复制资源标题"
            disabled={!title}
            onClick={() => void copyTitle()}
          >
            <Copy size={14} aria-hidden="true" />
          </Button>
        </div>
        <div className="intake-keyword-query">
          <Field
            label="搜索词"
            hint={`一行一个，也支持逗号分隔 · 最多 ${resourceSeedLimit} 个`}
          >
            <textarea
              aria-label="搜索词"
              rows={2}
              maxLength={1000}
              value={value.seeds}
              placeholder="例如：我的完美秘书，手游礼包"
              disabled={disabled || lookupLocked}
              onChange={(e) => onChange({ ...value, seeds: e.target.value })}
            />
          </Field>
          <Button
            primary
            disabled={
              disabled ||
              lookupLocked ||
              checkingAccount ||
              !seeds.length ||
              !!seedIssue
            }
            onClick={() => void search()}
          >
            <Search size={15} aria-hidden="true" />
            {running && !checkingSources ? "正在检索…" : "检索流量词"}
          </Button>
        </div>
        {seedIssue ? <Notice warning>{seedIssue}</Notice> : null}
        <div className="intake-keyword-tools">
          <Button
            size="compact"
            disabled={disabled || lookupLocked || checkingAccount}
            onClick={() => void checkSources()}
          >
            {checkingSources ? (
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} aria-hidden="true" />
            )}
            {checkingSources ? "正在检查来源…" : "检查全部来源"}
          </Button>
          {choices.length > 1 ? (
            <Select
              aria-label="百度营销账号"
              value={account?.id ?? ""}
              onValueChange={(id) => {
                setAccountId(id);
                setSourceCheck(null);
                setResult(
                  (previous) =>
                    previous && {
                      ...previous,
                      issues: previous.issues.filter(
                        ({ channel }) => channel !== "baidu-marketing",
                      ),
                    },
                );
              }}
              disabled={disabled}
              items={choices.map((item) => ({
                value: item.id,
                label: item.alias,
              }))}
            />
          ) : null}
          {choices.length === 1 ? (
            <span className="muted intake-keyword-help">{account?.alias}</span>
          ) : null}
          {!checkingAccount &&
          (!accountAvailable || marketingIssue?.code === "login_required") ? (
            <Button
              size="compact"
              quiet
              onClick={() => navigate("website-accounts")}
            >
              前往账号管理
            </Button>
          ) : null}
          <Button
            size="compact"
            quiet
            disabled={disabled}
            title="在内置浏览器查看或登录5118"
            onClick={() => void open5118()}
          >
            <AppWindow size={13} aria-hidden="true" /> 打开 5118
          </Button>
        </div>
        <QueryError
          error={accounts.error}
          loading={accounts.loading}
          onRetry={accounts.reload}
          title="无法检查百度营销账号"
        />
        {error || lookupError ? (
          <Notice warning>{error || lookupError}</Notice>
        ) : null}
        {issues.some(({ message }) => /安全验证|异常页/.test(message)) ? (
          <div className="intake-keyword-tools">
            <Button
              size="compact"
              disabled={disabled}
              onClick={() => {
                void ipc("baiduDiscovery.open", {}).catch((cause) => {
                  if (active.current)
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "无法打开百度查询窗口。",
                    );
                });
              }}
            >
              查看百度异常页
            </Button>
          </div>
        ) : null}
        {issues.length ? (
          <details className="intake-keyword-issues">
            <summary>查看来源提示（{issues.length} 项）</summary>
            <ul>
              {issues.map((item, i) => (
                <li key={i}>
                  {sourceLabels[item.channel]}
                  {item.seed ? ` · ${item.seed}` : ""}：{item.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Panel>
      <Panel
        className="intake-keyword-candidate"
        title="候选关键词"
        extra={
          <div className="intake-keyword-candidate-meta">
            <span id={helpId} className="muted">
              每行一个，可增删或粘贴
            </span>
            <span className="muted" role="status">
              {wordCount} / {resourceKeywordLimit} 个
            </span>
          </div>
        }
      >
        <textarea
          className="intake-keyword-results"
          aria-label="候选关键词"
          aria-describedby={helpId}
          value={value.text}
          placeholder={
            noResults
              ? "没找到相关词，可以更换搜索词或在这里填写。"
              : "检索结果会出现在这里，也可以直接输入。"
          }
          disabled={disabled}
          onChange={(e) => updateText(e.target.value)}
          onBlur={(e) => {
            const text = parseResourceKeywordText(e.currentTarget.value).join(
              "\n",
            );
            if (text !== value.text) updateText(text);
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text/plain");
            if (!pasted) return;
            const trimmed = pasted
              .split(/\r\n?|\n/)
              .map((line) => line.trim())
              .join("\n")
              .trim();
            const words = trimmed.includes("\t")
              ? parseImportedResourceKeywords(trimmed).join("\n")
              : trimmed;
            if (words === pasted) return;
            e.preventDefault();
            if (!words) return;
            const textarea = e.currentTarget;
            textarea.setRangeText(
              words,
              textarea.selectionStart,
              textarea.selectionEnd,
              "end",
            );
            updateText(textarea.value);
          }}
        />
      </Panel>
    </div>
  );
}
