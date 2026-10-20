/** Update an ordered selection without duplicates; limits belong to the caller. */
export function updateSelection<T extends string | number>(
  current: readonly T[],
  items: readonly T[],
  checked: boolean,
  limit = Infinity,
): T[] {
  if (checked) return [...new Set([...current, ...items])].slice(0, limit);
  const removed = new Set(items);
  return current.filter((id) => !removed.has(id));
}
