import { ipc } from "../api/client";
import { useEffect, useRef, useState } from "react";
import type { Draft } from "../../shared/types";
import {
  studioWorkingCopy,
  editorValueForDraft,
  type StudioEditorValue,
  type StudioWorkingCopy,
} from "../../shared/studio";

const draftEditorValue = editorValueForDraft;
const equal = (a: StudioEditorValue, b: StudioEditorValue) =>
  JSON.stringify(a) === JSON.stringify(b);
const key = (id: string) => `panxu-studio-working-v1:${id}`;
function mirrored(id: string): StudioWorkingCopy | null {
  try {
    const result = studioWorkingCopy.safeParse(
      JSON.parse(localStorage.getItem(key(id)) ?? "null"),
    );
    return result.success && result.data.draftId === id ? result.data : null;
  } catch {
    return null;
  }
}

// Mount the editor with key=draft.id. Review/media updates can refresh the draft
// object without replacing the user's active input.
export function useWorkingCopy(draft: Draft) {
  const [initial] = useState(() => mirrored(draft.id));
  const [value, setValue] = useState(
    () => initial?.value ?? draftEditorValue(draft),
  );
  const [loading, setLoading] = useState(true);
  const [restored, setRestored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState(initial?.editedAt ?? 0);
  const mounted = useRef(false);
  const latest = useRef(initial);
  const writes = useRef(new Set<Promise<unknown>>());

  const persist = (record: StudioWorkingCopy) => {
    latest.current = record;
    let mirrorError = "";
    try {
      localStorage.setItem(key(draft.id), JSON.stringify(record));
    } catch {
      mirrorError = "界面恢复副本写入失败，请完成保存后再关闭窗口。";
    }
    setSaving(true);
    setError(mirrorError);
    const pending = ipc("studio.workingSave", record)
      .then(() => {
        if (mounted.current && latest.current === record) {
          setSaving(false);
          setSavedAt(record.editedAt);
          setError(mirrorError);
        }
      })
      .catch((e: Error) => {
        if (mounted.current && latest.current === record) {
          setSaving(false);
          setError(`数据库暂存失败：${e.message}。请保存修改后再离开。`);
        }
      })
      .finally(() => writes.current.delete(pending));
    writes.current.add(pending);
  };

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void ipc("studio.workingCopy", {
      draftId: draft.id,
    })
      .then((stored) => {
        if (!active) return;
        const local = latest.current;
        const recovered =
          local && (!stored || local.editedAt > stored.editedAt)
            ? local
            : stored;
        if (recovered) {
          latest.current = recovered;
          setValue(recovered.value);
          setSavedAt(recovered.editedAt);
          setRestored(!equal(recovered.value, draftEditorValue(draft)));
          if (
            recovered === local &&
            (!stored || local!.editedAt > stored.editedAt)
          )
            persist(recovered);
        }
      })
      .catch((e: Error) => {
        if (active) setError(`暂存读取失败：${e.message}。请先保留当前内容。`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [draft.id]);

  const clear = async () => {
    await Promise.all(writes.current);
    await ipc("studio.workingClear", { draftId: draft.id });
    localStorage.removeItem(key(draft.id));
    latest.current = null;
    if (mounted.current) {
      setSavedAt(0);
      setRestored(false);
      setError("");
    }
  };
  return {
    value,
    loading,
    restored,
    saving,
    savedAt,
    error,
    dirty: !equal(value, draftEditorValue(draft)),
    update(patch: Partial<StudioEditorValue>) {
      const next = { ...(latest.current?.value ?? value), ...patch };
      setValue(next);
      persist({
        draftId: draft.id,
        editedAt: Math.max(Date.now(), (latest.current?.editedAt ?? 0) + 1),
        value: next,
      });
    },
    clear,
    async reset() {
      await clear();
      setValue(draftEditorValue(draft));
    },
  };
}
