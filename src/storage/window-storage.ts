/** UI drafts share localStorage, with a per-window key. Saved business data stays shared. */
export function windowStorageKey(key: string) {
  const id = typeof window !== "undefined" ? window.panxu?.windowId : undefined;
  return !id || id === "main"
    ? key
    : `panxu-window:${encodeURIComponent(id)}:${key}`;
}

// Resolve native storage lazily so unavailable storage still follows each caller's
// existing recovery path. Do not replace window.localStorage or the shared profile.
export const windowStorage: Storage = {
  getItem: (key) => localStorage.getItem(windowStorageKey(key)),
  setItem: (key, value) => localStorage.setItem(windowStorageKey(key), value),
  removeItem: (key) => localStorage.removeItem(windowStorageKey(key)),
  get length() {
    return this.keys().length;
  },
  key(index: number) {
    return this.keys()[index] ?? null;
  },
  clear() {
    for (const key of this.keys()) this.removeItem(key);
  },
  keys() {
    const prefix = windowStorageKey("");
    return Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.key(i)!,
    )
      .filter((key) =>
        prefix ? key.startsWith(prefix) : !key.startsWith("panxu-window:"),
      )
      .map((key) => key.slice(prefix.length));
  },
} as Storage & { keys(): string[] };
