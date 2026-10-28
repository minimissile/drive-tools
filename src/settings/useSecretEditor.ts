import { useEffect, useRef, useState } from "react";
import type {
  SettingsSecretKind,
  SettingsSecretPreview,
} from "../../shared/settings";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";

/** Credentials live only in this mounted form, never in a persisted draft. */
export function useSecretEditor(kind: SettingsSecretKind, configured: boolean) {
  const { command } = useAppActions();
  const query = useIpcQuery(
    "secret.preview",
    { kind },
    {
      revision: configured,
      keepPrevious: true,
    },
  );
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<SettingsSecretPreview>({
    configured,
    masked: "",
  });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const savingRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!query.data) return;
    setPreview(query.data);
  }, [query.data]);
  const update = (next: string) => {
    setValue(next);
  };
  const save = async (next: string) => {
    if (savingRef.current || query.loading) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await command(
        "secret.save",
        { kind, value: next },
        next ? "密钥已加密保存在本机。" : "本地Key已移除。",
      );
      if (!result || !alive.current) return false;
      setValue("");
      setEditing(false);
      setPreview({ configured: !!next.trim(), masked: "" });
      // Only the server-generated redaction is returned to this form.
      query.reload();
      return true;
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  };
  return {
    value,
    update,
    masked: preview.masked,
    configured: preview.configured,
    editing: editing || !preview.configured,
    startEditing: () => {
      setValue("");
      setEditing(true);
    },
    cancelEditing: () => {
      setValue("");
      setEditing(false);
    },
    save,
    dirty: !!value.trim(),
    loading: query.loading,
    saving,
    error: query.error,
    retry: query.reload,
  };
}
