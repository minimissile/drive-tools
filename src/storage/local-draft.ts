export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readDraft<T>(
  storage: DraftStorage | undefined,
  key: string,
  parse: (value: unknown) => T,
): T | undefined {
  try {
    const raw = storage?.getItem(key);
    return raw == null ? undefined : parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function writeDraft(
  storage: DraftStorage | undefined,
  key: string,
  value: unknown,
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
