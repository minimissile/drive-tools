/** Development HMR may reload this exact workbench; every other navigation stays blocked. */
export function allowDevelopmentWorkbenchReload(
  development: boolean,
  expected: string,
  current: string,
  target: string,
) {
  if (!development) return false;
  try {
    const entry = new URL(expected);
    if (
      entry.protocol !== "http:" ||
      entry.hostname !== "127.0.0.1" ||
      entry.pathname !== "/" ||
      entry.search ||
      entry.hash ||
      entry.username ||
      entry.password
    )
      return false;
    return (
      new URL(current).href === entry.href &&
      new URL(target).href === entry.href
    );
  } catch {
    return false;
  }
}
