/** Preserve references for unchanged JSON data returned by desktop snapshots. */
export function structuralShare<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (
    !previous ||
    !next ||
    typeof previous !== "object" ||
    typeof next !== "object"
  )
    return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let equal = Object.keys(before).length === keys.length;
  const result: Record<string, unknown> = Array.isArray(next)
    ? ([] as unknown as Record<string, unknown>)
    : {};
  for (const key of keys) {
    result[key] = structuralShare(before[key], after[key]);
    if (
      !Object.prototype.hasOwnProperty.call(before, key) ||
      result[key] !== before[key]
    )
      equal = false;
  }
  return equal ? previous : (result as T);
}
