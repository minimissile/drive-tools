import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import { intakeDestination } from "./intake-share";
import type { Account, Provider, ShareInput } from "../../shared/types";
type Parsed = ReturnType<typeof intakeDestination> & { share: ShareInput };
export function useIntakeShare(input: {
  sourceText: string;
  code: string;
  provider: Provider;
  accountId: string;
  directory: string;
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
  return { parse, invalidate, error, parsing };
}
