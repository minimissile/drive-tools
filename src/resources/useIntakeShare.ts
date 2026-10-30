import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import { intakeDestination } from "./intake-share";
import { providerSpecs } from "../../shared/providers";
import type { Account, Provider, ShareInput } from "../../shared/types";
type Parsed = ReturnType<typeof intakeDestination> & { share: ShareInput };
type ShareValidation = {
  status: "valid" | "invalid" | "unavailable";
  checkedAt: string;
  message: string;
};
export type IntakeShareValidation =
  { status: "checking"; message: string } | ShareValidation;
type ValidationRecord = {
  keys: string[];
  value: IntakeShareValidation;
  completedAt: number;
};
type ShareContext = {
  sourceText: string;
  code: string;
  provider: Provider;
  accountId: string;
  resourceId?: string;
};
const contextKey = (input: ShareContext) =>
  JSON.stringify([
    input.sourceText,
    input.code,
    input.provider,
    input.accountId,
    input.resourceId,
  ]);
export function useIntakeShare(input: {
  sourceText: string;
  code: string;
  provider: Provider;
  accountId: string;
  directory: string;
  resourceId?: string;
  accounts: Account[];
  activeAccounts: Record<string, string>;
  onParsed: (result: Parsed) => void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const version = useRef(0),
    alive = useRef(true),
    pending = useRef<{
      key: string;
      version: number;
      promise: Promise<Parsed | undefined>;
    } | null>(null);
  const [error, setError] = useState(""),
    [parsing, setParsing] = useState(false);
  const [validationRecord, setValidationRecord] =
    useState<ValidationRecord | null>(null);
  const lastValidation = useRef<ValidationRecord | null>(null);
  const validating = useRef<{
    keys: string[];
    version: number;
    promise: Promise<void>;
  } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      version.current++;
    };
  }, []);
  const invalidate = () => {
    version.current++;
    pending.current = null;
    setError("");
    setParsing(false);
    validating.current = null;
    lastValidation.current = null;
    setValidationRecord(null);
  };
  const parse = (): Promise<Parsed | undefined> => {
    const start = latest.current,
      revision = version.current;
    if (!start.sourceText.trim()) return Promise.resolve(undefined);
    const key = JSON.stringify([start.sourceText, start.code]);
    if (pending.current?.key === key && pending.current.version === revision)
      return pending.current.promise;
    setParsing(true);
    setError("");
    const promise = ipc("share.parse", {
      text: start.sourceText,
      code: start.code,
    })
      .then((share) => {
        if (!alive.current || version.current !== revision) return;
        const current = latest.current;
        if (
          current.sourceText !== start.sourceText ||
          current.code !== start.code
        )
          return;
        const result = {
          share,
          ...intakeDestination(
            share,
            current,
            current.accounts,
            current.activeAccounts,
          ),
        };
        current.onParsed(result);
        return result;
      })
      .catch((e) => {
        if (alive.current && version.current === revision)
          setError(
            e instanceof Error ? e.message : "链接识别失败，请检查后重试。",
          );
        return undefined;
      })
      .finally(() => {
        if (alive.current && version.current === revision) {
          setParsing(false);
          pending.current = null;
        }
      });
    pending.current = { key, version: revision, promise };
    return promise;
  };
  const validate = (force = false): Promise<void> => {
    const start = latest.current;
    if (!start.sourceText.trim()) return Promise.resolve();
    const key = contextKey(start),
      revision = version.current;
    if (
      validating.current?.version === revision &&
      validating.current.keys.includes(key)
    )
      return validating.current.promise;
    const cached = lastValidation.current;
    if (
      !force &&
      cached?.keys.includes(key) &&
      Date.now() - cached.completedAt < 60_000
    )
      return Promise.resolve();
    const keys = [key];
    const current = () =>
      alive.current &&
      version.current === revision &&
      keys.includes(contextKey(latest.current));
    const show = (value: IntakeShareValidation) => {
      if (!current()) return;
      const record = {
        keys: [...keys],
        value,
        completedAt: value.status === "checking" ? 0 : Date.now(),
      };
      setValidationRecord(record);
      if (value.status !== "checking") lastValidation.current = record;
    };
    show({ status: "checking", message: "正在检查网盘链接…" });
    const request = { keys, version: revision, promise: Promise.resolve() };
    request.promise = (async () => {
      try {
        const parsed = await parse();
        if (!parsed) {
          if (current()) setValidationRecord(null);
          return;
        }
        // Keep the pasted text; parsing may fill its code and matching drive account.
        keys.push(
          contextKey({
            sourceText: start.sourceText,
            code: parsed.share.code,
            provider: parsed.provider,
            accountId: parsed.accountId,
            resourceId: start.resourceId,
          }),
        );
        if (!current()) return;
        show({ status: "checking", message: "正在检查网盘链接…" });
        if (!parsed.accountId) {
          show({
            status: "unavailable",
            checkedAt: new Date().toISOString(),
            message: `请先添加或选择${providerSpecs[parsed.provider].name}网盘账号，再检查链接。`,
          });
          return;
        }
        // Read the first page through the existing provider flow; never save or transfer.
        const result = await ipc("share.inspect", {
          accountId: parsed.accountId,
          sourceText: parsed.share.url,
          code: parsed.share.code,
          resourceId: start.resourceId,
          parentId: "0",
          page: 1,
        });
        show({
          status: "valid",
          checkedAt: new Date().toISOString(),
          message: result.files.length
            ? "链接有效，可读取分享内容。"
            : "链接有效，分享中暂无文件。",
        });
      } catch (cause) {
        show({
          status:
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "SHARE_EXPIRED"
              ? "invalid"
              : "unavailable",
          checkedAt: new Date().toISOString(),
          message:
            cause instanceof Error
              ? cause.message
              : "暂时无法检查链接，请稍后重试。",
        });
      } finally {
        if (validating.current === request) validating.current = null;
      }
    })();
    validating.current = request;
    return request.promise;
  };
  const validation = validationRecord?.keys.includes(contextKey(input))
    ? validationRecord.value
    : null;
  return { parse, validate, validation, invalidate, error, parsing };
}
