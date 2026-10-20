import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  baiduKeywordInputSchema,
  type BaiduKeywordResult,
} from "../../../shared/baidu-keywords";
import { ipc } from "../../api/client";
import { useIpcQuery } from "../../api/useIpcQuery";
import { useLocalDraft } from "../../hooks/useLocalDraft";
const draftSchema = z.object({
  accountId: z.string(),
  seeds: z.string(),
  name: z.string(),
  mode: z.enum(["seed", "prompt", "url", "business"]).default("seed"),
  prompt: z.string().default(""),
  url: z.string().default(""),
  businessId: z.string().default(""),
  businessName: z.string().default(""),
  regions: z.array(z.number()).default([]),
  device: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
  sort: z.enum(["averageMonthPv", "recommendPrice"]).default("averageMonthPv"),
  descending: z.boolean().default(true),
  positive: z.string().default(""),
  negative: z.string().default(""),
  minimumMonthly: z.string().default(""),
  reason: z.string().default(""),
  columns: z
    .array(z.string())
    .max(30)
    .default([
      "averageMonthPv",
      "competition",
      "recommendPrice",
      "showReasons",
    ]),
  competition: z.string().default(""),
  combinations: z.boolean().default(false),
  regionExtend: z.boolean().default(false),
  removeDuplicate: z.boolean().default(false),
});
export function useBaiduKeywords(workspace: string) {
  const draft = useLocalDraft(
    `panxu-baidu-keywords-v2:${workspace}`,
    draftSchema.parse({ accountId: "", seeds: "", name: "" }),
    (value) => draftSchema.parse(value),
  );
  const accounts = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
    refreshInterval: 2500,
  });
  const connection = useLocalDraft(
    `panxu-baidu-research-account:${workspace}`,
    { accountId: draft.value.accountId },
    (v) => z.object({ accountId: z.string() }).parse(v),
  );
  const choices = (accounts.data ?? []).filter(
    (a) => a.provider === "baidu-marketing",
  );
  const account =
    choices.find((a) => a.id === connection.value.accountId) ??
    choices.find((a) => a.status === "connected") ??
    choices[0];
  const accountId = account?.id ?? "";
  const latest = useIpcQuery(
    "baiduKeywords.latest",
    { accountId },
    { enabled: !!accountId, revision: account?.uid },
  );
  const [completed, setCompleted] = useState<BaiduKeywordResult | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    currentAccount = useRef(accountId),
    locked = useRef(false);
  currentAccount.current = accountId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const prior =
    completed?.input.accountId === accountId && completed.id !== latest.data?.id
      ? completed
      : (latest.data ??
        (completed?.input.accountId === accountId ? completed : null));
  const result = prior?.accountUid === account?.uid ? prior : null;
  const query = async () => {
    if (locked.current) return null;
    const input = baiduKeywordInputSchema.safeParse({
      ...draft.value,
      accountId,
      business: draft.value.businessId
        ? {
            businessPointId: Number(draft.value.businessId),
            businessPointName: draft.value.businessName,
          }
        : undefined,
      positiveWords: draft.value.positive
        .split(/[,，;；\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      negativeWords: draft.value.negative
        .split(/[,，;；\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      minimumMonthly: draft.value.minimumMonthly
        ? Number(draft.value.minimumMonthly)
        : undefined,
      competitions: draft.value.competition
        ? [Number(draft.value.competition)]
        : [],
      reasons: draft.value.reason
        ? draft.value.reason === "hot"
          ? ["计算机热词", "移动热词", "高频热搜词"]
          : draft.value.reason === "rising"
            ? ["计算机黑马词", "移动黑马词", "黑马词"]
            : [draft.value.reason]
        : [],
      seeds: [
        ...new Set(
          draft.value.seeds
            .split(/[,，;；\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ],
    });
    if (!input.success) {
      setError(input.error.issues[0]?.message ?? "请检查拓词条件。");
      return null;
    }
    locked.current = true;
    setPending(true);
    setError("");
    try {
      const next = await ipc("baiduKeywords.query", input.data);
      if (alive.current && currentAccount.current === accountId)
        setCompleted(next);
      return next;
    } catch (cause) {
      if (alive.current && currentAccount.current === accountId)
        setError(
          cause instanceof Error
            ? cause.message
            : "百度关键词查询未完成，请重试。",
        );
      return null;
    } finally {
      locked.current = false;
      if (alive.current) {
        setPending(false);
        accounts.reload();
      }
    }
  };
  return {
    draft: {
      ...draft,
      error: draft.error || connection.error,
      update: (patch: Partial<typeof draft.value>) => {
        if (patch.accountId !== undefined)
          connection.update({ accountId: patch.accountId });
        draft.update(patch);
      },
    },
    accounts,
    choices,
    account,
    accountId,
    latest,
    result,
    pending,
    error,
    query,
    clearError: () => setError(""),
  };
}
